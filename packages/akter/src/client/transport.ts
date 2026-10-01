import { Effect, Option, Schema } from "effect"
import { ActorError, TransportError } from "../errors/actor.ts"
import type { DeclaredError } from "../members/command.ts"
import { actorErrorOf, isDefectBody } from "../protocol/wire.ts"
import type { OfflineStoreError } from "./offline/store.ts"

/** A response as the client reads it: status, headers, and the raw body text. */
export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  /** The local monotonic time its request was sent. */
  readonly sentAt: number
}

/**
 * What a call rejects with: a declared application error, a typed framework
 * failure, or, on a client with an offline store, the store's own failure.
 */
export type Failure = ActorError | OfflineStoreError | DeclaredError["Type"]

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const isEnvelope = Schema.is(Schema.TaggedStruct("ActorError", {}))

/**
 * An HTTP `retry-after` header as milliseconds: delay seconds, or a date
 * measured from the response's `date` less the `elapsed` time since its
 * request was sent, else from `now`.
 */
export const retryAfterHeader = ({
  headers,
  now,
  elapsed = 0,
}: {
  readonly headers: Headers
  readonly now?: number
  readonly elapsed?: number
}): number | undefined => {
  const value = headers.get("retry-after")?.trim()

  if (value === undefined) return undefined

  if (/^\d+$/.test(value)) return Number(value) * 1_000

  const at = Date.parse(value)
  const date = Date.parse(headers.get("date") ?? "")
  const sent = Number.isNaN(date) ? now : date + Math.max(0, elapsed)

  return Number.isNaN(at) || sent === undefined ? undefined : Math.max(0, at - sent)
}

const transportFailure = (reason: TransportError): ActorError => ActorError.make({ reason })

/** A request that got no response, or a body that stopped mid-read; retryable. */
export const networkFailure = () =>
  transportFailure(TransportError.make({ code: "network", retryable: true }))

/** A response or message the client could not decode; not retryable. */
export const undecodableFailure = () =>
  transportFailure(TransportError.make({ code: "decode", retryable: false }))

/** Succeeds once `signal` aborts, at once when it already has; never without a signal. */
export const aborted = (signal: AbortSignal | undefined) =>
  Effect.callback<void>((resume) => {
    if (signal === undefined) return

    if (signal.aborted) return resume(Effect.void)

    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })

    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

/** A status a proxy or gateway may answer before any runner saw the request. */
const isRetryableStatus = (status: number) => status >= 500 || status === 429 || status === 408

const statusError = (reply: Reply) =>
  transportFailure(
    TransportError.make({
      code: "status",
      status: reply.status,
      retryable: isRetryableStatus(reply.status),
    }),
  )

/** Decodes the served body of a failed call; `declared` decodes the member's declared errors. */
export const decodeFailure =
  (declared: ((body: Schema.Json) => Option.Option<Failure>) | undefined) =>
  (reply: Reply): Failure => {
    const body = decodeJson(reply.text)

    if (Option.isNone(body)) return statusError(reply)

    if (isEnvelope(body.value))
      return Option.getOrElse(
        actorErrorOf({
          body: body.value,
          headerRetryAfterMs: retryAfterHeader({ headers: reply.headers }),
        }),
        () => statusError(reply),
      )

    if (isDefectBody(body.value))
      return transportFailure(
        TransportError.make({ code: "defect", status: reply.status, retryable: false }),
      )

    const error = declared?.(body.value) ?? Option.none()

    return Option.isSome(error) ? error.value : statusError(reply)
  }

/** Decodes a 2xx body with `decode`, as undefined when the body is empty. */
export const decodeSuccess =
  <A>(decode: (body: Schema.Json | undefined) => Effect.Effect<A, Schema.SchemaError>) =>
  (reply: Reply): Effect.Effect<A, ActorError> => {
    const undecodable = transportFailure(
      TransportError.make({ code: "decode", status: reply.status, retryable: false }),
    )

    const body = reply.text === "" ? Option.some(undefined) : decodeJson(reply.text)

    if (Option.isNone(body)) return Effect.fail(undecodable)

    return decode(body.value).pipe(Effect.mapError(() => undecodable))
  }
