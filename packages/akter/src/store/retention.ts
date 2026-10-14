import { Duration, Effect, Option, Schema } from "effect"
import { authorizing } from "../runtime/operators/grants.ts"
import type { OperatorGrant } from "../runtime/operators/grants.ts"
import { AuditRecord, auditIdentity, bucketAudit } from "./audit.ts"
import { Condition, retryUnavailable } from "./bucket.ts"
import type { RetriedBucket } from "./bucket.ts"
import { CorruptSegment } from "./errors.ts"
import { RETENTION_KEY } from "./keys.ts"

const DAY = 86_400_000

/** A retention update lost compare-and-swap; retrying is a new operator decision. */
export class RetentionConflict extends Schema.TaggedError<RetentionConflict>()(
  "RetentionConflict",
  { revision: Schema.Int },
) {}

/** Only a store-wide operator capability may change retention, within one to 365 days. */
export class RetentionRefused extends Schema.TaggedError<RetentionRefused>()("RetentionRefused", {
  reason: Schema.Literals(["scope", "range"]),
}) {}

/** A history request names an expired position; recovery may still need its bytes as an anchor. */
export class HistoryExpired extends Schema.TaggedError<HistoryExpired>()("HistoryExpired", {
  shard: Schema.Int,
  offset: Schema.BigInt,
}) {}

/** The audit and effective value become authoritative in the same conditional write. */
export const RetentionRecord = Schema.Struct({
  retentionMillis: Schema.Int.check(Schema.isBetween({ minimum: DAY, maximum: 365 * DAY })),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  audit: AuditRecord,
})
export type RetentionRecord = typeof RetentionRecord.Type

/** An authenticated operator request; application callers never convert to this grant. */
export interface SetRetentionOptions {
  readonly grant: OperatorGrant
  readonly reason: string
}

const codec = Schema.fromJsonString(RetentionRecord)
const encode = (record: RetentionRecord) =>
  Schema.encodeEffect(codec)(record).pipe(
    Effect.map((json) => new TextEncoder().encode(json)),
    Effect.orDie,
  )
const decode = (body: Uint8Array) =>
  Schema.decodeEffect(codec)(new TextDecoder().decode(body)).pipe(
    Effect.mapError((error) => CorruptSegment.make({ key: RETENTION_KEY, reason: error.message })),
  )

/** Never refreshes the condition on retry, so a lost response cannot become a second update. */
export const bucketRetention = ({
  bucket,
  retry,
  initial,
}: RetriedBucket & { readonly initial: number }) => {
  const retrying = retryUnavailable(retry)
  const audits = bucketAudit({ bucket, retry })
  const stored = Effect.gen(function* () {
    const current = yield* retrying(bucket.leases.read(RETENTION_KEY))
    if (Option.isNone(current)) return undefined
    return { record: yield* decode(current.value.body), etag: current.value.etag }
  })
  const retention = Effect.map(stored, (current) => current?.record.retentionMillis ?? initial)
  const retentionAudit = Effect.map(stored, (current) => current?.record.audit)
  const setRetention = (duration: Duration.Input, options: SetRetentionOptions) =>
    Effect.gen(function* () {
      const capability = authorizing({
        grant: options.grant,
        action: "retention.set",
        resource: { tenant: "*" },
      })
      const audit: AuditRecord = {
        ...(yield* auditIdentity),
        operator: options.grant.operator,
        action: "retention.set",
        capability: Option.getOrUndefined(capability),
        target: { tenant: "*" },
        reason: options.reason,
        outcome: "allowed",
      }
      if (Option.isNone(capability)) {
        yield* audits.audit({ ...audit, outcome: "denied" })
        return yield* RetentionRefused.make({ reason: "scope" })
      }
      const millis = yield* Effect.try(() =>
        Duration.toMillis(Duration.fromInputUnsafe(duration)),
      ).pipe(Effect.orElseSucceed(() => Number.NaN))
      if (!Number.isSafeInteger(millis) || millis < DAY || millis > 365 * DAY) {
        yield* audits.audit({ ...audit, outcome: "refused" })
        return yield* RetentionRefused.make({ reason: "range" })
      }
      const current = yield* stored
      if (current !== undefined) yield* audits.audit(current.record.audit)
      const record: RetentionRecord = {
        retentionMillis: millis,
        revision: (current?.record.revision ?? 0) + 1,
        audit,
      }
      const bytes = yield* encode(record)
      const condition =
        current === undefined ? Condition.Absent() : Condition.Matches({ etag: current.etag })
      const applied = yield* retrying(
        Effect.gen(function* () {
          if (Option.isSome(yield* bucket.leases.write(RETENTION_KEY, bytes, condition)))
            return true
          const existing = yield* bucket.leases.read(RETENTION_KEY)
          return Option.exists(
            existing,
            ({ body }) =>
              body.length === bytes.length && body.every((byte, index) => byte === bytes[index]),
          )
        }),
      )
      if (!applied) {
        yield* audits.audit({ ...audit, outcome: "refused" })
        return yield* RetentionConflict.make({ revision: record.revision - 1 })
      }
      return record
    })
  return { retention, retentionAudit, setRetention }
}
