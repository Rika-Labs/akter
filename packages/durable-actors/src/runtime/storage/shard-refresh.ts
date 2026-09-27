import { Effect } from "effect"
import type { RunnerStorage, ShardId } from "effect/unstable/cluster"

type Storage = RunnerStorage.RunnerStorage["Service"]

/**
 * Sharding releases every held shard that a lock refresh does not report,
 * including shards `acquire` took while that refresh was in flight. Those were
 * never part of the refresh, so report them as still held; the next refresh
 * verifies them against the database.
 */
export const reportShardsAcquiredDuringRefresh = (storage: Storage): Storage => {
  const inFlight = new Set<Array<ShardId.ShardId>>()

  return {
    ...storage,
    acquire: (address, shardIds) =>
      storage.acquire(address, shardIds).pipe(
        Effect.tap((acquired) =>
          Effect.sync(() => {
            for (const seen of inFlight) seen.push(...acquired)
          }),
        ),
      ),
    refresh: (address, shardIds) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const seen: Array<ShardId.ShardId> = []
          inFlight.add(seen)

          return seen
        }),
        (seen) =>
          storage
            .refresh(address, shardIds)
            .pipe(
              Effect.map((held) => [
                ...held,
                ...seen.filter(
                  (shardId, index) => !held.includes(shardId) && seen.indexOf(shardId) === index,
                ),
              ]),
            ),
        (seen) => Effect.sync(() => inFlight.delete(seen)),
      ),
  }
}
