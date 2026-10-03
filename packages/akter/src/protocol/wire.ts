import { Effect, Match, Option, Schema } from "effect"
import {
  ActorError,
  ActorUnavailable,
  CommandConflict,
  CommandExpired,
  ConnectionLimitExceeded,
  InvalidCommandId,
  InvalidInput,
  Reason,
  QuotaExceeded,
  SessionEnded,
  SpendLimitExceeded,
  Timeout,
  Unauthorized,
  withRetryAfter,
} from "../errors/actor.ts"

/** The served protocol's major version, sent and checked as `durable-protocol`. */
export const PROTOCOL = 1

const reasonSchemas = {
  CommandConflict: Schema.TaggedStruct("CommandConflict", CommandConflict.fields),
  CommandExpired: Schema.TaggedStruct("CommandExpired", CommandExpired.fields),
  InvalidCommandId: Schema.TaggedStruct("InvalidCommandId", {
    commandId: InvalidCommandId.fields.commandId,
    code: InvalidCommandId.fields.code,
  }),
  Unauthorized: Schema.TaggedStruct("Unauthorized", Unauthorized.fields),
  ActorUnavailable: Schema.TaggedStruct("ActorUnavailable", {}),
  Timeout: Schema.TaggedStruct("Timeout", Timeout.fields),
  NotCreated: Schema.TaggedStruct("NotCreated", {}),
  MailboxFull: Schema.TaggedStruct("MailboxFull", {}),
  RunnerAtCapacity: Schema.TaggedStruct("RunnerAtCapacity", {}),
  QuotaExceeded: Schema.TaggedStruct("QuotaExceeded", QuotaExceeded.fields),
  SpendLimitExceeded: Schema.TaggedStruct("SpendLimitExceeded", SpendLimitExceeded.fields),
  ConnectionLimitExceeded: Schema.TaggedStruct(
    "ConnectionLimitExceeded",
    ConnectionLimitExceeded.fields,
  ),
  InvalidInput: Schema.TaggedStruct("InvalidInput", InvalidInput.fields),
  SessionEnded: Schema.TaggedStruct("SessionEnded", SessionEnded.fields),
} as const

/** The tag of a reason a served route can answer; `TransportError` is only ever a client's. */
export type WireTag = keyof typeof reasonSchemas

/**
 * An `ActorError` as a served response carries it: public reason fields plus
 * the computed getters. `ActorUnavailable` carries no fields because its
 * `cause` holds internal errors and never crosses the wire.
 */
export const envelope = (route: {
  readonly tags: ReadonlyArray<WireTag>
  readonly identifier: string
}) =>
  Schema.TaggedStruct("ActorError", {
    reason: Schema.Union(route.tags.map((tag) => reasonSchemas[tag])),
    isRetryable: Schema.Boolean,
    retryAfter: Schema.optionalKey(Schema.Finite),
  }).annotate({ identifier: route.identifier })

const WireReason = Schema.Union(Object.values(reasonSchemas))

const encodeReason = Schema.encodeUnknownEffect(Schema.toCodecJson(WireReason))

/** The body of a `500`: a defect reported by trace id only, never its message. */
export const Defect = Schema.TaggedStruct("Defect", { traceId: Schema.String }).annotate({
  identifier: "Defect",
})

const inputStatus = (code: InvalidInput["code"]) => {
  switch (code) {
    case "unknown_route":
    case "unknown_event":
    case "unknown_content":
      return 404
    case "too_large":
      return 413
    case "unsupported_media_type":
      return 415
    case "origin_not_allowed":
      return 403
    default:
      return 400
  }
}

/**
 * The HTTP status a reason is served with. `SessionEnded` maps to `410` but
 * only connection sessions end this way; no served command or query returns it.
 */
