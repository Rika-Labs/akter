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
  const inFlight = new Map<string, Set<Array<ShardId.ShardId>>>()

  return {
    ...storage,
    acquire: (address, shardIds) =>
      storage.acquire(address, shardIds).pipe(
        Effect.tap((acquired) =>
          Effect.sync(() => {
            for (const seen of inFlight.get(String(address)) ?? []) seen.push(...acquired)
          }),
        ),
      ),
    refresh: (address, shardIds) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const seen: Array<ShardId.ShardId> = []
          const key = String(address)
          const refreshes = inFlight.get(key) ?? new Set<Array<ShardId.ShardId>>()
          refreshes.add(seen)
          inFlight.set(key, refreshes)

          return { key, seen }
        }),
        ({ seen }) =>
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
        ({ key, seen }) =>
          Effect.sync(() => {
            const refreshes = inFlight.get(key)
            refreshes?.delete(seen)

            if (refreshes?.size === 0) inFlight.delete(key)
          }),
      ),
  }
}
