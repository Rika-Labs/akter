import { Effect, Match, Option, Schema, SchemaIssue } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import {
  ActorError,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  type Reason,
  Timeout,
  Unauthorized,
} from "../errors/actor.ts"

/** The served protocol's major version. */
export const PROTOCOL = 1

const reasonSchemas = {
  CommandConflict: Schema.TaggedStruct("CommandConflict", CommandConflict.fields),
  CommandExpired: Schema.TaggedStruct("CommandExpired", CommandExpired.fields),
  InvalidCommandId: Schema.TaggedStruct("InvalidCommandId", InvalidCommandId.fields),
  Unauthorized: Schema.TaggedStruct("Unauthorized", Unauthorized.fields),
  // `cause` holds internal errors and never crosses the wire.
  ActorUnavailable: Schema.TaggedStruct("ActorUnavailable", {}),
  Timeout: Schema.TaggedStruct("Timeout", Timeout.fields),
  NotCreated: Schema.TaggedStruct("NotCreated", {}),
  MailboxFull: Schema.TaggedStruct("MailboxFull", {}),
  RunnerAtCapacity: Schema.TaggedStruct("RunnerAtCapacity", {}),
  InvalidInput: Schema.TaggedStruct("InvalidInput", InvalidInput.fields),
} as const

export type WireTag = keyof typeof reasonSchemas

/** An `ActorError` as a served response carries it: public reason fields plus the computed getters. */
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

export const Defect = Schema.TaggedStruct("Defect", { traceId: Schema.String }).annotate({
  identifier: "Defect",
})

const CREDENTIAL_CODES: ReadonlySet<Unauthorized["code"]> = new Set([
  "missing_credentials",
  "invalid_credentials",
  "expired",
])

const inputStatus = (code: InvalidInput["code"]) => {
  switch (code) {
    case "unknown_route":
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

export const statusOf = (reason: Reason): number =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      CommandConflict: () => 409,
      CommandExpired: () => 410,
      InvalidCommandId: () => 400,
      Unauthorized: (unauthorized) => (CREDENTIAL_CODES.has(unauthorized.code) ? 401 : 403),
      ActorUnavailable: () => 503,
      RunnerAtCapacity: () => 503,
      Timeout: () => 504,
      NotCreated: () => 404,
      MailboxFull: () => 429,
      InvalidInput: (input) => inputStatus(input.code),
      TransportError: () => 502,
      // Only connection sessions end this way; no served command or query returns it.
      SessionEnded: () => 410,
    }),
  )

const ActorErrorBody = Schema.TaggedStruct("ActorError", {
  reason: Schema.Json,
  isRetryable: Schema.Boolean,
  retryAfter: Schema.optionalKey(Schema.Finite),
})

/** The JSON body an `ActorError` is served as. */
export const actorErrorBody = Effect.fnUntraced(function* (error: ActorError) {
  const reason = yield* encodeReason(error.reason).pipe(Effect.orDie)

  return Option.match(error.retryAfter, {
    onNone: () => ActorErrorBody.make({ reason, isRetryable: error.isRetryable }),
    onSome: (retryAfter) =>
      ActorErrorBody.make({ reason, isRetryable: error.isRetryable, retryAfter }),
  })
})

export const actorErrorResponse = Effect.fnUntraced(function* (error: ActorError) {
  const retryAfter = error.retryAfter
  const body = yield* actorErrorBody(error)
  const headers: Record<string, string> = {}

  if (Option.isSome(retryAfter)) headers["retry-after"] = String(Math.ceil(retryAfter.value / 1000))

  if (Schema.is(Unauthorized)(error.reason) && CREDENTIAL_CODES.has(error.reason.code))
    headers["www-authenticate"] = "Bearer"

  return HttpServerResponse.jsonUnsafe(body, { status: statusOf(error.reason), headers })
})

const LEAF_MESSAGES: Record<SchemaIssue.Leaf["_tag"], string> = {
  InvalidType: "Invalid type",
  InvalidValue: "Invalid value",
  MissingKey: "Missing key",
  UnexpectedKey: "Unexpected key",
  Forbidden: "Forbidden operation",
  OneOf: "Expected exactly one member to match",
}

// Fixed messages, so a response never echoes the value that failed.
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => LEAF_MESSAGES[issue._tag],
  checkHook: () => "Failed check",
})

export const invalidInput = (code: InvalidInput["code"]) =>
  ActorError.make({ reason: InvalidInput.make({ code }) })

/** A body, id, or payload that failed its schema, with value-free issues. */
export const undecodable = (error: Schema.SchemaError) =>
  ActorError.make({
    reason: InvalidInput.make({
      code: "decode",
      issues: formatIssues(error.issue).issues.map((issue) => ({
        path: (issue.path ?? [])
          .map((segment) =>
            String(
              Schema.is(Schema.Struct({ key: Schema.PropertyKey }))(segment)
                ? segment.key
                : segment,
            ),
          )
          .join("."),
        message: issue.message,
      })),
    }),
  })
