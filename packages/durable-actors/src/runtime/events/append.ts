import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EmittedEvent, Request } from "../../handles/actors.ts"
import { compress } from "../storage/codec.ts"

/**
 * Appends a turn's events inside its transaction. The caller already holds the
 * actor's generation row lock, so reserving the next sequence numbers there
 * gives one gap-free order per actor even when activations race; the counter
 * lives on the generation row so pruning never lets a sequence be reused.
 */
export const appendEvents = Effect.fnUntraced(function* (
  request: Request,
  routingKey: bigint,
  events: ReadonlyArray<EmittedEvent>,
) {
  if (events.length === 0) return
  const sql = yield* SqlClient.SqlClient
  const { tenant, actor, id } = request.ref

  const [reserved] = yield* sql<{ last: string; now: string }>`
    UPDATE actor_generations SET event_sequence = event_sequence + ${events.length}
    WHERE routing_key = ${routingKey} AND tenant_id = ${tenant} AND actor_type = ${actor} AND actor_id = ${id}
    RETURNING event_sequence::text AS last, floor(extract(epoch FROM now()) * 1000)::text AS now`

  const first = BigInt(reserved!.last) - BigInt(events.length) + 1n

  yield* sql`INSERT INTO actor_events ${sql.insert(
    events.map((event, index) => ({
      routing_key: routingKey,
      tenant_id: tenant,
      actor_type: actor,
      actor_id: id,
      sequence: first + BigInt(index),
      event: event.tag,
      command_id: request.commandId,
      value: compress(event.value),
      emitted_at_ms: BigInt(reserved!.now),
    })),
  )}`
})
