import { PgPool, type PgConnection } from "@effect/sql-pg"
import { Context, Duration, Effect, Exit, Fiber, Layer } from "effect"
import type { Scope } from "effect"
import type { SqlError } from "effect/sql"
import { fairGate } from "../database/gate.ts"
import { nekiLease, NekiTurnSessions } from "../database/neki/session.ts"
import { admissionLimit } from "../admission.ts"
import { perShard, POOL_WAITERS, poolRefusal, targetedAt } from "../database/bounded.ts"
import { targetShard } from "../database/shards.ts"

/**
 * Connections a turn leases for itself alone. Each one is multiplexed and
 * never pinned, so a turn can queue a group of statements without waiting for
 * each reply; a pinned transaction would serialize them.
 */
export class TurnConnections extends Context.Service<
  TurnConnections,
  {
    /**
     * Leases one session for the enclosing scope, from the pool of the
     * caller's `ShardTarget`; the session returns to its pool when the scope
     * closes.
     */
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
 * One turn pool: `maxConnections` sessions, each handed to one turn at a
 * time. A concurrency of one keeps the lease exclusive while the session
 * stays unpinned. A lease first takes a bounded admission slot, refused at
 * once past `maxConnections` plus the waiter allowance, then waits for a
 * session first come, first served, so a turn never waits behind turns that
 * asked after it. Both slots stay with the lease's scope and return with the
 * session.
 *
 * On Neki, each session first runs the Neki session settings.
 */
const turnPool = Effect.fnUntraced(function* (config: PgPool.Config, neki: boolean) {
  const pool = yield* PgPool.make({
    ...config,
    multiplex: true,
    multiplexConcurrency: 1,
  })

  const slots = config.maxConnections ?? 10
  const admission = admissionLimit({ limit: slots + POOL_WAITERS, wait: Duration.zero })
  const gate = fairGate(slots)
  const acquire = Effect.andThen(gate.take, neki ? nekiLease(pool) : pool.get)

  return { pool, take: Effect.andThen(admission.take.pipe(Effect.mapError(poolRefusal)), acquire) }
})

/**
 * The turn pools. A turn whose fiber targets a data shard leases from that
 * shard's pool, whose sessions target it from their startup packet, so every
 * statement of the turn reaches the shard holding its actor's rows. Each
 * shard's pool has `maxConnections` sessions of its own and opens on the
 * first turn that needs it. A turn with no target uses the untargeted pool.
 */
export const turnConnections = (options: PgPool.Config) =>
  Layer.effect(
    TurnConnections,
    Effect.gen(function* () {
      const settings = yield* TurnPoolSettings
      const neki = yield* NekiTurnSessions
      const scope = yield* Effect.scope

      const config = { ...options, ...settings }
      const untargeted = yield* turnPool(config, neki)
      const shard = perShard({
        scope,
        open: (target) => turnPool(targetedAt({ options: config, shard: target }), neki),
      })
      const owners = new WeakMap<PgConnection.PgConnection, PgPool.PgPool>()
      let leased = 0
      let waiting = 0

      const poolOf = Effect.flatMap(targetShard, (target) =>
        target === undefined ? Effect.succeed(untargeted) : Effect.orDie(shard(target)),
      )

      return TurnConnections.of({
        lease: Effect.suspend(() => {
          waiting += 1

          return Effect.flatMap(poolOf, ({ pool, take }) =>
            Effect.tap(take, (connection) =>
              Effect.sync(() => {
                owners.set(connection, pool)
              }),
            ),
          ).pipe(
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
        invalidate: (connection) =>
          (owners.get(connection) ?? untargeted.pool).invalidate(connection),
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

export { asSqlConnection } from "../database/connection.ts"

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
