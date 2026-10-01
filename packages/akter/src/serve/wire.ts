import { Effect, Option, Schema, SchemaIssue } from "effect"
import { HttpServerResponse } from "effect/http"
import { ActorError, InvalidInput, Unauthorized } from "../errors/actor.ts"
import { actorErrorBody, retryAfterSeconds, statusOf } from "../protocol/wire.ts"

/**
 * The HTTP response an `ActorError` is served as: its status, the JSON body,
 * `retry-after` in whole seconds when the error has a retry delay, and
 * `www-authenticate: Bearer` for credential failures.
 */
export const actorErrorResponse = Effect.fnUntraced(function* (error: ActorError) {
  const retryAfter = error.retryAfter
  const body = yield* actorErrorBody(error)
  const headers: Record<string, string> = {}

  if (Option.isSome(retryAfter)) headers["retry-after"] = retryAfterSeconds(retryAfter.value)

  if (Schema.is(Unauthorized)(error.reason) && error.reason.isCredential)
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

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => LEAF_MESSAGES[issue._tag],
  checkHook: () => "Failed check",
})

/** An `ActorError` wrapping `InvalidInput` with the given code. */
export const invalidInput = (code: InvalidInput["code"]) =>
  ActorError.make({ reason: InvalidInput.make({ code }) })

/**
 * A body, id, or payload that failed its schema. Issues carry a path and a
 * fixed message, so a response never echoes the value that failed.
 */
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
