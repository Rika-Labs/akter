import { Effect, PrimaryKey } from "effect"
import { type RunnerAddress, type RunnerStorage, type ShardId } from "effect/unstable/cluster"

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
              ...Array.from(shards).filter((shardId) => !requested.includes(shardId)),
            ]),
          )
      }),
    release: (address, shardId) =>
      Effect.sync(() => of(address).delete(shardId)).pipe(
        Effect.andThen(storage.release(address, shardId)),
      ),
    releaseAll: (address) =>
      Effect.sync(() => unchecked.delete(PrimaryKey.value(address))).pipe(
        Effect.andThen(storage.releaseAll(address)),
      ),
  }
}
