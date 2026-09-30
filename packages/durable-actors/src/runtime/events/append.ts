import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EmittedEvent } from "../registration.ts"
import type { Request } from "../request.ts"
import { System } from "../../identity/caller.ts"
import { FrameworkClock } from "../turn/admission.ts"
import { bucketOf, CallerJson, OutboxRuntime, textArray } from "../turn/outbox.ts"
import { compress } from "../storage/codec.ts"
import { notifyWaits } from "../workflows/engine.ts"

/** The outbox key of an actor's feed row, which tells the relay to expand its subscriptions. */
export const FEED_KEY = "$feed"

/**
 * The statement that appends a turn's events inside its transaction, and the
 * stamp it records once it replies. The caller already holds the actor's
 * generation row lock, so reserving the next sequence numbers there gives one
 * gap-free order per actor even when activations race; the counter lives on
 * the generation row so pruning never lets a sequence be reused. The
 * reservation and the insert share a statement, so nothing waits on the
 * reserved numbers.
 *
 * The same statement probes the actor's subscription tag summary by key and,
 * when some subscription follows an emitted class, upserts the actor's one
 * feed row, due now. So the turn costs the same with no subscribers or ten
 * thousand, and the relay fans the events out after commit; the stamp's `fed`
 * says the relay should wake. The upsert resets `attempts`, so a relay
 * expanding the feed while this commits keeps it due. Routed subscriptions
 * registered here that name an emitted class get their missing source-side
 * rows first, starting at this turn's first event. Those rows are widened,
 * never narrowed, so an older runner cannot shrink one back; each inserted row
 * and each added tag enters the tag summary.
 */
