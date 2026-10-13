import { Clock, DateTime, Effect, Option, Random, Schema } from "effect"
import { Capability, OperatorAction } from "../runtime/operators/grants.ts"
import type { RetriedBucket } from "./bucket.ts"
import { retryUnavailable } from "./bucket.ts"
import { StorageUnavailable } from "./errors.ts"

/** Metadata only: operator audit records carry no credential, caller, state or payload value. */
export const AuditRecord = Schema.Struct({
  id: Schema.String,
  at: Schema.Finite,
  operator: Schema.String,
  action: OperatorAction,
  capability: Schema.optional(Capability),
  target: Schema.Struct({
    tenant: Schema.String,
    shard: Schema.optionalKey(Schema.Int),
    actorType: Schema.optionalKey(Schema.String),
    actorId: Schema.optionalKey(Schema.String),
    commandId: Schema.optionalKey(Schema.String),
  }),
  reason: Schema.String,
  outcome: Schema.Literals(["allowed", "denied", "refused"]),
  replay: Schema.optionalKey(Schema.Literals(["matching", "current"])),
})
export type AuditRecord = typeof AuditRecord.Type

const codec = Schema.fromJsonString(AuditRecord)
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Operator read records use create-once objects; a lost response is resolved against the same bytes. */
export const bucketAudit = ({ bucket, retry }: RetriedBucket) => {
  const retrying = retryUnavailable(retry)
  return {
    audit: (record: AuditRecord) =>
      Effect.gen(function* () {
        const text = yield* Schema.encodeEffect(codec)(record).pipe(Effect.orDie)
        const date = DateTime.formatIso(DateTime.makeUnsafe(record.at)).slice(0, 10)
        const key = `audit/${date}/${record.id}`
        yield* retrying(
          Effect.gen(function* () {
            if (yield* bucket.create(key, encoder.encode(text))) return
            const existing = yield* bucket.get(key)
            if (Option.isSome(existing) && decoder.decode(existing.value) === text) return
            return yield* StorageUnavailable.make({
              operation: "create",
              key,
              status: undefined,
              reason: "audit id collision",
            })
          }),
        )
      }),
    audits: Effect.gen(function* () {
      const records: Array<AuditRecord> = []
      for (const key of yield* retrying(bucket.list("audit/"))) {
        const bytes = yield* retrying(bucket.get(key))
        if (Option.isNone(bytes))
          return yield* StorageUnavailable.make({
            operation: "get",
            key,
            status: undefined,
            reason: "audit record disappeared",
          })
        records.push(
          yield* Schema.decodeEffect(codec)(decoder.decode(bytes.value)).pipe(Effect.orDie),
        )
      }
      return records
    }),
  }
}

/** Fresh record ids and times are generated outside application actions. */
export const auditIdentity = Effect.all({
  id: Effect.map(
    Effect.forEach([0, 1, 2, 3], () => Random.nextIntBetween(0, 0x1_0000_0000)),
    (words) => words.map((word) => word.toString(16).padStart(8, "0")).join(""),
  ),
  at: Clock.currentTimeMillis,
})
