import { Clock, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import {
  Entity,
  MessageStorage,
  RunnerAddress,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  ShardId,
} from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { keepAcquiredShards } from "./locks.ts"

const Echo = Entity.make("Echo", [Rpc.make("Ping", { success: Schema.String })])

// Slow lock storage, as SQL round trips are on a loaded runner: the first
// refresh reads the held shards before the first acquire commits and answers
// after it, and releasing a lock outlasts the acquisition loop's next wake.
const slowRefresh = Layer.effect(
  RunnerStorage.RunnerStorage,
  Effect.map(RunnerStorage.makeMemory, (storage) =>
    keepAcquiredShards({
      ...storage,
      acquire: (address, shardIds) =>
        storage.acquire(address, shardIds).pipe(Effect.delay("100 millis")),
      refresh: (address, shardIds) =>
        storage.refresh(address, shardIds).pipe(
          Effect.map((held) => held.filter((shard) => Array.from(shardIds).includes(shard))),
          Effect.tap(() => Effect.sleep("500 millis")),
        ),
      release: (address, shardId) =>
        storage.release(address, shardId).pipe(Effect.delay("2 seconds")),
    }),
  ),
)

const EchoLive = Echo.toLayer(Effect.succeed({ Ping: () => Effect.succeed("pong") })).pipe(
  Layer.provideMerge(Sharding.layer.pipe(Layer.provide(Runners.layerNoop))),
  Layer.provideMerge(MessageStorage.layerNoop),
  Layer.provide([slowRefresh, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer({ shardsPerGroup: 1 })),
)

describe("shard locks", () => {
  it(
    "keeps a shard acquired while its first lock refresh is in flight",
    () =>
      Effect.gen(function* () {
        const client = yield* Echo.client.pipe(Effect.provideContext(yield* Layer.build(EchoLive)))
        // Past the first refresh's answer, when the shard would have been dropped.
        yield* Effect.sleep("1 second")
        const started = yield* Clock.currentTimeMillis

        expect(yield* client("first").Ping()).toBe("pong")
        // Unwrapped, Cluster drops the shard when the refresh answers and
        // reacquires it only on the next 10-second entity poll.
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000)
      }).pipe(Effect.scoped, Effect.runPromise),
    15_000,
  )

  // Lock storage that has lost every lock: an acquire succeeds, then no refresh finds it.
  const lostLocks = Effect.map(RunnerStorage.makeMemory, (storage) =>
    keepAcquiredShards({ ...storage, refresh: () => Effect.succeed([]) }),
  )

  const address = RunnerAddress.make("localhost", 34431)
  const shard = ShardId.make("default", 1)

  it("reports a shard lost once a refresh asks about it", () =>
    Effect.gen(function* () {
      const storage = yield* lostLocks
      yield* storage.acquire(address, [shard])

      expect(yield* storage.refresh(address, [])).toEqual([shard])
      expect(yield* storage.refresh(address, [shard])).toEqual([])
      expect(yield* storage.refresh(address, [])).toEqual([])
    }).pipe(Effect.runPromise))

  it("stops reporting a shard once it is released", () =>
    Effect.gen(function* () {
      const storage = yield* lostLocks
      yield* storage.acquire(address, [shard])
      yield* storage.release(address, shard)

      expect(yield* storage.refresh(address, [])).toEqual([])

      yield* storage.acquire(address, [shard])
      yield* storage.releaseAll(address)

      expect(yield* storage.refresh(address, [])).toEqual([])
    }).pipe(Effect.runPromise))

  it("reports a shard only to the runner that acquired it", () =>
    Effect.gen(function* () {
      const storage = yield* lostLocks
      const other = RunnerAddress.make("localhost", 34432)
      yield* storage.acquire(other, [shard])

      expect(yield* storage.refresh(address, [])).toEqual([])
      expect(yield* storage.refresh(other, [])).toEqual([shard])

      yield* storage.releaseAll(address)

      expect(yield* storage.refresh(other, [])).toEqual([shard])
    }).pipe(Effect.runPromise))
  it("stops reporting shards released while a refresh is in flight", () =>
    Effect.gen(function* () {
      const answered = yield* Deferred.make<void>()

      const storage = yield* Effect.map(RunnerStorage.makeMemory, (memory) =>
        keepAcquiredShards({
          ...memory,
          refresh: () => Deferred.await(answered).pipe(Effect.as([])),
        }),
      )

      yield* storage.acquire(address, [shard])

      const refresh = yield* Effect.forkChild(storage.refresh(address, []))
      yield* Effect.yieldNow
      yield* storage.releaseAll(address)
      yield* Deferred.succeed(answered, undefined)

      expect(yield* Fiber.join(refresh)).toEqual([])
    }).pipe(Effect.runPromise))
})
