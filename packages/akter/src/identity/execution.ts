import { Effect, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { InvalidExecutionId, InvalidExecutionKey } from "../errors/workflow.ts"

/** Longest workflow key, in UTF-8 bytes. */
const MAX_KEY_BYTES = 256

/** Longest execution id, in bytes. */
const MAX_EXECUTION_ID_BYTES = 1024

const utf8 = new TextEncoder()

const Parts = Schema.Tuple([
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.NonEmptyString,
])

const PartsJson = Schema.fromJsonString(Parts)

const decodeParts = Schema.decodeResult(PartsJson)

const encodeParts = (parts: typeof Parts.Type) => JSON.stringify(parts)

/** Everything an execution id names: its owner, its workflow member, and its key. */
interface Execution {
  readonly tenant: string
  readonly actor: string
  readonly id: string
  readonly workflow: string
  readonly key: string
}

/** Fails `InvalidExecutionKey` unless `key` is 1 to `MAX_KEY_BYTES` UTF-8 bytes. */
export const checkExecutionKey = (key: string) => {
  const bytes = utf8.encode(key).byteLength

  return bytes === 0 || bytes > MAX_KEY_BYTES
    ? Effect.fail(InvalidExecutionKey.make({ bytes }))
    : Effect.void
}

/**
 * The stable id of one execution: every part that identifies it, so an id
 * routes to its owner without a lookup. The deployment is the database, so
 * it is not encoded. Every other part is bounded by its own schema, so only a
 * key that overflows `MAX_EXECUTION_ID_BYTES` fails `InvalidExecutionKey`.
 */
export const encodeExecutionId = (execution: Execution) =>
  Effect.gen(function* () {
    yield* checkExecutionKey(execution.key)
    const { tenant, actor, id, workflow, key } = execution

    const executionId = `w1.${Base64Url.encode(encodeParts([tenant, actor, id, workflow, key]))}`

    if (utf8.encode(executionId).byteLength > MAX_EXECUTION_ID_BYTES)
      return yield* InvalidExecutionKey.make({ bytes: utf8.encode(key).byteLength })

    return executionId
  })

/**
 * Decodes an execution id; a malformed or non-`w1.` id fails
 * `InvalidExecutionId`. Only the canonical encoding is an id, so two strings
 * never name one execution.
 */
export const decodeExecutionId = (executionId: string) =>
  Effect.gen(function* () {
    const invalid = InvalidExecutionId.make({ executionId })

    if (
      !executionId.startsWith("w1.") ||
      utf8.encode(executionId).byteLength > MAX_EXECUTION_ID_BYTES
    )
      return yield* invalid

    const json = Base64Url.decodeString(executionId.slice(3))

    if (Result.isFailure(json)) return yield* invalid

    const parts = decodeParts(json.success)

    if (Result.isFailure(parts)) return yield* invalid

    const [tenant, actor, id, workflow, key] = parts.success

    if (utf8.encode(key).byteLength > MAX_KEY_BYTES) return yield* invalid

    const canonical = `w1.${Base64Url.encode(encodeParts(parts.success))}`

    if (canonical !== executionId) return yield* invalid

    return { tenant, actor, id, workflow, key } satisfies Execution
  })
