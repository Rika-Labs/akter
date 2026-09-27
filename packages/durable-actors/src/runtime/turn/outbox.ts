import { Context, Crypto, Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Due, effectKey, type StagedOutbox } from "../../handles/intents.ts"
import { type ActorRef, Caller } from "../../identity/caller.ts"
import { databaseTime } from "./admission.ts"

/**
 * The due-work bucket: the top eight bits of `routing_key`. Every runner's
 * relay probes each bucket's `(bucket, kind, due_at_ms)` index range, so actors
 * with nothing due are never read.
 */
export const bucketOf = (routingKey: bigint) => Number(routingKey >> 56n)

export const BUCKETS = { first: -128, last: 127 } as const

/**
 * Runtime settings a turn needs to write intents: the deployment retry window,
 * which becomes each intent's receipt horizon past its due time, and the
 * relay's wake signal.
 */
export const OutboxRuntime = Context.Reference<{
  readonly retryWindowMs: number
  readonly wake: Effect.Effect<void>
  /** Makes this runner's running attempts check for cancellation now. */
  readonly cancelled: Effect.Effect<void>
}>("durable-actors/OutboxRuntime", {
  defaultValue: () => ({ retryWindowMs: 86_400_000, wake: Effect.void, cancelled: Effect.void }),
})

export const CallerJson = Schema.fromJsonString(Caller)

/**
 * Writes one turn's intents and effects inside its transaction: deletes
 * committed rows whose keys the turn replaced or cancelled, cancels committed
 * effects whose keys it cancelled or performed again, then inserts the staged
 * rows.
 * Returns whether any row is now due, so the caller can wake the relay after
 * commit, and whether it cancelled a running attempt.
 */
export const writeOutbox = Effect.fnUntraced(function* (
  routingKey: bigint,
  sender: ActorRef,
  outbox: StagedOutbox,
) {
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = sender

  const actorRow = sql`routing_key = ${routingKey} AND tenant_id = ${tenant}
    AND actor_type = ${actor} AND actor_id = ${id}`

  if (outbox.replaced.length > 0)
    yield* sql`DELETE FROM actor_outbox WHERE ${actorRow} AND timer_key IN ${sql.in(outbox.replaced)}`

  let dueNow = false
  let cancelledRunning = false

  if (outbox.cancelledEffects.length > 0) {
    const keys = sql.in(outbox.cancelledEffects.map(effectKey))
    const at = yield* databaseTime

    // A never-claimed effect goes. A claim that won the row lock first makes
    // this delete skip it, and the update below, a later statement, then sees
    // it running.
    yield* sql`DELETE FROM actor_outbox WHERE ${actorRow} AND kind = 'effect'
      AND timer_key IN ${keys} AND attempts = 0 AND NOT running`

    // A started effect keeps its row as evidence and gives up its key; one not
    // running now is settled by the next claim, a running one by its attempt
    // or, once its lease ends, by any runner.
    const marked = yield* sql<{ running: boolean }>`UPDATE actor_outbox
      SET cancelled_at_ms = ${at}, timer_key = NULL, waiting = false,
        due_at_ms = CASE WHEN running THEN due_at_ms ELSE least(due_at_ms, ${at}) END
      WHERE ${actorRow} AND kind = 'effect' AND timer_key IN ${keys}
      RETURNING running`

    cancelledRunning = marked.some((row) => row.running)
    dueNow ||= marked.some((row) => !row.running)
  }

  if (outbox.intents.length === 0 && outbox.effects.length === 0)
    return { wake: dueNow, cancelled: cancelledRunning }

  const crypto = yield* Crypto.Crypto
  const { retryWindowMs } = yield* OutboxRuntime
  const now = yield* databaseTime
  const rows = []

  // The row id is the receiver's command id: an intent's, or an effect's
  // route's. Its expiry keeps that receipt at least one retry window past the
  // due time.
  const rowId = (dueAt: number) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => `v1.${now}.${Math.max(dueAt, now) + retryWindowMs}.${uuid}`),
    )

  const dueOf = (due: Due | undefined) =>
    due === undefined
      ? now
      : Due.match(due, {
          After: ({ millis }) => now + millis,
          At: ({ epochMillis }) => epochMillis,
        })

  for (const intent of outbox.intents) {
    const dueAt = dueOf(intent.due)

    dueNow ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowId(dueAt),
      kind: "intent",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
      ready_at_ms: null,
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

  // An effect row names its effect in `command` and targets its own actor,
  // where its routes deliver; the relay runs its executor when it is due.
  for (const effect of outbox.effects) {
    const dueAt = dueOf(effect.due)

    dueNow ||= dueAt <= now

    rows.push({
      routing_key: routingKey,
      intent_id: yield* rowId(dueAt),
      kind: "effect",
      bucket: bucketOf(routingKey),
      due_at_ms: dueAt,
      scheduled_at_ms: dueAt,
      ready_at_ms: dueAt,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      timer_key: effect.key === undefined ? null : effectKey(effect.key),
      target_type: actor,
      target_id: id,
      command: effect.effect,
      payload: effect.payload,
      caller: yield* Schema.encodeEffect(CallerJson)(effect.caller).pipe(Effect.orDie),
    })
  }

  yield* sql`INSERT INTO actor_outbox ${sql.insert(rows)}`

  return { wake: dueNow, cancelled: cancelledRunning }
})
