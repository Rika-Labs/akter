import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/reactivity"
import type { SqlClient } from "effect/sql"

/**
 * The primary's WAL insert position as a decimal string. Read on a turn's
 * session after its `COMMIT` or `ROLLBACK`, it is at least the end of every
 * commit record that session could have observed, so a replica that has
 * replayed this far sees the turn's writes. An LSN cannot be known inside
 * the transaction that writes it, which is why nothing stores it.
 */
export const COMMIT_VERSION = "SELECT (pg_current_wal_insert_lsn() - '0/0')::text AS version"

/**
 * This runner's streaming replica, if it has one. A query that carries a
 * version reads there only once the replica has replayed past it, and
 * otherwise reads the primary.
 */
export const ReadReplica = Context.Reference<SqlClient.SqlClient | undefined>(
  "@durable-actors/core/runtime/database/replica/ReadReplica",
  { defaultValue: () => undefined },
)

/** Provides `ReadReplica` as a client for `options`, or none when no replica is configured. */
export const replicaLayer = (options: PgClient.PgPoolConfig | undefined) =>
  Layer.effect(
    ReadReplica,
    Effect.gen(function* () {
      if (options === undefined) return undefined

      return yield* PgClient.make(options)
    }),
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Whether the replica has replayed WAL through `version`. A server not in
 * recovery reports no replay position, so it never counts as caught up.
 *
 * This runs as its own statement before the query's reads: a statement's
 * snapshot is taken before its functions run, so a check in the same statement
 * could pass after a snapshot that predates the replayed commit.
 */
export const caughtUp = Effect.fnUntraced(function* (
  replica: SqlClient.SqlClient,
  version: string,
) {
  const rows = yield* replica<{ ready: boolean }>`
    SELECT coalesce(pg_last_wal_replay_lsn() - '0/0' >= ${version}::numeric, false) AS ready`

  return rows[0]?.ready === true
})
