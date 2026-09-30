import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import type { StoredEvent } from "../members.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { decompress } from "../storage/codec.ts"

/** A cursor is an event sequence: a non-negative 64-bit integer in canonical decimal. */
const CURSOR = /^(0|[1-9][0-9]{0,18})$/

const MAX_SEQUENCE = 2n ** 63n - 1n

/** True for a canonical cursor a stream could have issued. */
export const isCursor = (cursor: string) => CURSOR.test(cursor) && BigInt(cursor) <= MAX_SEQUENCE

interface ReplayRow {
  readonly oldest: string | null
  readonly sequence: string | null
  readonly event: string | null
  readonly command_id: string | null
  readonly value: Uint8Array | null
  readonly payload_version: number | null
  readonly emitted_at_ms: string | null
}

/**
 * Replays committed events of the given tags after an exclusive cursor, up to `head`,
 * the last sequence committed when the query read state. Every event up to
 * `head` had committed by then, so a later read sees each of them unless it
 * was pruned; the oldest retained event and the matching rows come from one
 * statement, and because pruning only removes a prefix, an oldest event past
 * the cursor's successor means history is missing. A page stops after
 * `limit` matching events.
 */
export const replayEvents = Effect.fnUntraced(function* (
  ref: ActorRef,
  routingKey: bigint,
  tags: ReadonlyArray<string>,
  after: string | undefined,
  head: bigint,
  limit: number,
) {
  const cursor = after ?? "0"

  if (!isCursor(cursor) || BigInt(cursor) > head) return yield* UnknownCursor.make({ cursor })

  const position = BigInt(cursor)
  const sql = yield* SqlClient.SqlClient

  const owner = (alias: string) =>
    sql`${sql(alias)}.routing_key = ${routingKey} AND ${sql(alias)}.tenant_id = ${ref.tenant}
      AND ${sql(alias)}.actor_type = ${ref.actor} AND ${sql(alias)}.actor_id = ${ref.id}`

  const rows = yield* sql<ReplayRow>`
    SELECT (SELECT min(o.sequence)::text FROM actor_events o WHERE ${owner("o")}) AS oldest,
      e.sequence::text AS sequence, e.event, e.command_id, e.value, e.payload_version,
      e.emitted_at_ms::text AS emitted_at_ms
    FROM (VALUES (1)) AS one (x)
    LEFT JOIN actor_events e ON ${owner("e")} AND e.sequence > ${position}
      AND e.sequence <= ${head} AND e.event IN ${sql.in(tags)}
    ORDER BY e.sequence
    LIMIT ${limit}`

  const oldest = rows[0]?.oldest

  if (position < head && (oldest == null || BigInt(oldest) > position + 1n))
    return yield* RetentionGap.make({ cursor })

  return rows
    .filter((row) => row.sequence !== null)
    .map((row): StoredEvent & { readonly tag: string } => ({
      cursor: row.sequence!,
      tag: row.event!,
      commandId: row.command_id!,
      value: decompress(row.value!),
      version: row.payload_version!,
      timestampMs: Number(row.emitted_at_ms),
    }))
})
