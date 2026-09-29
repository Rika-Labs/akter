import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer } from "effect"
import { Reactivity } from "effect/unstable/reactivity"
import type { SqlClient, SqlError } from "effect/unstable/sql"

/**
 * The primary's WAL insert position as a decimal string. Read on a turn's
 * session after its `COMMIT` or `ROLLBACK`, it is at least the end of every
 * commit record that session could have observed, so a replica that has
 * replayed this far sees the turn's writes. An LSN cannot be known inside
 * the transaction that writes it, which is why nothing stores it.
 */
export const COMMIT_VERSION = "SELECT (pg_current_wal_insert_lsn() - '0/0')::text AS version"

/**
 * This runner's streaming replica. A query that carries a version reads here
 * only once the replica has replayed past it, and otherwise reads the primary.
 */
export class ReadReplica extends Context.Service<ReadReplica, SqlClient.SqlClient>()(
  "@durable-actors/core/runtime/database/replica/ReadReplica",
) {}

export const replicaLayer = (options: PgClient.PgPoolConfig) =>
  Layer.effect(ReadReplica, PgClient.make(options)).pipe(Layer.provide(Reactivity.layer))

/**
 * Whether the replica has replayed WAL through `version`. A server not in
 * recovery reports no replay position, so it never counts as caught up.
 *
 * This runs as its own statement before the query's reads: a statement's
 * snapshot is taken before its functions run, so a check in the same statement
 * could pass after a snapshot that predates the replayed commit.
 */
export const caughtUp = (
  replica: SqlClient.SqlClient,
  version: string,
): Effect.Effect<boolean, SqlError.SqlError> =>
  Effect.map(
    replica<{ ready: boolean }>`
      SELECT coalesce(pg_last_wal_replay_lsn() - '0/0' >= ${version}::numeric, false) AS ready`,
    (rows) => rows[0]?.ready === true,
  )
