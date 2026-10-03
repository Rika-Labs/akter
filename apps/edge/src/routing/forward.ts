import {
  ActorError,
  ActorUnavailable,
  ASSERTION_HEADER,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  NotCreated,
  requestDigest,
  Unauthorized,
} from "@rikalabs/akter"
import { actorErrorBody, statusOf } from "@rikalabs/akter/runtime"
import { Clock, Effect, Option, Result, Schema, Stream } from "effect"
import {
  type HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpMethod,
} from "effect/http"
import type { EdgeOptions } from "../config.ts"
import type { Authenticator, Principal } from "../principals/authenticate.ts"
import {
  meteringOf,
  type QuotaError,
  type Quotas,
  quotaFailure,
  QuotaUnavailable,
  type Reservation,
  UnsupportedBillingRoute,
} from "../quotas.ts"
import { claimsFor } from "../signing/claims.ts"
import type { KeyRing } from "../signing/keys.ts"
import type { Deployment } from "./hosts.ts"

type Reason = ActorError["reason"]

/** Everything a request needs from the edge's caches and keys. */
export interface Edge {
  readonly options: EdgeOptions
  readonly client: HttpClient.HttpClient
  readonly keys: KeyRing
  readonly authenticator: Authenticator
  readonly resolveHost: (host: string) => Effect.Effect<Deployment | undefined>
  readonly home: (
    deployment: string,
    tenant: string,
  ) => Effect.Effect<{ readonly region: string; readonly state: "active" | "moving" } | undefined>
  readonly ready: (deployment: string, region: string) => Effect.Effect<ReadonlyArray<string>>
  /** Waits for a runner of a region with none ready; empty when none answers ready in time. */
  readonly coldStart: (deployment: string, region: string) => Effect.Effect<ReadonlyArray<string>>
  readonly quotas: Quotas
}

/**
 * Hop-by-hop headers, and credentials a runner must never see: it trusts only
 * the assertion, and hosted runners read no cookie.
 */
const DROPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "content-length",
  "authorization",
  "cookie",
  ASSERTION_HEADER,
])

const utf8 = new TextEncoder()

const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeRejection = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.TaggedStruct("ActorError", {
      reason: Schema.Union([
        InvalidInput,
        Unauthorized,
        InvalidCommandId,
        CommandExpired,
        CommandConflict,
        NotCreated,
      ]),
      isRetryable: Schema.Boolean,
      retryAfter: Schema.optionalKey(Schema.Finite),
    }),
  ),
)

/** The response for a usage admission failure: its status, `retry-after` when a period reset is due, and the envelope body. */
export const quotaRefusal = Effect.fnUntraced(function* (error: QuotaError) {
  const failure = yield* quotaFailure(error)
  const body = yield* encodeBody(failure.body).pipe(Effect.orDie)
  const headers = new Headers({ "content-type": "application/json" })

  if (failure.retryAfterMs !== undefined)
    headers.set("retry-after", String(Math.ceil(failure.retryAfterMs / 1000)))

  return new Response(body, { status: failure.status, headers })
})

/** An `ActorError` response the edge answers itself, in the served wire format. */
export const refusal = Effect.fnUntraced(function* (reason: Reason) {
  const error = ActorError.make({ reason })
  const body = yield* encodeBody(yield* actorErrorBody(error)).pipe(Effect.orDie)
  const headers = new Headers({ "content-type": "application/json" })

  if (Schema.is(Unauthorized)(reason) && reason.code !== "access_denied")
    headers.set("www-authenticate", "Bearer")

  Option.map(error.retryAfter, (ms) => headers.set("retry-after", String(Math.ceil(ms / 1000))))

  return new Response(body, { status: statusOf(reason), headers })
})

/** An `ActorUnavailable` failure with the given reason. */
export const unavailable = (why: string) => ActorUnavailable.make({ cause: new Error(why) })

/**
 * Where a principal's requests go: the ready runners of its tenant's home
 * region. A scale-to-zero deployment with no ready runner there waits for one
 * to start; any other deployment is refused at once.
 *
 * A moving tenant waits; clients retry with the same command ids.
 */
