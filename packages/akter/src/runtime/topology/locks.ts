import { Context, Duration, Effect, HashRing, Option, PrimaryKey } from "effect"
import {
  type RunnerAddress,
  type RunnerStorage,
  type Runner,
  ShardId,
  ShardingConfig,
  SqlRunnerStorage,
} from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Coordination, withMigrationCoordination } from "../database/coordination.ts"
import { ResumeEpoch } from "../database/resume.ts"

/** Creating Cluster's default tables under startup coordination prevents concurrent CREATE races. */
const prepareRunnerStorage = Effect.gen(function* () {
  const config = yield* ShardingConfig.ShardingConfig
  yield* withMigrationCoordination({
    effect: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE IF NOT EXISTS cluster_runners (
        machine_id SERIAL PRIMARY KEY,
        address VARCHAR(255) NOT NULL,
        runner TEXT NOT NULL,
        healthy BOOLEAN NOT NULL DEFAULT TRUE,
        last_heartbeat TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(address)
      )`
      if (config.shardLockDisableAdvisory)
        yield* sql`CREATE TABLE IF NOT EXISTS cluster_locks (
          shard_id VARCHAR(50) PRIMARY KEY,
          address VARCHAR(255) NOT NULL,
          acquired_at TIMESTAMP NOT NULL
        )`
    }),
  })
})

/**
 * Builds Cluster registrations and lock storage on the deployment's
 * coordination database, or the data database when none is designated.
 */
export const coordinatedRunnerStorage = Effect.gen(function* () {
  const sql = (yield* Coordination) ?? (yield* SqlClient.SqlClient)
  return yield* prepareRunnerStorage.pipe(
    Effect.andThen(SqlRunnerStorage.make({})),
    Effect.provideService(SqlClient.SqlClient, sql),
  )
})

/** Reopens readiness only after the new socket epoch owns its currently assigned shards in storage. */
export const recoveringRunnerStorage = Effect.fnUntraced(function* (
  storage: RunnerStorage.RunnerStorage["Service"],
) {
  const resume = yield* Effect.serviceOption(ResumeEpoch)
  if (Option.isNone(resume)) return storage
  const config = yield* ShardingConfig.ShardingConfig
  const registered = new Map<string, Runner.Runner>()
  let epoch = resume.value.check()
  let revision = 0
  const held = new Map<string, Map<string, number>>()
  const check = () => {
    const current = resume.value.check()
    if (current !== epoch) {
      held.clear()
      epoch = current
    }
    return current
  }
  const of = (address: RunnerAddress.RunnerAddress) => {
    const key = PrimaryKey.value(address)
    const shards = held.get(key) ?? new Map<string, number>()
    held.set(key, shards)
    return shards
  }
  yield* resume.value.recover(
    Effect.gen(function* () {
      check()
      if (registered.size === 0) return false
      for (const [key, runner] of registered) {
        yield* storage.refresh(runner.address, [])
        const runners = yield* storage.getRunners
        if (
          !runners.some(
            ([candidate, healthy]) => healthy && PrimaryKey.value(candidate.address) === key,
          )
        )
          return false
        const expected: Array<ShardId.ShardId> = []
        for (const group of config.assignedShardGroups) {
          const ring = HashRing.make<RunnerAddress.RunnerAddress>()
          for (const [candidate, healthy] of runners)
            if (healthy && candidate.groups.includes(group))
              HashRing.add(ring, candidate.address, { weight: candidate.weight })
          const assignments = HashRing.getShards(ring, config.shardsPerGroup)
          if (assignments === undefined) return false
          for (const [index, address] of assignments.entries())
            if (PrimaryKey.value(address) === key) expected.push(ShardId.make(group, index + 1))
        }
        if (!expected.every((shard) => held.get(key)?.has(PrimaryKey.value(shard)))) return false
      }
      return true
    }),
  )
  return {
    ...storage,
    register: (runner: Runner.Runner, healthy: boolean) =>
      storage
        .register(runner, healthy)
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => registered.set(PrimaryKey.value(runner.address), runner)),
          ),
        ),
    unregister: (address: RunnerAddress.RunnerAddress) =>
      storage.unregister(address).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const key = PrimaryKey.value(address)
            registered.delete(key)
            held.delete(key)
          }),
        ),
      ),
    acquire: (address: RunnerAddress.RunnerAddress, shards: Iterable<ShardId.ShardId>) =>
      Effect.suspend(() => {
        const started = check()
        return storage.acquire(address, shards).pipe(
          Effect.map((acquired) => {
            if (started !== check()) return acquired
            const owned = of(address)
            for (const shard of acquired) owned.set(PrimaryKey.value(shard), ++revision)
            return acquired
          }),
        )
      }),
    refresh: (address: RunnerAddress.RunnerAddress, shardIds: Iterable<ShardId.ShardId>) =>
      Effect.suspend(() => {
        const shards = Array.from(shardIds)
        const started = check()
        const owned = of(address)
        const proven =
          epoch === 0 ? shards : shards.filter((shard) => owned.has(PrimaryKey.value(shard)))
        const before = new Map(
          proven.map((shard) => [PrimaryKey.value(shard), owned.get(PrimaryKey.value(shard))]),
        )
        return storage.refresh(address, proven).pipe(
          Effect.map((refreshed) => {
            if (started !== check()) return refreshed
            const live = of(address)
            const returned = new Set(refreshed.map(PrimaryKey.value))
            for (const [key, version] of before)
              if (!returned.has(key) && live.get(key) === version) live.delete(key)
            return refreshed
          }),
        )
      }),
    release: (address: RunnerAddress.RunnerAddress, shard: ShardId.ShardId) =>
      Effect.sync(() => of(address).delete(PrimaryKey.value(shard))).pipe(
        Effect.andThen(storage.release(address, shard)),
      ),
    releaseAll: (address: RunnerAddress.RunnerAddress) =>
      Effect.sync(() => held.delete(PrimaryKey.value(address))).pipe(
        Effect.andThen(storage.releaseAll(address)),
      ),
  }
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
export const keepAcquiredShards = ({
  storage,
  resume,
}: {
  readonly storage: RunnerStorage.RunnerStorage["Service"]
  readonly resume?: ResumeEpoch["Service"]
}): RunnerStorage.RunnerStorage["Service"] => {
  const unchecked = new Map<string, Set<ShardId.ShardId>>()
  let epoch = resume?.check() ?? 0
  const check = () => {
    const now = resume?.check() ?? 0
    if (now !== epoch) {
      unchecked.clear()
      epoch = now
    }
  }

  const of = (address: RunnerAddress.RunnerAddress) => {
    const key = PrimaryKey.value(address)
    const shards = unchecked.get(key) ?? new Set<ShardId.ShardId>()
    unchecked.set(key, shards)

    return shards
  }

  return {
    ...storage,
    acquire: (address, shardIds) =>
      Effect.suspend(() => {
        check()
        const started = epoch
        return storage.acquire(address, shardIds).pipe(
          Effect.map((acquired) => {
            check()
            if (started !== epoch) return acquired
            const shards = of(address)
            for (const shardId of acquired) shards.add(shardId)
            return acquired
          }),
        )
      }),
    refresh: (address, shardIds) =>
      Effect.suspend(() => {
        check()
        const started = epoch
        const requested = Array.from(shardIds)
        const shards = of(address)

        for (const shardId of requested) shards.delete(shardId)

        return storage.refresh(address, requested).pipe(
          Effect.map((held) => {
            check()
            if (started !== epoch) return held
            return [
              ...held,
              ...Array.from(unchecked.get(PrimaryKey.value(address)) ?? []).filter(
                (shardId) => !requested.includes(shardId),
              ),
            ]
          }),
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
