import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { databaseTime } from "../turn/admission.ts"
import { CleanupHooks } from "../turn/hooks.ts"

export interface RetentionPolicy {
  readonly actorType: string
  readonly keepReceiptsMs: number
  readonly keepEventsMs: number
}

export interface Swept {
  readonly receipts: number
  readonly events: number
}

/**
 * Deletes receipts and events past each actor type's horizon, in batches that
 * each commit on their own, so an interrupted sweep leaves only whole batches
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
    // An id expires one retry window after it is issued (a timer's after its
    // due time), so the receipt's age is at least its expiry minus that window.
    const receiptCutoff = now - Math.max(policy.keepReceiptsMs - retryWindowMs, 0)
    const eventCutoff = now - policy.keepEventsMs

    for (;;) {
      const [pruned] = yield* sql<{ count: number }>`
        WITH doomed AS (
          SELECT r.routing_key, r.tenant_id, r.actor_type, r.actor_id, r.command_id
          FROM actor_receipts r
          WHERE r.actor_type = ${policy.actorType} AND r.expires_at_ms <= ${receiptCutoff}
            AND NOT EXISTS (SELECT 1 FROM actor_outbox o WHERE o.intent_id = r.command_id)
          LIMIT ${hooks.batchSize}
          FOR UPDATE SKIP LOCKED),
        gone AS (
          DELETE FROM actor_receipts r USING doomed d
          WHERE r.routing_key = d.routing_key AND r.tenant_id = d.tenant_id
            AND r.actor_type = d.actor_type AND r.actor_id = d.actor_id AND r.command_id = d.command_id
          RETURNING 1)
        SELECT count(*)::integer AS count FROM gone`
      receipts += pruned!.count

      if (pruned!.count === 0) break
      yield* hooks.afterBatch
    }

    for (;;) {
      const [pruned] = yield* sql<{ count: number }>`
        WITH picked AS (
          SELECT routing_key, tenant_id, actor_type, actor_id, sequence FROM actor_events
          WHERE actor_type = ${policy.actorType} AND emitted_at_ms <= ${eventCutoff}
          LIMIT ${hooks.batchSize}),
        upto AS (
          SELECT routing_key, tenant_id, actor_type, actor_id, max(sequence) AS last
          FROM picked GROUP BY routing_key, tenant_id, actor_type, actor_id),
        gone AS (
          DELETE FROM actor_events e USING upto u
          WHERE e.routing_key = u.routing_key AND e.tenant_id = u.tenant_id
            AND e.actor_type = u.actor_type AND e.actor_id = u.actor_id AND e.sequence <= u.last
          RETURNING 1)
        SELECT count(*)::integer AS count FROM gone`
      events += pruned!.count

      if (pruned!.count === 0) break
      yield* hooks.afterBatch
    }
  }

  return { receipts, events } satisfies Swept
})
