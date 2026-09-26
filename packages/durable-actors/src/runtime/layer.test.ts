import { Clock, Effect, Layer, Schema } from "effect"
import {
  Entity,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster"
import { Rpc } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"

const Echo = Entity.make("Echo", [Rpc.make("Ping", { success: Schema.String })])

// Slow lock storage, as SQL round trips are on a loaded runner: the first
// refresh reads the held shards before the first acquire commits and answers
// after it, and releasing a lock outlasts the acquisition loop's next wake.
const slowRefresh = Layer.effect(
  RunnerStorage.RunnerStorage,
  Effect.map(RunnerStorage.makeMemory, (storage) =>
    RunnerStorage.RunnerStorage.of({
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

describe("runtime sharding", () => {
  it(
    "keeps a shard acquired while its first lock refresh is in flight",
    () =>
      Effect.gen(function* () {
        const client = yield* Echo.client.pipe(Effect.provideContext(yield* Layer.build(EchoLive)))
        // Past the first refresh's answer, when the shard would have been dropped.
        yield* Effect.sleep("1 second")
        const started = yield* Clock.currentTimeMillis

        expect(yield* client("first").Ping()).toBe("pong")
        // Without the fix, Cluster drops the shard when the refresh answers and
        // reacquires it only on the next 10-second entity poll.
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5_000)
      }).pipe(Effect.scoped, Effect.runPromise),
    15_000,
  )
})
