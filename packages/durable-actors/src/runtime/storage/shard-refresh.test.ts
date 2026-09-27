import { Deferred, Effect, Fiber } from "effect"
import { RunnerAddress, RunnerStorage, ShardId } from "effect/unstable/cluster"
import { expect, it } from "vitest"
import { reportShardsAcquiredDuringRefresh } from "./shard-refresh.ts"

const address = RunnerAddress.make("localhost", 34431)

const otherAddress = RunnerAddress.make("localhost", 34432)

const shard = ShardId.make("default", 1)

it("reports shards acquired while a lock refresh was in flight as held", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* RunnerStorage.makeMemory
      const started = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<Array<ShardId.ShardId>>()

      const storage = reportShardsAcquiredDuringRefresh({
        ...memory,
        refresh: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      })

      const refresh = yield* storage.refresh(address, []).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* storage.acquire(address, [shard])).toEqual([shard])
      yield* Deferred.succeed(answer, [])
      expect(yield* Fiber.join(refresh)).toEqual([shard])

      expect(yield* storage.refresh(address, [])).toEqual([])
    }).pipe(Effect.scoped),
  ))

it("does not report another runner's acquired shards to this refresh", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* RunnerStorage.makeMemory
      const started = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<Array<ShardId.ShardId>>()

      const storage = reportShardsAcquiredDuringRefresh({
        ...memory,
        refresh: (refreshAddress) =>
          refreshAddress === address
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer)))
            : Effect.succeed([]),
      })

      const refresh = yield* storage.refresh(address, []).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(yield* storage.acquire(otherAddress, [shard])).toEqual([shard])
      yield* Deferred.succeed(answer, [])
      expect(yield* Fiber.join(refresh)).toEqual([])
    }).pipe(Effect.scoped),
  ))
