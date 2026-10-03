import { PgClient, PgPool } from "@effect/sql-pg"
import type { PgConnection } from "@effect/sql-pg"
import { Effect } from "effect"
import { SqlClient, SqlError, Statement } from "effect/sql"
import type { SqlConnection } from "effect/sql"
import { asSqlConnection } from "../turn/pipeline.ts"
import { fairGate } from "./gate.ts"

/** Postgres answers `COMMIT` in an aborted transaction with the tag `ROLLBACK` and no error. */
const commit = (connection: SqlConnection.Connection) =>
  Effect.flatMap(connection.executeRaw("COMMIT", []), (result) =>
    (result as { readonly command?: string }).command === "ROLLBACK"
      ? Effect.fail(
          SqlError.SqlError.make({
            reason: SqlError.UnknownError.make({
              cause: new Error("COMMIT rolled back an aborted transaction"),
              message: "PgClient: COMMIT rolled back an aborted transaction",
              operation: "commit",
            }),
          }),
        )
      : Effect.void,
  )

const PgJson = Statement.custom<Statement.Custom<"PgJson", unknown>>("PgJson")

const direct = <A>(statement: Effect.Effect<A, SqlError.SqlError>) => statement

/**
 * A Postgres client over a pool of `options.maxConnections` (default 10)
 * whose checkouts, statements, transactions, and reservations alike, queue
 * first come, first served through a gate with one slot per connection. At
 * most that many checkouts are out at once, so the pool never has a waiter
 * to pass over.
 *
 * It is `PgClient.make` with that gate: the same pool, compiler, transforms,
 * span attributes, commit check, savepoint release, JSON fragments, and
 * notifications. A single statement borrows its connection for that
 * statement alone, as `PgClient` does, without opening a scope.
 */
export const fairPool = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  const pool = yield* PgPool.make(options)
  const gate = fairGate(options.maxConnections ?? 10)

  const connection = (session: PgConnection.PgConnection) =>
    asSqlConnection({ connection: session, send: direct })

  const sql = yield* SqlClient.make({
    acquirer: Effect.andThen(gate.take, Effect.map(pool.get, connection)),
    borrower: (f) => gate.use(pool.use((session) => f(connection(session)))),
    transactionAcquirer: Effect.andThen(gate.take, Effect.map(pool.reserve, connection)),
    compiler: PgClient.makeCompiler(options.transformQueryNames, options.transformJson),
    spanAttributes: [
      ...(options.spanAttributes === undefined ? [] : Object.entries(options.spanAttributes)),
      ["db.system.name", "postgresql"],
      ["db.namespace", options.database ?? options.username ?? "postgres"],
      ["server.address", options.host ?? "localhost"],
      ["server.port", options.port ?? 5432],
    ],
    transformRows:
      options.transformResultNames === undefined
        ? undefined
        : Statement.defaultTransforms(options.transformResultNames, options.transformJson).array,
    prepareTransactionControls: true,
    commit,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
  })

  return Object.assign(sql, {
    [PgClient.TypeId]: PgClient.TypeId,
    config: options,
    json: ((value) => Statement.fragment([PgJson(value)])) satisfies PgClient.PgClient["json"],
    listen: (channel: string) =>
      Effect.andThen(
        gate.take,
        Effect.flatMap(pool.reserve, (session) => session.listen(channel)),
      ),
    notify: (channel: string, payload: string) =>
      Effect.asVoid(sql`SELECT pg_notify(${channel}, ${payload})`),
  }) satisfies PgClient.PgClient
})

/** `PgClient.layer` with first-come, first-served checkouts. */
export const fairLayer = (options: PgClient.PgPoolConfig) => PgClient.layerFrom(fairPool(options))
