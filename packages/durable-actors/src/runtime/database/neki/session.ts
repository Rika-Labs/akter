import type { PgConnection, PgPool } from "@effect/sql-pg"
import { Context, Effect } from "effect"
import type { Scope } from "effect"
import type { SqlError } from "effect/sql"

/**
 * Whether the database is a Neki router. Turn sessions then run
 * `NEKI_SESSION_SETTINGS`; nothing sets this outside the Neki conformance
 * backend until Neki is a supported database.
 */
export const NekiTurnSessions = Context.Reference<boolean>("durable-actors/NekiTurnSessions", {
  defaultValue: () => false,
})

/**
 * Session settings a turn connection needs on Neki, in the order they are set.
 * The router reads the transaction mode when `BEGIN` arrives, so both are set
 * on the session before any turn opens a transaction, never inside one.
 */
export const NEKI_SESSION_SETTINGS: ReadonlyArray<string> = [
  "SET __neki.tx_mode = 'single'",
  "SET __neki.fanout = 'single'",
]

/**
 * `pool.get` with `NEKI_SESSION_SETTINGS` run once on each session, on its
 * first lease, so a turn that reaches a second shard fails instead of
 * committing on one shard and not the other. A session whose settings fail is
 * dropped from the pool: a turn must never run on one that lacks them.
 */
export const nekiLease = (
  pool: PgPool.PgPool,
): Effect.Effect<PgConnection.PgConnection, SqlError.SqlError, Scope.Scope> => {
  const configured = new WeakSet<PgConnection.PgConnection>()

  const configure = (connection: PgConnection.PgConnection) =>
    Effect.forEach(NEKI_SESSION_SETTINGS, (setting) => connection.query(setting, [], false), {
      discard: true,
    }).pipe(
      Effect.tap(() => Effect.sync(() => configured.add(connection))),
      Effect.tapCause(() => pool.invalidate(connection)),
    )

  return Effect.tap(pool.get, (connection) =>
    configured.has(connection) ? Effect.void : configure(connection),
  )
}
