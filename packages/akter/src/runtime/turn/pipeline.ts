import { PgPool, type PgConnection } from "@effect/sql-pg"
import { Context, Effect, Exit, Fiber, Layer, Stream } from "effect"
import type { Scope } from "effect"
import type { SqlConnection, SqlError } from "effect/sql"
import { nekiLease, NekiTurnSessions } from "../database/neki/session.ts"

/**
 * Connections a turn leases for itself alone. Each one is multiplexed and
 * never pinned, so a turn can queue a group of statements without waiting for
 * each reply; a pinned transaction would serialize them.
 */
export class TurnConnections extends Context.Service<
  TurnConnections,
  {
    /** Leases one session for the enclosing scope; the session returns to the pool when the scope closes. */
    readonly lease: Effect.Effect<PgConnection.PgConnection, SqlError.SqlError, Scope.Scope>
    /** Takes a connection out of the pool, so its session never serves another turn. */
    readonly invalidate: (connection: PgConnection.PgConnection) => Effect.Effect<void>
    /** Sessions turns hold now, and turns still waiting for one. */
    readonly sessions: () => { readonly leased: number; readonly waiting: number }
  }
>()("@rikalabs/akter/runtime/turn/pipeline/TurnConnections") {}

/**
 * Settings merged over the turn pool's own. Tests pass a socket factory here
 * to count the flights one turn puts on the wire.
 */
export const TurnPoolSettings = Context.Reference<Partial<PgPool.Config>>(
  "akter/TurnPoolSettings",
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

      const acquire = neki ? nekiLease(pool) : pool.get
      let leased = 0
      let waiting = 0

      return TurnConnections.of({
        lease: Effect.suspend(() => {
          waiting += 1

          return acquire.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                waiting -= 1
              }),
            ),
            Effect.tap(() =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  leased += 1
                }),
                () =>
                  Effect.sync(() => {
                    leased -= 1
                  }),
              ),
            ),
          )
        }),
        invalidate: pool.invalidate,
        sessions: () => ({ leased, waiting }),
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
  const rows =
    (prepare: boolean): SqlConnection.Connection["execute"] =>
    (sql, params, transformRows) => {
      const found = send(
        Effect.map(connection.query(sql, params, prepare), (result) => result.rows),
      )

      return transformRows === undefined ? found : Effect.map(found, transformRows)
    }

  return {
    execute: rows(true),
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
    executeUnprepared: rows(false),
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
export const queueStatements = ({
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
export const awaitReplies = (fibers: ReadonlyArray<Fiber.Fiber<void, SqlError.SqlError>>) =>
  Effect.forEach(fibers, Fiber.await).pipe(
    Effect.flatMap((exits) => {
      const failed = exits.find(Exit.isFailure)

      return failed === undefined ? Effect.void : Effect.failCause(failed.cause)
    }),
  )

/** Sends a group of statements as one flight, on child fibers, and waits for every reply. */
export const sendPipelined = (group: ReadonlyArray<Effect.Effect<void, SqlError.SqlError>>) =>
  Effect.uninterruptible(
    Effect.forEach(group, (statement) =>
      Effect.forkChild(statement, { startImmediately: true, uninterruptible: false }),
    ),
  ).pipe(Effect.flatMap(awaitReplies))

/** Runs a group one statement at a time, for a database with nothing to pipeline. */
export const sendSequentially = (group: ReadonlyArray<Effect.Effect<void, SqlError.SqlError>>) =>
  Effect.forEach(group, (statement) => statement, { discard: true })
