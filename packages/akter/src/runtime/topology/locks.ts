import { Cause, Context, Duration, Effect, PrimaryKey } from "effect"
import {
  ClusterError,
  type RunnerAddress,
  type RunnerStorage,
  ShardId,
  ShardingConfig,
  SqlRunnerStorage,
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Coordination } from "../database/coordination.ts"
import { prepareRunnerStorage } from "../database/neki/migrations.ts"
import { NekiTurnSessions } from "../database/neki/session.ts"

/**
 * Builds Cluster registrations and lock storage on the deployment's
 * authority, never on a runner's data shard. On a Neki router, table locks
 * are acquired by `nekiTableAcquire`.
 */
export const coordinatedRunnerStorage = Effect.gen(function* () {
  const sql = (yield* Coordination) ?? (yield* SqlClient.SqlClient)
  const config = yield* ShardingConfig.ShardingConfig
  const storage = yield* prepareRunnerStorage.pipe(
    Effect.andThen(SqlRunnerStorage.make({})),
    Effect.provideService(SqlClient.SqlClient, sql),
  )

  return (yield* NekiTurnSessions) && config.shardLockDisableAdvisory
    ? { ...storage, acquire: nekiTableAcquire({ sql, config }) }
    : storage
})

/**
 * Cluster's table-lock acquire, in a form a Neki router runs. Cluster inserts
 * its rows through `INSERT ... SELECT ... ON CONFLICT DO UPDATE` stamped with
 * `NOW()`, which the router evaluates itself and then refuses to plan. This
 * statement inserts the same rows as a `VALUES` list in the byte order of
 * their shard ids, the order Cluster's `ORDER BY shard_id COLLATE "C"` takes
 * them in, so concurrent acquires, refreshes and releases still lock rows in
 * one order. It takes over a row only when this runner holds it or its last
 * acquire is older than the lock expiration, then reads back the shards this
 * runner holds, as Cluster does, and fails as Cluster does when either
 * statement fails or the pair outlasts Cluster's lock-operation interval.
 */
const nekiTableAcquire = ({
  sql,
  config,
}: {
  readonly sql: SqlClient.SqlClient
  readonly config: ShardingConfig.ShardingConfig["Service"]
}): RunnerStorage.RunnerStorage["Service"]["acquire"] => {
  const expires = sql.literal(
    `NOW() - INTERVAL '${Math.ceil(Duration.toSeconds(Duration.fromInputUnsafe(config.shardLockExpiration)))} seconds'`,
  )
  const interval = Duration.min(
    Duration.fromInputUnsafe(config.shardLockRefreshInterval),
    Duration.divideUnsafe(Duration.fromInputUnsafe(config.shardLockExpiration), 3),
  )

  return (address, shardIds) =>
    Effect.gen(function* () {
      const requested = Array.from(shardIds, ShardId.toString).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      )

      if (requested.length === 0) return []

      const holder = PrimaryKey.value(address)

      yield* sql`INSERT INTO cluster_locks (shard_id, address, acquired_at)
        VALUES ${sql.csv(requested.map((shardId) => sql`(${shardId}, ${holder}, NOW())`))}
        ON CONFLICT (shard_id) DO UPDATE SET address = ${holder}, acquired_at = NOW()
        WHERE cluster_locks.address = ${holder} OR cluster_locks.acquired_at < ${expires}`

      const held = yield* sql<{ readonly shard_id: string }>`SELECT shard_id FROM cluster_locks
        WHERE address = ${holder} AND acquired_at >= ${expires}
          AND shard_id IN ${sql.in(requested)}`

      return held.map(({ shard_id }) => ShardId.fromString(shard_id))
    }).pipe(
      Effect.timeout(interval),
      Effect.catchCause((cause) =>
        Effect.fail(ClusterError.PersistenceError.make({ cause: Cause.squash(cause) })),
      ),
    )
}

/**
 * Whether this runner still holds a shard's lock, read from the database. A
 * runner whose lock refreshes stall keeps serving its shards in memory until
 * it notices; singleton activations check this lease so their background work
 * stops before another runner can take the shard.
 */
export class ShardLease extends Context.Service<
  ShardLease,
  {
    /** How often a resident singleton rechecks its lease. */
    readonly interval: Duration.Duration
    readonly holds: (shardId: string) => Effect.Effect<boolean>
  }
>()("@rikalabs/akter/runtime/topology/locks/ShardLease") {}

/**
 * The lease of table-backed shard locks. A lock counts as held only while its
 * last refresh is younger than half the expiration, so its holder stops
 * before the lock expires and another runner may acquire it; a healthy runner
 * refreshes at least every third of the expiration. A failed read counts as
 * lost.
 */
export const tableShardLease = ({
  sql,
  address,
  expiration,
}: {
  readonly sql: SqlClient.SqlClient
  readonly address: RunnerAddress.RunnerAddress
  readonly expiration: Duration.Duration
}) => {
  const fresh = Duration.toMillis(expiration) / 2 / 1000
  const holder = PrimaryKey.value(address)

  return ShardLease.of({
    interval: Duration.divideUnsafe(expiration, 6),
    holds: (shardId) =>
      sql<{ held: number }>`SELECT 1 AS held FROM cluster_locks
        WHERE shard_id = ${shardId} AND address = ${holder}
          AND acquired_at >= NOW() - make_interval(secs => ${fresh})`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => false),
      ),
  })
}

/**
 * Keeps Cluster from dropping a shard it has just acquired.
 *
 * Cluster treats every held shard missing from a lock refresh's answer as
 * lost, but it builds the refresh request from the shards it held when the
 * refresh started. A shard whose acquire commits in between is missing from
 * the answer without being lost, and Cluster reacquires it only on its next
 * entity poll. Each acquired shard is reported as held by its runner's
 * refreshes until one asks about it, which checks it for real, or until it is
 * released.
 */
export const keepAcquiredShards = (
  storage: RunnerStorage.RunnerStorage["Service"],
): RunnerStorage.RunnerStorage["Service"] => {
  const unchecked = new Map<string, Set<ShardId.ShardId>>()

  const of = (address: RunnerAddress.RunnerAddress) => {
    const key = PrimaryKey.value(address)
    const shards = unchecked.get(key) ?? new Set<ShardId.ShardId>()
    unchecked.set(key, shards)

    return shards
  }

  return {
    ...storage,
    acquire: (address, shardIds) =>
      storage.acquire(address, shardIds).pipe(
        Effect.tap((acquired) =>
          Effect.sync(() => {
            const shards = of(address)

            for (const shardId of acquired) shards.add(shardId)
          }),
        ),
      ),
    refresh: (address, shardIds) =>
      Effect.suspend(() => {
        const requested = Array.from(shardIds)
        const shards = of(address)

        for (const shardId of requested) shards.delete(shardId)

        return storage
          .refresh(address, requested)
          .pipe(
            Effect.map((held) => [
              ...held,
              ...Array.from(unchecked.get(PrimaryKey.value(address)) ?? []).filter(
                (shardId) => !requested.includes(shardId),
              ),
            ]),
          )
      }),
    release: (address, shardId) =>
      Effect.sync(() => of(address).delete(shardId)).pipe(
        Effect.andThen(storage.release(address, shardId)),
      ),
    releaseAll: (address) =>
      Effect.sync(() => {
        const key = PrimaryKey.value(address)

        unchecked.get(key)?.clear()
        unchecked.delete(key)
      }).pipe(Effect.andThen(storage.releaseAll(address))),
  }
}