export const route = Effect.fnUntraced(function* (
  edge: Edge,
  deployment: Deployment,
  principal: Principal | undefined,
) {
  const home =
    principal === undefined ? undefined : yield* edge.home(deployment.id, principal.tenant)

  if (home?.state === "moving") return Result.fail(unavailable("The tenant is moving"))

  const region = home?.region ?? deployment.primaryRegion
  const urls = yield* edge.ready(deployment.id, region)

  if (urls.length > 0) return Result.succeed({ region, urls })

  if (!deployment.scaleToZero) return Result.fail(unavailable("No ready runner in the region"))

  const started = yield* edge.coldStart(deployment.id, region)

  if (started.length === 0) return Result.fail(unavailable("No runner started in time"))

  return Result.succeed({ region, urls: started })
})

/**
 * The request body, or none when it is over `limit` bytes. A declared length
 * over the limit is refused before any byte is read, and a streamed body is
 * cancelled as soon as it passes the limit, so no client makes the edge hold
 * more than one limit of body.
 */
const bodyOf = (request: Request | Response, limit: number) =>
  Effect.gen(function* () {
    const body = request.body

    if (Number(request.headers.get("content-length") ?? 0) > limit) return undefined

    if (body === null) return new Uint8Array(0)

    const read = yield* Stream.fromReadableStream({
      evaluate: () => body,
      onError: () => "unreadable" as const,
    }).pipe(
      Stream.runFoldEffect(
        () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
        (acc, chunk) => {
          const size = acc.size + chunk.byteLength

          if (size > limit) return Effect.fail("too_large" as const)
          acc.chunks.push(chunk)

          return Effect.succeed({ size, chunks: acc.chunks })
        },
      ),
      Effect.option,
    )

    if (Option.isNone(read)) return undefined

    const bytes = new Uint8Array(read.value.size)
    let offset = 0

    for (const chunk of read.value.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }

    return bytes
  })

/**
 * Authenticates an HTTP request, signs an assertion bound to it, and forwards
 * it to a ready runner of the tenant's home region. Without a credential it
 * forwards no assertion, and the runner decides whether the route needs one.
 * The assertion is used only for this request's attempts, and only while it
 * lives.
 */
