import { PgPool, type PgConnection } from "@effect/sql-pg"
import { Cause, Context, Effect, Exit, Fiber, Layer, Stream } from "effect"
import type { Scope } from "effect"
import type { SqlConnection, SqlError } from "effect/unstable/sql"
import { nekiLease, NekiTurnSessions } from "../database/neki/session.ts"

/**
 * Connections a turn leases for itself alone. Each one is multiplexed and
 * never pinned, so a turn can queue a group of statements without waiting for
 * each reply; a pinned transaction would serialize them.
 */
export class TurnConnections extends Context.Service<
  TurnConnections,
  {
    readonly lease: Effect.Effect<PgConnection.PgConnection, SqlError.SqlError, Scope.Scope>
    /** Takes a connection out of the pool, so its session never serves another turn. */
    readonly invalidate: (connection: PgConnection.PgConnection) => Effect.Effect<void>
  }
>()("@durable-actors/core/runtime/turn/pipeline/TurnConnections") {}

/**
 * Settings merged over the turn pool's own. Tests pass a socket factory here
 * to count the flights one turn puts on the wire.
 */
export const TurnPoolSettings = Context.Reference<Partial<PgPool.Config>>(
  "durable-actors/TurnPoolSettings",
  { defaultValue: () => ({}) },
)

/**
 * The turn pool: `maxConnections` sessions, each handed to one turn at a
 * time. A concurrency of one keeps the lease exclusive while the session
 * stays unpinned.
 *
 * On Neki, each session first runs the Neki session settings.
 */
export const turnConnections = (options: PgPool.Config) =>
  Layer.effect(
    TurnConnections,
    Effect.gen(function* () {
      const settings = yield* TurnPoolSettings
      const neki = yield* NekiTurnSessions

      const pool = yield* PgPool.make({
        ...options,
        ...settings,
        multiplex: true,
        multiplexConcurrency: 1,
      })

      return TurnConnections.of({
        lease: neki ? nekiLease(pool) : pool.get,
        invalidate: pool.invalidate,
      })
    }),
  )

/**
 * Puts one statement on the session. The runtime passes a sender that queues
 * its deferred statements in the same flight, ahead of the statement.
 */
export type Send = <A>(
  statement: Effect.Effect<A, SqlError.SqlError>,
) => Effect.Effect<A, SqlError.SqlError>

/** A leased session as a `SqlClient` connection, so the runtime's statements reach it. */
export const asSqlConnection = ({
  connection,
  send,
}: {
  readonly connection: PgConnection.PgConnection
  readonly send: Send
}): SqlConnection.Connection => {
  const run = (sql: string, params: ReadonlyArray<unknown>, prepare: boolean) =>
    send(Effect.map(connection.query(sql, params, prepare), (result) => result.rows))

  return {
    execute: (sql, params, transformRows) =>
      transformRows === undefined
        ? run(sql, params, true)
        : Effect.map(run(sql, params, true), transformRows),
    executeRaw: (sql, params) => send(connection.query(sql, params)),
    executeStream: (sql, params, transformRows) =>
      Stream.unwrap(
        Effect.as(
          send(Effect.void),
          transformRows === undefined
            ? connection.stream(sql, params)
            : Stream.map(connection.stream(sql, params), (row) => transformRows([row])[0]!),
        ),
      ),
    executeValues: (sql, params) => send(connection.queryValues(sql, params)),
    executeValuesUnprepared: (sql, params) => send(connection.queryValues(sql, params, false)),
    executeUnprepared: (sql, params, transformRows) =>
      transformRows === undefined
        ? run(sql, params, false)
        : Effect.map(run(sql, params, false), transformRows),
  }
}

/**
 * Queues a group of statements for one flight without waiting for replies.
 *
 * Each statement starts on its own fiber before the next is forked, so the
 * driver queues them in submission order and flushes them together. Queuing
 * is uninterruptible, so a group is queued whole or not at all. The fibers
 * live in `scope`, so a group can be queued in one step and awaited in the
 * next.
 */
export const queue = ({
  scope,
  group,
}: {
  readonly scope: Scope.Scope
  readonly group: ReadonlyArray<Effect.Effect<void, SqlError.SqlError>>
}) =>
  Effect.uninterruptible(
    Effect.forEach(group, (statement) =>
      Effect.forkIn(statement, scope, { startImmediately: true, uninterruptible: false }),
    ),
  )

/**
 * Waits for every reply of a queued group, in order. Every reply is awaited
 * before the first failure is reported, so the session has nothing of the
 * group in flight afterwards. Only the wait can be interrupted.
 */
export const replies = (fibers: ReadonlyArray<Fiber.Fiber<void, SqlError.SqlError>>) =>
  Effect.forEach(fibers, Fiber.await).pipe(
    Effect.flatMap((exits) => {
      const failed = exits.find(Exit.isFailure)

      return failed === undefined ? Effect.void : Effect.failCause(failed.cause)
    }),
  )

/** Sends a group of statements as one flight, on child fibers, and waits for every reply. */
export const pipeline = (group: ReadonlyArray<Effect.Effect<void, SqlError.SqlError>>) =>
  Effect.uninterruptible(
    Effect.forEach(group, (statement) =>
      Effect.forkChild(statement, { startImmediately: true, uninterruptible: false }),
    ),
  ).pipe(Effect.flatMap(replies))

/** Runs a group one statement at a time, for a database with nothing to pipeline. */
export const sequential = (group: ReadonlyArray<Effect.Effect<void, SqlError.SqlError>>) =>
  Effect.forEach(group, (statement) => statement, { discard: true })

export const isInterrupted = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
