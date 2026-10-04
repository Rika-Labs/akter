import { PgClient, PgPool } from "@effect/sql-pg"
import { Duration, Effect, Schedule, Schema } from "effect"
import { SqlClient, SqlError, Statement } from "effect/sql"
import type { SqlConnection } from "effect/sql"
import { admissionLimit, isOverloaded } from "../admission.ts"
import { ActorError } from "../../errors/actor.ts"
import { asSqlConnection } from "./connection.ts"
import { fairGate } from "./gate.ts"

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

/** Retries a pre-statement checkout refusal for scoped startup and background work. */
export const retryPoolRefusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: isPoolRefusal,
      schedule: Schedule.min([Schedule.exponential("10 millis", 2), Schedule.spaced("250 millis")]),
    }),
  )

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
 * connection capacity, handing its connections out first come, first served.
 * All SQL entry points share admission, including reservations,
 * transactions, streams and listeners; bounding only command dispatch would
 * leave queries and background callers able to grow the pool's waiter list.
 * A refused checkout sent no statement.
 *
 * A checkout passes three stages in order: the bounded admission slot,
 * refused at once past the limit; a first-come, first-served gate with one
 * slot per connection, so a caller never waits behind one that asked after
 * it, which Effect's pool allows because it hands a freed connection to
 * whichever fiber asks next; then the pool, which therefore never has a
 * waiter of its own. Both slots belong to the checkout's scope, or to the
 * borrowed statement, and return with the connection, so cancellation never
 * leaks either. A statement inside a transaction reuses its connection and
 * takes neither.
 *
 * Apart from the gates it is `PgClient.make`: the same compiler, transforms,
 * span attributes, commit check, savepoint release, JSON fragments, and
 * notifications, which use a checkout of their own rather than the caller's
 * transaction.
 */
export const boundedPool = Effect.fnUntraced(function* (options: PgClient.PgPoolConfig) {
  const pool = yield* PgPool.make(options)
  const slots = options.maxConnections ?? 10
  const admission = admissionLimit({ limit: slots + POOL_WAITERS, wait: Duration.zero })
  const fair = fairGate(slots)
  const enter = Effect.andThen(admission.take.pipe(Effect.mapError(poolRefusal)), fair.take)
  const connection = (session: Effect.Success<typeof pool.get>) =>
    asSqlConnection({ connection: session, send: direct })
  const acquire = Effect.andThen(enter, Effect.map(pool.get, connection))
  const sql = yield* SqlClient.make({
    acquirer: acquire,
    transactionAcquirer: Effect.andThen(enter, Effect.map(pool.reserve, connection)),
    borrower: (use) =>
      admission
        .admit(fair.use(pool.use((session) => use(connection(session)))))
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
    notify: (channel: string, payload: string) => {
      if (new TextEncoder().encode(channel).byteLength > 63) {
        const message = "PostgreSQL channel names must not exceed 63 UTF-8 bytes"
        return Effect.fail(
          SqlError.SqlError.make({
            reason: SqlError.UnknownError.make({
              cause: new Error(message),
              message,
              operation: "notify",
            }),
          }),
        )
      }

      return Effect.asVoid(
        Effect.scoped(
          Effect.flatMap(acquire, (conn) =>
            conn.executeRaw("SELECT pg_notify($1, $2)", [channel, payload]),
          ),
        ),
      )
    },
  }) satisfies PgClient.PgClient
})

/** Provides the bounded primary/off-turn client without changing its connection configuration. */
export const boundedLayer = (options: PgClient.PgPoolConfig) =>
  PgClient.layerFrom(boundedPool(options))
