import { Context, Crypto, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Due, type StagedOutbox } from "../../handles/intents.ts"
import { type ActorRef, Caller } from "../../identity/caller.ts"
import { databaseTime } from "./admission.ts"

/**
 * The due-work bucket: the top eight bits of `routing_key`. A runner owns a
 * contiguous bucket range and probes each bucket's `(bucket, due_at_ms)` index
 * range, so actors with nothing due are never read.
 */
export const bucketOf = (routingKey: bigint) => Number(routingKey >> 56n)

export const BUCKETS = { first: -128, last: 127 } as const

/** Shifts the outbox's view of the database clock; only `ActorTest.advance` moves it. */
export const OutboxClock = Context.Reference<{ readonly offsetMillis: () => number }>(
  "durable-actors/OutboxClock",
  { defaultValue: () => ({ offsetMillis: () => 0 }) },
)

export const outboxTime = Effect.gen(function* () {
  const clock = yield* OutboxClock

  return (yield* databaseTime) + clock.offsetMillis()
})

/**
 * Runtime settings a turn needs to write intents: the deployment retry window,
 * which becomes each intent's receipt horizon past its due time, and the
 * relay's wake signal.
 */
export const OutboxRuntime = Context.Reference<{
  readonly retryWindowMs: number
  readonly wake: Effect.Effect<void>
}>("durable-actors/OutboxRuntime", {
  defaultValue: () => ({ retryWindowMs: 86_400_000, wake: Effect.void }),
})

export const CallerJson = Schema.fromJsonString(Caller)

/**
 * Writes one turn's intents inside its transaction: deletes committed rows
 * whose keys the turn replaced or cancelled, then inserts the staged rows.
 * Returns whether any inserted row is already due, so the caller can wake the
 * relay after commit.
 */
export const writeOutbox = Effect.fnUntraced(function* (
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
) {
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = sender

  if (outbox.replaced.length > 0)
    yield* sql`DELETE FROM actor_outbox WHERE routing_key = ${routingKey} AND tenant_id = ${tenant}
      AND actor_type = ${actor} AND actor_id = ${id} AND timer_key IN ${sql.in(outbox.replaced)}`

  if (outbox.intents.length === 0) return false

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* outboxTime
  let dueNow = false
  const rows = []

  for (const intent of outbox.intents) {
    const dueAt =
      intent.due === undefined
        ? now
        : Due.match(intent.due, {
            After: ({ millis }) => now + millis,
            At: ({ epochMillis }) => epochMillis,
          })

    dueNow ||= dueAt <= now
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

    rows.push({
      routing_key: routingKey,
      // The intent id is the receiver's command id. Its expiry keeps the
      // receiver's receipt at least one retry window past the due time.
      intent_id: `v1.${now}.${Math.max(dueAt, now) + retryWindowMs}.${uuid}`,
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      timer_key: intent.key ?? null,
      target_type: intent.target.actor,
      target_id: intent.target.id,
      command: intent.command,
      payload: intent.payload,
      caller: yield* Schema.encodeEffect(CallerJson)(intent.caller).pipe(Effect.orDie),
    })
  }

  yield* sql`INSERT INTO actor_outbox ${sql.insert(rows)}`

  return dueNow
})
