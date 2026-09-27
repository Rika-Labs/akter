import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EmittedEvent, Request } from "../../handles/actors.ts"
import { FrameworkClock } from "../turn/admission.ts"
import { compress } from "../storage/codec.ts"
import { notifyWaits } from "../workflows/engine.ts"

/**
 * The statement that appends a turn's events inside its transaction. The
 * caller already holds the actor's generation row lock, so reserving the next
 * sequence numbers there gives one gap-free order per actor even when
 * activations race; the counter lives on the generation row so pruning never
 * lets a sequence be reused. The reservation and the insert share a statement,
 * so nothing waits on the reserved numbers.
 */
export const eventsStatements = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
) {
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = request.ref
  const clock = yield* FrameworkClock

  const values = sql.csv(
    events.map(
      (event, index) =>
        sql`(${index + 1}::bigint, ${event.tag}::text, ${compress(event.value)}::bytea)`,
    ),
  )

  return [
    Effect.asVoid(sql`WITH reserved AS (
      UPDATE actor_generations SET event_sequence = event_sequence + ${events.length}
      WHERE routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}
      RETURNING event_sequence - ${events.length} AS base,
        floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + ${clock.offsetMillis()} AS now
    )
    INSERT INTO actor_events (routing_key, tenant_id, actor_type, actor_id, sequence, event, command_id, value, emitted_at_ms)
    SELECT ${routingKey}, ${tenant}, ${actor}, ${id}, reserved.base + staged.ordinal, staged.event,
      ${request.commandId}, staged.value, reserved.now
    FROM reserved, (VALUES ${values}) AS staged (ordinal, event, value)`),
  ]
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

/** Appends a turn's events and notifies their waiting workflows, one statement at a time. */
export const appendEvents = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
  waited: ReadonlySet<string> = new Set(),
) {
  if (events.length === 0) return false

  for (const statement of yield* eventsStatements(request, routingKey, events)) yield* statement

  return yield* notifyEvents(request, routingKey, events, waited)
})