export const statusOf = (reason: Reason): number =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      CommandConflict: () => 409,
      CommandExpired: () => 410,
      InvalidCommandId: () => 400,
      Unauthorized: (unauthorized) => (unauthorized.isCredential ? 401 : 403),
      ActorUnavailable: () => 503,
      RunnerAtCapacity: () => 503,
      QuotaExceeded: () => 429,
      SpendLimitExceeded: () => 402,
      ConnectionLimitExceeded: () => 429,
      Timeout: () => 504,
      NotCreated: () => 404,
      MailboxFull: () => 429,
      InvalidInput: (input) => inputStatus(input.code),
      TransportError: () => 502,
      SessionEnded: () => 410,
    }),
  )

/** The close code a WebSocket session ends with; the `end` message before it is authoritative. */
export const closeCodeOf = (reason: Reason): number =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      ActorUnavailable: () => 1013,
      RunnerAtCapacity: () => 1013,
      QuotaExceeded: () => 1008,
      SpendLimitExceeded: () => 1008,
      ConnectionLimitExceeded: () => 1008,
      NotCreated: () => 4404,
      Unauthorized: (unauthorized) =>
        unauthorized.code === "reauthorization_unavailable" ? 1013 : 1008,
      InvalidInput: () => 4400,
      SessionEnded: (session) => {
        switch (session.cause) {
          case "ClientClosed":
          case "ServerClosed":
          case "Terminated":
            return 1000
          case "HolderShutdown":
            return 1012
          case "Defect":
            return 1011
          default:
            return 1013
        }
      },
      CommandConflict: () => 1011,
      CommandExpired: () => 1011,
      InvalidCommandId: () => 1011,
      Timeout: () => 1011,
      MailboxFull: () => 1011,
      TransportError: () => 1011,
    }),
  )

const ActorErrorBody = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
  retryAfter: Schema.optionalKey(Schema.Finite),
})

/** The JSON body an `ActorError` is served as, in HTTP bodies and in a session's `end`. */
export const actorErrorBody = Effect.fnUntraced(function* (error: ActorError) {
  const reason = yield* encodeReason(error.reason).pipe(Effect.orDie)

  return Option.match(error.retryAfter, {
    onNone: () => ActorErrorBody.make({ reason, isRetryable: error.isRetryable }),
    onSome: (retryAfter) =>
      ActorErrorBody.make({ reason, isRetryable: error.isRetryable, retryAfter }),
  })
})

/** The `retry-after` header of a delay: whole seconds, rounded up. */
export const retryAfterSeconds = (retryAfterMs: number) => String(Math.ceil(retryAfterMs / 1000))

const Envelope = Schema.TaggedStruct("ActorError", {
  reason: Schema.Struct({ _tag: Schema.String }),
  retryAfter: Schema.optionalKey(Schema.Finite),
})

const isEnvelope = Schema.is(Envelope)

const decodeReason = Schema.decodeUnknownOption(Schema.toCodecJson(Reason))

const isUnavailable = Schema.is(reasonSchemas.ActorUnavailable)

/**
 * The `ActorError` a served body carries, or none for any other body. A
 * reason this client doesn't know is none too, never a guess. The body's
 * `retryAfter` is the server's already-jittered delay; `headerRetryAfterMs`,
 * read from `retry-after`, stands in when the body has none.
 */
export const actorErrorOf = ({
  body,
  headerRetryAfterMs,
}: {
  readonly body: Schema.Json
  readonly headerRetryAfterMs: number | undefined
}): Option.Option<ActorError> =>
  Option.flatMap(Option.liftPredicate(body, isEnvelope), (envelope) => {
    const reason = isUnavailable(envelope.reason)
      ? Option.some(ActorUnavailable.make({ cause: undefined }))
      : decodeReason(envelope.reason)

    return Option.map(reason, (value) => {
      const error = ActorError.make({ reason: value })
      const retryAfter = envelope.retryAfter ?? headerRetryAfterMs

      return retryAfter === undefined ? error : withRetryAfter(retryAfter)(error)
    })
  })

/** Whether a served body is the opaque `Defect` of a `500`. */
export const isDefectBody = Schema.is(Defect)
