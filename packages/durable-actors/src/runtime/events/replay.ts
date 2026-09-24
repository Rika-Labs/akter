import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import type { StoredEvent } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { decompress } from "../storage/codec.ts"

/** A cursor is an event sequence: a non-negative 64-bit integer in canonical decimal. */
const CURSOR = /^(0|[1-9][0-9]{0,18})$/

const MAX_SEQUENCE = 2n ** 63n - 1n

interface ReplayRow {
  readonly head: string | null
  readonly oldest: string | null
  readonly sequence: string | null
  readonly command_id: string | null
  readonly value: Uint8Array | null
  readonly emitted_at_ms: string | null
}

/**
 * Replays committed events of one tag after an exclusive cursor. The stream
 * head, the oldest retained event, and the matching rows come from one
 * statement, so one snapshot proves no retained event after the cursor was
 * skipped; pruning only removes a prefix, so an oldest event past the cursor's
 * successor means history is missing.
 */
export const replayEvents = Effect.fnUntraced(function* (
  ref: ActorRef,
  routingKey: bigint,
  tag: string,
  after: string | undefined,
) {
  const cursor = after ?? "0"

  if (!CURSOR.test(cursor) || BigInt(cursor) > MAX_SEQUENCE)
    return yield* UnknownCursor.make({ cursor })

  const position = BigInt(cursor)
  const sql = yield* SqlClient.SqlClient

  const owner = (alias: string) =>
    sql`${sql(alias)}.routing_key = ${routingKey} AND ${sql(alias)}.tenant_id = ${ref.tenant}
      AND ${sql(alias)}.actor_type = ${ref.actor} AND ${sql(alias)}.actor_id = ${ref.id}`

  const rows = yield* sql<ReplayRow>`
    SELECT g.event_sequence::text AS head,
      (SELECT min(o.sequence)::text FROM actor_events o WHERE ${owner("o")}) AS oldest,
      e.sequence::text AS sequence, e.command_id, e.value, e.emitted_at_ms::text AS emitted_at_ms
    FROM (VALUES (1)) AS one (x)
    LEFT JOIN actor_generations g ON ${owner("g")}
    LEFT JOIN actor_events e ON ${owner("e")} AND e.sequence > ${position} AND e.event = ${tag}
    ORDER BY e.sequence`

  const head = BigInt(rows[0]?.head ?? "0")
  const oldest = rows[0]?.oldest

  if (position > head) return yield* UnknownCursor.make({ cursor })

  if (position < head && (oldest == null || BigInt(oldest) > position + 1n))
    return yield* RetentionGap.make({ cursor })

  const events: Array<StoredEvent> = []

  for (const row of rows)
    if (row.sequence !== null)
      events.push({
        cursor: row.sequence,
        commandId: row.command_id!,
        value: decompress(row.value!),
        timestampMs: Number(row.emitted_at_ms),
      })

  return events
})
