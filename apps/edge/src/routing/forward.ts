import {
  ActorError,
  ActorUnavailable,
  actorErrorBody,
  ASSERTION_HEADER,
  InvalidInput,
  requestDigest,
  statusOf,
  Unauthorized,
} from "@durable-actors/core"
import { Clock, Effect, Option, Result, Schema, Stream } from "effect"
import {
  type HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpMethod,
} from "effect/unstable/http"
import type { EdgeOptions } from "../config.ts"
import type { Authenticator, Principal } from "../principals/authenticate.ts"
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

const encodeBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

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
 * region.
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

  if (urls.length === 0) return Result.fail(unavailable("No ready runner in the region"))

  return Result.succeed({ region, urls })
})

const bodyOf = (request: Request) =>
  Effect.promise(() => request.arrayBuffer()).pipe(Effect.map((buffer) => new Uint8Array(buffer)))

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
  const target = `${url.pathname}${url.search}`
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
  const chosen = yield* route(edge, deployment, verified)

  if (Result.isFailure(chosen)) return yield* refusal(chosen.failure)
  const routed = chosen.success

  const method = request.method

  if (!HttpMethod.isHttpMethod(method))
    return yield* refusal(InvalidInput.make({ code: "unknown_route" }))

  const body = yield* bodyOf(request)

  if (body.byteLength > edge.options.requestBytes)
    return yield* refusal(InvalidInput.make({ code: "too_large" }))

  const headers: Record<string, string> = {}

  for (const [name, value] of request.headers) if (!DROPPED.has(name)) headers[name] = value

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

    if (assertion === undefined) return yield* refusal(unavailable("No signing key is usable"))

    headers[ASSERTION_HEADER] = assertion
    deadline = claims.exp * 1000
  }

  const contentType = headers["content-type"]

  delete headers["content-type"]

  for (const runner of routed.urls) {
    if ((yield* Clock.currentTimeMillis) >= deadline) break

    const base = HttpClientRequest.make(method)(`${runner}${target}`, { headers })

    const outgoing =
      body.byteLength === 0 ? base : HttpClientRequest.bodyUint8Array(base, body, contentType)

    const response = yield* edge.client.execute(outgoing).pipe(Effect.option)

    if (Option.isSome(response)) return passThrough(response.value)
  }

  return yield* refusal(unavailable("No runner answered"))
})

/** The runner's response, streamed, with hop-by-hop headers removed. */
const passThrough = (response: HttpClientResponse.HttpClientResponse) => {
  const headers = new Headers()

  for (const [name, value] of Object.entries(response.headers))
    if (!DROPPED.has(name)) headers.set(name, value)

  return new Response(Stream.toReadableStream(response.stream), {
    status: response.status,
    headers,
  })
}
