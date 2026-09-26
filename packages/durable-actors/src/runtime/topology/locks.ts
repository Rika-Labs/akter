import { Effect } from "effect"
import { type RunnerStorage, type ShardId } from "effect/unstable/cluster"

/**
 * Keeps Cluster from dropping a shard it has just acquired.
 *
 * Cluster treats every held shard missing from a lock refresh's answer as
 * lost, but it builds the refresh request from the shards it held when the
 * refresh started. A shard whose acquire commits in between is missing from
 * the answer without being lost, and Cluster reacquires it only on its next
 * entity poll. Each acquired shard is reported as held until a refresh asks
 * about it, which checks it for real, or until it is released.
 */
export const keepAcquiredShards = (
  storage: RunnerStorage.RunnerStorage["Service"],
): RunnerStorage.RunnerStorage["Service"] => {
  const unchecked = new Set<ShardId.ShardId>()

  return {
    ...storage,
    acquire: (address, shardIds) =>
      storage.acquire(address, shardIds).pipe(
        Effect.tap((acquired) =>
          Effect.sync(() => {
            for (const shardId of acquired) unchecked.add(shardId)
          }),
        ),
      ),
    refresh: (address, shardIds) =>
      Effect.suspend(() => {
        const requested = Array.from(shardIds)

        for (const shardId of requested) unchecked.delete(shardId)

        return storage
          .refresh(address, requested)
          .pipe(
            Effect.map((held) => [
              ...held,
              ...Array.from(unchecked).filter((shardId) => !requested.includes(shardId)),
            ]),
          )
      }),
    release: (address, shardId) =>
      Effect.sync(() => unchecked.delete(shardId)).pipe(
        Effect.andThen(storage.release(address, shardId)),
      ),
    releaseAll: (address) =>
      Effect.sync(() => unchecked.clear()).pipe(Effect.andThen(storage.releaseAll(address))),
  }
}
