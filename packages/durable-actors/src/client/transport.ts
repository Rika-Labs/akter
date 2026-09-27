import { Effect, Option, Schema } from "effect"
import {
  ActorError,
  ActorUnavailable,
  Reason,
  TransportError,
  withRetryAfter,
} from "../errors/actor.ts"
import type { DeclaredError } from "../members/command.ts"

/** A response as the client reads it: status, headers, and the raw body text. */
export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

/** What a call rejects with: a declared application error or a typed framework failure. */
export type Failure = ActorError | DeclaredError["Type"]

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const Envelope = Schema.TaggedStruct("ActorError", {
  reason: Schema.Struct({ _tag: Schema.String }),
  retryAfter: Schema.optionalKey(Schema.Finite),
})

const isEnvelope = Schema.is(Envelope)

const isDefect = Schema.is(Schema.TaggedStruct("Defect", {}))

const isUnavailable = Schema.is(Schema.TaggedStruct("ActorUnavailable", {}))

const decodeReason = Schema.decodeUnknownOption(Schema.toCodecJson(Reason))

/** An HTTP `retry-after` header as milliseconds: delay seconds, or a date measured from the response's `date`, else from `now`. */
export const retryAfterHeader = ({
  headers,
  now,
}: {
  readonly headers: Headers
  readonly now?: number
}): number | undefined => {
  const value = headers.get("retry-after")?.trim()

  if (value === undefined) return undefined

  if (/^\d+$/.test(value)) return Number(value) * 1_000

  const at = Date.parse(value)
  const date = Date.parse(headers.get("date") ?? "")
  const sent = Number.isNaN(date) ? now : date

  return Number.isNaN(at) || sent === undefined ? undefined : Math.max(0, at - sent)
}

export const transport = (reason: TransportError): ActorError => ActorError.make({ reason })

/** A status a proxy or gateway may answer before any runner saw the request. */
const isRetryableStatus = (status: number) => status >= 500 || status === 429 || status === 408

const statusError = (reply: Reply) =>
  transport(
    TransportError.make({
      code: "status",
      status: reply.status,
      retryable: isRetryableStatus(reply.status),
    }),
  )

const framework = (body: typeof Envelope.Type, reply: Reply): ActorError | undefined => {
  const reason = isUnavailable(body.reason)
    ? Option.some(ActorUnavailable.make({ cause: undefined }))
    : decodeReason(body.reason)

  if (Option.isNone(reason)) return undefined

  const error = ActorError.make({ reason: reason.value })
  const retryAfter = body.retryAfter ?? retryAfterHeader({ headers: reply.headers })

  return retryAfter === undefined ? error : withRetryAfter(retryAfter)(error)
}

/** Decodes the served body of a failed call; `declared` decodes the member's declared errors. */
export const decodeFailure =
  (declared: ((body: Schema.Json) => Option.Option<Failure>) | undefined) =>
  (reply: Reply): Failure => {
    const body = decodeJson(reply.text)

    if (Option.isNone(body)) return statusError(reply)

    if (isEnvelope(body.value)) return framework(body.value, reply) ?? statusError(reply)

    if (isDefect(body.value))
      return transport(
        TransportError.make({ code: "defect", status: reply.status, retryable: false }),
      )

    const error = declared?.(body.value) ?? Option.none()

    return Option.isSome(error) ? error.value : statusError(reply)
  }

/** Decodes a 2xx body with `decode`, as undefined when the body is empty. */
export const decodeSuccess =
  <A>(decode: (body: Schema.Json | undefined) => Effect.Effect<A, Schema.SchemaError>) =>
  (reply: Reply): Effect.Effect<A, ActorError> => {
    const undecodable = transport(
      TransportError.make({ code: "decode", status: reply.status, retryable: false }),
    )

    const body = reply.text === "" ? Option.some(undefined) : decodeJson(reply.text)

    if (Option.isNone(body)) return Effect.fail(undecodable)

    return decode(body.value).pipe(Effect.mapError(() => undecodable))
  }