export const forward = Effect.fnUntraced(function* (
  edge: Edge,
  deployment: Deployment,
  request: Request,
) {
  const url = new URL(request.url)

  if (url.searchParams.has(USAGE_PARAM)) url.searchParams.delete(USAGE_PARAM)

  const credential = request.headers.get("authorization")

  const principal =
    credential === null
      ? undefined
      : yield* edge.authenticator
          .authenticate({ deployment: deployment.id, credential })
          .pipe(Effect.result)

  if (principal !== undefined && Result.isFailure(principal))
    return yield* refusal(principal.failure)

  const verified = principal?.success

  const metering = meteringOf({
    method: request.method,
    path: url.pathname,
    idempotencyKey: request.headers.get("idempotency-key"),
    credentialed: credential !== null,
  })

  const chosen = yield* route(edge, deployment, verified)

  if (Result.isFailure(chosen)) return yield* refusal(chosen.failure)
  const routed = chosen.success

  const method = request.method

  if (!HttpMethod.isHttpMethod(method))
    return yield* refusal(InvalidInput.make({ code: "unknown_route" }))

  const body = yield* bodyOf(request, edge.options.requestBytes)

  if (body === undefined) return yield* refusal(InvalidInput.make({ code: "too_large" }))

  if (metering.kind === "unsupported")
    return yield* quotaRefusal(
      UnsupportedBillingRoute.make({ method: request.method, path: url.pathname }),
    )

  const headers: Record<string, string> = {}

  for (const [name, value] of request.headers) if (!DROPPED.has(name)) headers[name] = value

  const tenant = verified?.tenant ?? ANONYMOUS_TENANT

  let reservation: Reservation | undefined

  if (metering.kind === "command" || metering.kind === "read") {
    const reserved = yield* (
      metering.kind === "command"
        ? edge.quotas.reserveCommand({ deployment: deployment.id, tenant, ...metering })
        : edge.quotas.reserveRead({ deployment: deployment.id, tenant, ...metering })
    ).pipe(Effect.result)

    if (Result.isFailure(reserved)) return yield* quotaRefusal(reserved.failure)
    reservation = reserved.success
  }

  if (reservation?.kind === "read") url.searchParams.set(USAGE_PARAM, reservation.usageIdentity)

  const target = `${url.pathname}${url.search}`

  const lifetime = edge.options.assertionLifetime
  let deadline = Number.POSITIVE_INFINITY

  if (verified !== undefined) {
    const commandId = request.headers.get("idempotency-key") ?? undefined

    const req = yield* requestDigest({
      method: request.method,
      target,
      idempotencyKey: commandId,
      body,
    })

    const claims = yield* claimsFor({
      issuer: edge.options.issuer,
      deployment: deployment.id,
      region: routed.region,
      lifetime,
      principal: verified,
      req,
      path: url.pathname,
      commandId,
      session: undefined,
    })

    const assertion = yield* edge.keys.sign(claims)

    if (assertion === undefined) {
      if (reservation !== undefined && !reservation.reused)
        yield* edge.quotas.release(reservation).pipe(Effect.ignore)

      return yield* refusal(unavailable("No signing key is usable"))
    }

    headers[ASSERTION_HEADER] = assertion
    deadline = claims.exp * 1000
  }

  const contentType = headers["content-type"]

  delete headers["content-type"]

  let attempts = 0

  for (const runner of routed.urls) {
    if ((yield* Clock.currentTimeMillis) >= deadline) break

    const base = HttpClientRequest.make(method)(`${runner}${target}`, { headers })

    const outgoing =
      body.byteLength === 0 ? base : HttpClientRequest.bodyUint8Array(base, body, contentType)

    attempts++

    const response = yield* edge.client.execute(outgoing).pipe(Effect.option)

    if (Option.isNone(response)) continue

    const responseType = response.value.headers["content-type"] ?? ""

    if (!responseType.startsWith("text/event-stream")) {
      const proxied = passThrough(response.value)

      if (
        reservation !== undefined &&
        !reservation.reused &&
        attempts === 1 &&
        response.value.status >= 400 &&
        response.value.status < 500 &&
        responseType.startsWith("application/json")
      ) {
        const inspected = yield* bodyOf(proxied.clone(), edge.options.requestBytes).pipe(
          Effect.timeoutOption(edge.options.assertionLifetime),
        )

        if (Option.isSome(inspected) && inspected.value !== undefined) {
          const rejection = decodeRejection(new TextDecoder().decode(inspected.value))

          if (
            Option.isSome(rejection) &&
            statusOf(rejection.value.reason) === response.value.status
          )
            yield* edge.quotas.release(reservation).pipe(Effect.ignore)
        }
      }

      return proxied
    }

    if (
      reservation?.kind === "read" &&
      !reservation.reused &&
      attempts === 1 &&
      !url.pathname.endsWith("/watch")
    )
      yield* edge.quotas.release(reservation).pipe(Effect.ignore)

    const leased = yield* edge.quotas
      .acquireLease({ deployment: deployment.id, tenant, kind: "sse" })
      .pipe(Effect.result)

    if (Result.isSuccess(leased)) {
      const lease = leased.success
      const lostFailure = yield* quotaFailure(QuotaUnavailable.make())
      const lostEnd = utf8.encode(
        `event: end\ndata: ${yield* encodeBody(lostFailure.body).pipe(Effect.orDie)}\n\n`,
      )

      const guarded = response.value.stream.pipe(
        Stream.interruptWhen(lease.lost),
        Stream.concat(
          Stream.unwrap(
            Effect.map(lease.isLost, (lost) => (lost ? Stream.make(lostEnd) : Stream.empty)),
          ),
        ),
        Stream.ensuring(edge.quotas.releaseLease(lease).pipe(Effect.ignore)),
      )

      return passThrough(response.value, guarded)
    }

    yield* Stream.runDrain(Stream.take(response.value.stream, 0)).pipe(Effect.ignore)

    return yield* quotaRefusal(leased.failure)
  }

  if (reservation !== undefined && !reservation.reused && attempts === 0)
    yield* edge.quotas.release(reservation).pipe(Effect.ignore)

  return yield* refusal(unavailable("No runner answered"))
})

/**
 * The query parameter a metered read carries to its runner, whose value is the
 * read's usage identity. The edge removes any client-supplied one and sets it
 * before it signs, so the assertion binds it.
 */
export const USAGE_PARAM = "__akter_usage"

/** The tenant a request without a credential is billed under, as the framework's anonymous tenant. */
export const ANONYMOUS_TENANT = "default"

/** The runner's response with hop-by-hop headers removed, streaming `body`. */
const passThrough = (
  response: HttpClientResponse.HttpClientResponse,
  body: Stream.Stream<Uint8Array, unknown> = response.stream,
) => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(response.headers))
    if (!DROPPED.has(name)) headers.set(name, value)

  return new Response(Stream.toReadableStream(body), {
    status: response.status,
    headers,
  })
}
