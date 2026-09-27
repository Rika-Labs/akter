import { Effect } from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { databaseTime } from "../turn/admission.ts"
import { CleanupHooks } from "../turn/hooks.ts"

export interface RetentionPolicy {
  readonly actorType: string
  readonly keepReceiptsMs: number
  readonly keepEventsMs: number
  readonly deliveryMs: number
}

/**
 * How long after its id expires a receipt stays. An id expires one retry
 * window after it is issued (a timer's after its due time), so this keeps
 * receipts `keepReceipts` from issue; equivalently, it retains an expired id
 * for `max(keepReceipts, retryWindow + deliveryTimeout)` after issue, so a
 * command admitted just before expiry can still run and find the receipt of an
 * attempt that committed meanwhile.
 */
export const receiptMarginMs = (horizon: {
  readonly keepReceiptsMs: number
  readonly deliveryMs: number
  readonly retryWindowMs: number
}) => Math.max(horizon.keepReceiptsMs - horizon.retryWindowMs, horizon.deliveryMs)

export interface Swept {
  readonly receipts: number
  readonly events: number
}

/**
 * Deletes receipts and events past each actor type's horizon, in batches that
 * each commit in their own transaction, so an interrupted sweep leaves only whole batches
 * behind and the next sweep continues from there.
 *
 * A receipt goes only once its command id has expired, so external admission
 * already rejects the id without it, and only while no outbox row carries its
 * id, so a redelivered intent or effect route still finds it. A receipt can
 * only gain such a row before it exists, never after.
 *
 * Events go as a prefix: each batch removes, per actor, every event up to the
 * newest one it picked, so a retained event always has every later one after
 * it. `event_sequence` lives on the generation row and is never touched, so
 * no cursor is reissued.
 *
 * The sweep yields after each batch, so a turn waiting for PGlite's one
 * connection runs between batches instead of after the whole sweep.
 */
export const sweep = Effect.fnUntraced(function* (
  policies: Iterable<RetentionPolicy>,
  retryWindowMs: number,
) {
  const sql = yield* SqlClient.SqlClient
  const hooks = yield* CleanupHooks
  let receipts = 0
  let events = 0

  for (const policy of policies) {
    const now = yield* databaseTime
    const receiptCutoff = now - receiptMarginMs({ ...policy, retryWindowMs })
    const eventCutoff = now - policy.keepEventsMs

    // Sweeps of one actor type take turns, so two runners, or a sweep and
    // `ActorTest.cleanup`, never lock overlapping event prefixes in opposite orders.
    const batch = <A>(statement: Effect.Effect<A, SqlError.SqlError>) =>
      sql.withTransaction(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`durable-actors/retention/${policy.actorType}`}))`.pipe(
          Effect.andThen(statement),
        ),
      )

    // Each batch starts at the newest age the last one took, so it never walks
    // the index entries of rows earlier batches deleted and vacuum hasn't removed.
    let from = "0"

    for (;;) {
      const [pruned] = yield* batch(sql<{ count: number; last: string | null }>`
        WITH doomed AS (
          SELECT r.routing_key, r.tenant_id, r.actor_type, r.actor_id, r.command_id, r.expires_at_ms
          FROM actor_receipts r
          WHERE r.actor_type = ${policy.actorType} AND r.expires_at_ms >= ${from}::bigint
            AND r.expires_at_ms <= ${receiptCutoff}
            AND NOT EXISTS (
              SELECT 1 FROM actor_outbox o
              WHERE o.intent_id = r.command_id AND o.tenant_id = r.tenant_id
                AND o.target_type = r.actor_type AND o.target_id = r.actor_id
            )
          ORDER BY r.expires_at_ms
          LIMIT ${hooks.batchSize}
          FOR UPDATE SKIP LOCKED),
        gone AS (
          DELETE FROM actor_receipts r USING doomed d
          WHERE r.routing_key = d.routing_key AND r.tenant_id = d.tenant_id
            AND r.actor_type = d.actor_type AND r.actor_id = d.actor_id AND r.command_id = d.command_id
          RETURNING 1)
        SELECT count(*)::integer AS count, (SELECT max(expires_at_ms)::text FROM doomed) AS last
        FROM gone`)

      receipts += pruned!.count

      if (pruned!.count === 0) break
      from = pruned!.last ?? from
      yield* hooks.afterBatch
      yield* Effect.yieldNow
    }

    from = "0"

    for (;;) {
      const [pruned] = yield* batch(sql<{ count: number; last: string | null }>`
        WITH picked AS (
          SELECT routing_key, tenant_id, actor_type, actor_id, sequence, emitted_at_ms FROM actor_events
          WHERE actor_type = ${policy.actorType} AND emitted_at_ms >= ${from}::bigint
            AND emitted_at_ms <= ${eventCutoff}
          ORDER BY emitted_at_ms
          LIMIT ${hooks.batchSize}),
        upto AS (
          SELECT routing_key, tenant_id, actor_type, actor_id, max(sequence) AS last
          FROM picked GROUP BY routing_key, tenant_id, actor_type, actor_id),
        gone AS (
          DELETE FROM actor_events e USING upto u
          WHERE e.routing_key = u.routing_key AND e.tenant_id = u.tenant_id
            AND e.actor_type = u.actor_type AND e.actor_id = u.actor_id AND e.sequence <= u.last
          RETURNING 1)
        SELECT count(*)::integer AS count, (SELECT max(emitted_at_ms)::text FROM picked) AS last
        FROM gone`)

      events += pruned!.count

      if (pruned!.count === 0) break
      from = pruned!.last ?? from
      yield* hooks.afterBatch
      yield* Effect.yieldNow
    }
  }

  return { receipts, events } satisfies Swept
})
