import { PgClient, PgPool } from "@effect/sql-pg"
import { Duration, Effect, Schema } from "effect"
import { SqlClient, SqlError, Statement } from "effect/sql"
import type { SqlConnection } from "effect/sql"
import { admissionLimit, isOverloaded } from "../admission.ts"
import { ActorError } from "../../errors/actor.ts"
import { asSqlConnection } from "./connection.ts"

/** Extra checkouts each pool holds beyond its connections before refusing further work. */
export const POOL_WAITERS = 64

/** SQL-compatible overload keeps caller-facing reads retryable without exposing the internal cause. */
export const poolRefusal = (cause: unknown) =>
  SqlError.SqlError.make({
    reason: SqlError.ConnectionError.make({ cause, message: "Postgres pool admission is full" }),
  })

/** Recognizes only our pre-statement checkout refusal, never a failed statement or unknown commit. */
export const isPoolRefusal = (cause: unknown) =>
  SqlError.isSqlError(cause) &&
  Schema.is(ActorError)(cause.reason.cause) &&
  isOverloaded(cause.reason.cause)

/** Postgres can answer COMMIT with ROLLBACK when a transaction has already aborted. */
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
 * The native Postgres client with at most 64 queued checkouts beyond its
 * connection capacity. All SQL entry points share admission, including
 * reservations, transactions, streams and listeners; bounding only command
 * dispatch would leave queries and background callers able to grow the pool's
 * waiter list. A refused checkout sent no statement. The scope owns a slot
 * until the connection returns, so cancellation never leaks capacity.
 */
export const boundedPool = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  const pool = yield* PgPool.make(options)
  const slots = options.maxConnections ?? 10
  const gate = admissionLimit({ limit: slots + POOL_WAITERS, wait: Duration.zero })
  const enter = gate.take.pipe(Effect.mapError(poolRefusal))
  const connection = (session: Effect.Success<typeof pool.get>) =>
    asSqlConnection({ connection: session, send: direct })
  const acquire = Effect.andThen(enter, Effect.map(pool.get, connection))
  const sql = yield* SqlClient.make({
    acquirer: acquire,
    transactionAcquirer: Effect.andThen(enter, Effect.map(pool.reserve, connection)),
    borrower: (use) =>
      gate
        .admit(pool.use((session) => use(connection(session))))
        .pipe(
          Effect.mapError((error) => (Schema.is(ActorError)(error) ? poolRefusal(error) : error)),
        ),
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
        enter,
        Effect.flatMap(pool.reserve, (session) => session.listen(channel)),
      ),
    notify: (channel: string, payload: string) =>
      Effect.asVoid(sql`SELECT pg_notify(${channel}, ${payload})`),
  }) satisfies PgClient.PgClient
})

/** Provides the bounded primary/off-turn client without changing its connection configuration. */
export const boundedLayer = (options: PgClient.PgPoolConfig) =>
  PgClient.layerFrom(boundedPool(options))
