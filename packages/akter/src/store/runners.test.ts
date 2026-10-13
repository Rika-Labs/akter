import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Duration, Effect, Fiber, Option, Result, Schema } from "effect"
import * as Runner from "effect/cluster/Runner"
import * as RunnerAddress from "effect/cluster/RunnerAddress"
import * as ShardId from "effect/cluster/ShardId"
import * as ShardingConfig from "effect/cluster/ShardingConfig"
import { TestClock } from "effect/testing"
import { StorageUnavailable } from "./errors.ts"
import { memoryBucket } from "./memory.ts"
import { runnerDefaults, runnerStorage } from "./runners.ts"
import { Store, storeOf } from "./service.ts"

const first = Runner.make({
  address: RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 23001 }),
  groups: ["default"],
  weight: 1,
})
const second = Runner.make({
  address: RunnerAddress.RunnerAddress.make({ host: "127.0.0.1", port: 23002 }),
  groups: ["default"],
  weight: 1,
})
const shard = ShardId.make("default", 1)
const storageFor = (store: Store["Service"]) =>
  runnerStorage.pipe(
    Effect.provideService(Store, store),
    Effect.provideService(ShardingConfig.ShardingConfig, {
      ...ShardingConfig.defaults,
      ...runnerDefaults,
    }),
  )

