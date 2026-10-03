import { Context, Duration, Effect, PrimaryKey } from "effect"
import {
  type RunnerAddress,
  type RunnerStorage,
  type ShardId,
  SqlRunnerStorage,
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Coordination } from "../database/coordination.ts"

/** Builds Cluster registrations and lock storage on the deployment's authority, never on a runner's data shard. */
export const coordinatedRunnerStorage = Effect.gen(function* () {
  const sql = (yield* Coordination) ?? (yield* SqlClient.SqlClient)
  return yield* SqlRunnerStorage.make({}).pipe(Effect.provideService(SqlClient.SqlClient, sql))
})

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
