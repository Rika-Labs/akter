import { Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

/** A subscription row's key, then what it follows: the columns every row change reads and returns. */
const ROW = [
  "routing_key",
  "tenant_id",
  "source_type",
  "source_id",
  "subscriber_type",
  "subscription",
  "subscriber_id",
  "active",
  "events",
] as const

/** The row columns of the subscription row aliased `alias`, for a select list or `RETURNING`. */
export const rowColumns = ({
  sql,
  alias,
}: {
  readonly sql: SqlClient.SqlClient
  readonly alias: string
}) => sql.literal(ROW.map((column) => `${alias}.${column}`).join(", "))

/**
 * CTEs that move the tag summary by the rows of the CTE named `changed`, whose
 * columns name a source and the event tags one row followed before (`was`)
 * and after (`now`) the change, each empty for an inactive or absent row. A
 * summary row counts the active rows of its source that follow its tag, so
 * each count moves by the rows that gained the tag less the rows that lost
 * it. Every count moves in one upsert that takes its rows in key order, so
 * concurrent writers of one source's counts lock them in the same order and
 * never deadlock; an update whose lock order followed the plan would, and its
 * victim's change would wait out a retry. The proposed row holds no negative
 * count, which the summary's check refuses before the conflict is found, so
 * the update reads the signed delta itself. A decrement upserts against the
 * latest version of its row, and `tags_moved` returns every count it set,
 * since one that reached 0 must be deleted before the transaction commits.
 */
export const summarize = ({
  sql,
  changed,
}: {
  readonly sql: SqlClient.SqlClient
  readonly changed: string
}) => {
  const rows = sql.literal(changed)

  return sql`tag_delta AS (
      SELECT routing_key, tenant_id, source_type, source_id, tag, sum(d)::int AS d FROM (
        SELECT c.routing_key, c.tenant_id, c.source_type, c.source_id, x.tag, 1 AS d
        FROM ${rows} c CROSS JOIN LATERAL unnest(c.now) AS x(tag)
        WHERE NOT x.tag = ANY(c.was)
        UNION ALL
        SELECT c.routing_key, c.tenant_id, c.source_type, c.source_id, x.tag, -1 AS d
        FROM ${rows} c CROSS JOIN LATERAL unnest(c.was) AS x(tag)
        WHERE NOT x.tag = ANY(c.now)) moved
      GROUP BY routing_key, tenant_id, source_type, source_id, tag
      HAVING sum(d) <> 0),
    tags_moved AS (
      INSERT INTO actor_subscription_tags AS t (routing_key, tenant_id, source_type, source_id, event, rows)
      SELECT routing_key, tenant_id, source_type, source_id, tag, greatest(d, 0) FROM tag_delta
      ORDER BY routing_key, tenant_id, source_type, source_id, tag
      ON CONFLICT (routing_key, tenant_id, source_type, source_id, event)
      DO UPDATE SET rows = t.rows + (SELECT d.d FROM tag_delta d
        WHERE d.routing_key = EXCLUDED.routing_key AND d.tenant_id = EXCLUDED.tenant_id
          AND d.source_type = EXCLUDED.source_type AND d.source_id = EXCLUDED.source_id
          AND d.tag = EXCLUDED.event)
      RETURNING t.routing_key, t.tenant_id, t.source_type, t.source_id, t.event, t.rows)`
}

/**
 * Changes subscription rows and the tag summary in one transaction, so no
 * caller maintains the summary. `old` locks the rows about to change and
 * returns their row columns; `change` writes them, reading those rows as
 * `old_rows`, and returns their row columns as they are now, with `active`
 * false for a deleted row. The lock is its own statement: a lock in the
 * changing statement would skip a row that statement already changed, and
 * its rows would then count as new. Locking reads the latest committed
 * version of each row, so a concurrent change that committed first is never
 * counted twice. A summary count the change lowered to 0 is deleted in the
 * same transaction, so no committed summary row counts 0. Returns how many
 * rows `change` wrote. A `change` that reads the outbox clock passes its
 * `clock` CTE, which leads the statement's `WITH`.
 */
export const changeRows = Effect.fnUntraced(function* (
  old: Statement.Fragment,
  change: Statement.Fragment,
  clock?: Statement.Fragment,
) {
  const sql = yield* SqlClient.SqlClient

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [locked] = yield* sql<{ rows: string }>`
        SELECT coalesce(json_agg(o), '[]')::text AS rows FROM (${old}) o`

      const [result] = yield* sql<{ rows: number; emptied: string | null }>`
        WITH ${clock === undefined ? sql`` : sql`${clock},`} old_rows AS (
          SELECT * FROM json_to_recordset(${locked!.rows}::json) AS o(routing_key bigint,
            tenant_id text, source_type text, source_id text, subscriber_type text,
            subscription text, subscriber_id text, active boolean, events text[])),
        new_rows AS (${change}),
        changed AS (
          SELECT routing_key, tenant_id, source_type, source_id,
            CASE WHEN o.active THEN o.events ELSE '{}'::text[] END AS was,
            CASE WHEN n.active THEN n.events ELSE '{}'::text[] END AS now
          FROM old_rows o FULL JOIN new_rows n USING (routing_key, tenant_id, source_type,
            source_id, subscriber_type, subscription, subscriber_id)),
        ${summarize({ sql, changed: "changed" })}
        SELECT (SELECT count(*) FROM new_rows)::int AS rows,
          (SELECT json_agg(json_build_array(routing_key::text, tenant_id, source_type, source_id,
            event)) FROM tags_moved WHERE rows = 0)::text AS emptied`

      if (result!.emptied !== null)
        yield* sql`DELETE FROM actor_subscription_tags t
          USING json_array_elements(${result!.emptied}::json) AS e
          WHERE t.routing_key = (e->>0)::bigint AND t.tenant_id = e->>1
            AND t.source_type = e->>2 AND t.source_id = e->>3 AND t.event = e->>4
            AND t.rows = 0`

      return result!.rows
    }),
  )
})