describe("bucket runner liveness", () => {
  it.effect(
    "rejects default heartbeat write rates that expire a live owner between refreshes",
    () =>
      Effect.gen(function* () {
        const raw = yield* storeOf(memoryBucket(), { shards: 1 })
        const written: Array<number> = []
        const store = Store.of({
          ...raw,
          leases: {
            ...raw.leases,
            write: (key, body) =>
              Effect.gen(function* () {
                if (key === "cluster/beats/127.0.0.1%3A23001")
                  written.push(Number((yield* Clock.monotonicTimeNanos) / 1_000_000n))
                return yield* raw.leases.write(key, body)
              }),
          },
        })
        const a = yield* storageFor(store)
        const b = yield* storageFor(raw)
        yield* a.register(first, true)
        yield* a.acquire(first.address, [shard])
        yield* b.register(second, true)
        const effective = Math.ceil(
          Math.min(
            Duration.toMillis(runnerDefaults.shardLockExpiration) / 3,
            Duration.toMillis(runnerDefaults.shardLockRefreshInterval),
          ),
        )
        for (let refresh = 0; refresh < 8; refresh++) {
          yield* TestClock.adjust(effective)
          expect(yield* a.refresh(first.address, [shard])).toEqual([shard])
          expect((yield* b.getRunners).map(([runner]) => runner.address)).toContainEqual(
            first.address,
          )
          expect(yield* b.acquire(second.address, [shard])).toEqual([])
        }
        expect(written).toEqual([0, 2000, 4000, 6000, 8000])
      }),
  )

  it.effect("rejects wall-clock expiry and takeover before an unchanged ETag has expired", () =>
    Effect.gen(function* () {
      const store = yield* storeOf(memoryBucket(), { shards: 1 })
      const a = yield* storageFor(store)
      const b = yield* storageFor(store)
      yield* a.register(first, true)
      expect(yield* a.acquire(first.address, [shard])).toEqual([shard])
      yield* b.register(second, true)
      expect(yield* b.getRunners).toHaveLength(2)
      const base = yield* Clock.clockWith(Effect.succeed)
      const skewed: Clock.Clock = {
        currentTimeMillis: Effect.succeed(-9_000_000_000_000),
        currentTimeMillisUnsafe: () => -9_000_000_000_000,
        currentTimeNanos: Effect.succeed(-9_000_000_000_000_000_000n),
        currentTimeNanosUnsafe: () => -9_000_000_000_000_000_000n,
        monotonicTimeNanos: base.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
        sleep: (duration) => base.sleep(duration),
      }
      yield* TestClock.adjust(2999)
      expect(
        yield* b.acquire(second.address, [shard]).pipe(Effect.provideService(Clock.Clock, skewed)),
      ).toEqual([])
      expect(yield* b.getRunners).toHaveLength(2)
      yield* TestClock.adjust(1)
      expect(yield* b.getRunners).toEqual([])
      expect(yield* b.acquire(second.address, [shard])).toEqual([shard])
      expect(yield* a.refresh(first.address, [shard])).toEqual([])
    }),
  )

  it.effect("rejects takeover from an expired cached ETag when the live owner has refreshed", () =>
    Effect.gen(function* () {
      const store = yield* storeOf(memoryBucket(), { shards: 1 })
      const a = yield* storageFor(store)
      const b = yield* storageFor(store)
      yield* a.register(first, true)
      yield* a.acquire(first.address, [shard])
      yield* b.register(second, true)
      yield* TestClock.adjust(3000)
      yield* a.refresh(first.address, [shard])
      yield* TestClock.adjust(1000)
      expect(yield* b.acquire(second.address, [shard])).toEqual([])
      yield* TestClock.adjust(2999)
      expect(yield* b.acquire(second.address, [shard])).toEqual([])
      yield* TestClock.adjust(1)
      expect(yield* b.acquire(second.address, [shard])).toEqual([shard])
    }),
  )

  it.effect("rejects heartbeat bursts from concurrent refresh and re-registration", () =>
    Effect.gen(function* () {
      const raw = yield* storeOf(memoryBucket(), { shards: 1 })
      const written: Array<number> = []
      let hold = false
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const store = Store.of({
        ...raw,
        leases: {
          ...raw.leases,
          write: (key, body) =>
            Effect.gen(function* () {
              if (key.startsWith("cluster/beats/")) {
                written.push(Number((yield* Clock.monotonicTimeNanos) / 1_000_000n))
                if (hold) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                }
              }
              return yield* raw.leases.write(key, body)
            }),
        },
      })
      const storage = yield* storageFor(store)
      yield* storage.register(first, true)
      yield* TestClock.adjust(1499)
      yield* storage.refresh(first.address, [])
      expect(written).toEqual([0])
      yield* TestClock.adjust(1)
      hold = true
      const refresh = yield* Effect.forkChild(
        Effect.forEach([0, 1, 2], () => storage.refresh(first.address, []), {
          concurrency: "unbounded",
        }),
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust(100)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(refresh)
      yield* storage.register(first, true)
      yield* TestClock.adjust(1499)
      yield* storage.refresh(first.address, [])
      expect(written).toEqual([0, 1500])
      yield* TestClock.adjust(1)
      yield* storage.refresh(first.address, [])
      expect(written).toEqual([0, 1500, 3100])
    }),
  )

  it.effect("rejects losing the held ETag after a failed release instead of retrying its CAS", () =>
    Effect.gen(function* () {
      const raw = yield* storeOf(memoryBucket(), { shards: 1 })
      let denied = true
      const store = Store.of({
        ...raw,
        leases: {
          ...raw.leases,
          replace: (key, body, etag) =>
            Effect.suspend(() =>
              denied && key.startsWith("cluster/locks/")
                ? Effect.fail(
                    StorageUnavailable.make({
                      operation: "lease.write",
                      key,
                      reason: "release denied",
                    }),
                  )
                : raw.leases.replace(key, body, etag),
            ),
        },
      })
      const a = yield* storageFor(store)
      const b = yield* storageFor(raw)
      yield* a.register(first, true)
      yield* a.acquire(first.address, [shard])
      yield* b.register(second, true)
      expect(Result.isFailure(yield* Effect.result(a.release(first.address, shard)))).toBe(true)
      expect(yield* b.acquire(second.address, [shard])).toEqual([])
      denied = false
      yield* a.release(first.address, shard)
      expect(yield* b.acquire(second.address, [shard])).toEqual([shard])
      const lock = Option.getOrThrow(yield* raw.leases.read("cluster/locks/default%3A1"))
      const owner = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ address: Schema.NullOr(Schema.String) })),
      )(new TextDecoder().decode(lock.body))
      expect(owner.address).toBe("127.0.0.1:23002")
      expect(Duration.toMillis(runnerDefaults.shardLockExpiration)).toBe(3000)
    }),
  )
})