export const eventsStatement = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
) {
  const sql = yield* SqlClient.SqlClient
  const clock = yield* FrameworkClock
  const outbox = yield* OutboxRuntime
  const { tenant, actor, id } = request.ref
  const stamp = { emittedAtMs: 0, fed: false }
  const emitted = [...new Set(events.map((event) => event.tag))]

  const routed = outbox
    .routed(actor)
    .filter((sub) => sub.events.some((tag) => emitted.includes(tag)))

  const values = sql.csv(
    events.map(
      (event, index) =>
        sql`(${index + 1}::bigint, ${event.tag}::text, ${compress(event.value)}::bytea, ${event.version}::int)`,
    ),
  )

  const source = (alias: string) =>
    sql`${sql(alias)}.routing_key = ${routingKey} AND ${sql(alias)}.tenant_id = ${tenant}
      AND ${sql(alias)}.source_type = ${actor} AND ${sql(alias)}.source_id = ${id}`

  const caller = yield* Schema.encodeEffect(CallerJson)(
    System.make({ source: "actor", ref: request.ref }),
  ).pipe(Effect.orDie)

  const routedRows =
    routed.length === 0
      ? sql.literal("")
      : sql`, routed_want (subscriber_type, subscription, events) AS (
            VALUES ${sql.csv(
              routed.map(
                (sub) =>
                  sql`(${sub.subscriberType}::text, ${sub.tag}::text, ${textArray({ sql, values: sub.events })})`,
              ),
            )}),
          routed_old AS (
            SELECT s.subscriber_type, s.subscription, s.events FROM actor_subscriptions s
            JOIN routed_want w USING (subscriber_type, subscription)
            WHERE ${source("s")} AND s.subscriber_id = ''),
          routed_new AS (
            INSERT INTO actor_subscriptions (routing_key, tenant_id, source_type, source_id,
              subscriber_type, subscription, subscriber_id, events, epoch, active, delivered, bucket)
            SELECT ${routingKey}, ${tenant}, ${actor}, ${id}, w.subscriber_type, w.subscription, '',
              w.events, 0, true, reserved.base, ${bucketOf(routingKey)}
            FROM routed_want w, reserved
            ON CONFLICT (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id)
            DO UPDATE SET events = ARRAY(SELECT DISTINCT e FROM unnest(actor_subscriptions.events || EXCLUDED.events) AS u(e) ORDER BY e)
            WHERE NOT actor_subscriptions.events @> EXCLUDED.events
            RETURNING subscriber_type, subscription, events),
          routed_tags AS (
            INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
            SELECT ${routingKey}, ${tenant}, ${actor}, ${id}, x.tag, count(*)::int
            FROM routed_new n LEFT JOIN routed_old o USING (subscriber_type, subscription)
            CROSS JOIN LATERAL unnest(n.events) AS x(tag)
            WHERE o.events IS NULL OR NOT x.tag = ANY(o.events)
            GROUP BY x.tag
            ON CONFLICT (routing_key, tenant_id, source_type, source_id, event)
            DO UPDATE SET rows = actor_subscription_tags.rows + EXCLUDED.rows
            RETURNING 1)`

  const statement = Effect.map(
    sql<{ emitted_at_ms: string; fed: number }>`WITH reserved AS (
      UPDATE actor_generations SET event_sequence = event_sequence + ${events.length}
      WHERE routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}
      RETURNING event_sequence - ${events.length} AS base,
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()} AS now
    ),
    appended AS (
      INSERT INTO actor_events (routing_key, tenant_id, actor_type, actor_id, sequence, event, command_id, value, emitted_at_ms, payload_version)
      SELECT ${routingKey}, ${tenant}, ${actor}, ${id}, reserved.base + staged.ordinal, staged.event,
        ${request.commandId}, staged.value, reserved.now, staged.version
      FROM reserved, (VALUES ${values}) AS staged (ordinal, event, value, version)
      RETURNING 1)
    ${routedRows},
    feed AS (
      INSERT INTO actor_outbox (routing_key, intent_id, kind, bucket, due_at_ms, scheduled_at_ms,
        tenant_id, actor_type, actor_id, timer_key, target_type, target_id, command, payload, caller)
      SELECT ${routingKey}, gen_random_uuid()::text, 'feed', ${bucketOf(routingKey)}, reserved.now,
        reserved.now, ${tenant}, ${actor}, ${id}, ${FEED_KEY}, ${actor}, ${id}, ${FEED_KEY}, '', ${caller}
      FROM reserved
      WHERE EXISTS (SELECT 1 FROM actor_subscription_tags t
          WHERE ${source("t")} AND t.event IN ${sql.in(emitted)})
        ${routed.length === 0 ? sql.literal("") : sql.literal("OR EXISTS (SELECT 1 FROM routed_new)")}
      ON CONFLICT (routing_key, tenant_id, actor_type, actor_id, timer_key) WHERE timer_key IS NOT NULL
      DO UPDATE SET due_at_ms = least(actor_outbox.due_at_ms, EXCLUDED.due_at_ms), attempts = 0
      RETURNING 1)
    SELECT reserved.now::text AS emitted_at_ms, (SELECT count(*) FROM feed)::int AS fed
    FROM reserved`,
    (rows) => {
      stamp.emittedAtMs = Number(rows[0]!.emitted_at_ms)
      stamp.fed = rows[0]!.fed > 0
    },
  )

  return { statement, stamp }
})

/**
 * Re-arms the timers of this actor's workflows that wait for one of the
 * emitted classes; the result says whether the relay should wake.
 */
export const notifyEvents = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
  waited: ReadonlySet<string>,
) {
  const tags = [...new Set(events.map((event) => event.tag))].filter((tag) => waited.has(tag))

  return tags.length === 0 ? false : yield* notifyWaits(routingKey, request.ref, tags)
})

/**
 * Appends a turn's events and notifies their waiting workflows, one statement
 * at a time; the result says whether the relay should wake, and when the
 * events were stamped.
 */
export const appendEvents = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
  waited: ReadonlySet<string> = new Set(),
) {
  if (events.length === 0) return { notified: false, emittedAtMs: 0 }

  const { statement, stamp } = yield* eventsStatement(request, routingKey, events)
  yield* statement

  const notified = yield* notifyEvents(request, routingKey, events, waited)

  return { notified: notified || stamp.fed, emittedAtMs: stamp.emittedAtMs }
})
