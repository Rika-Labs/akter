import { Deferred, Effect, Layer, Schema } from "effect"
import { Runners, Sharding, type ShardId } from "effect/unstable/cluster"
import { Actor } from "../../../index.ts"
import { RunnerWiring } from "../../../runtime/layer.ts"

const Ping = Actor.command("Ping", { input: Schema.String, output: Schema.String })

export const Echo = Actor.make("ShardRefreshEcho", { key: Schema.String, api: { Ping } })

export const EchoLive = Echo.toLayer(
  Effect.succeed({ Ping: (input: string) => Effect.succeed(input) }),
)

const label = (shard: ShardId.ShardId) => `${shard.group}:${shard.id}`

/**
 * Runner wiring whose first shard-lock refresh reaches storage only after the
 * first acquire has returned, so its answer predates the shard it will see held.
 * Records every refresh request and every release.
 */
export const lateFirstRefresh = Effect.gen(function* () {
  const acquired = yield* Deferred.make<void>()
  const refreshed: Array<ReadonlyArray<string>> = []
  const released: Array<string> = []

  const layer = Layer.succeed(RunnerWiring, {
    config: {},
    sharding: Sharding.layer.pipe(Layer.provide(Runners.layerNoop)),
    storage: (inner) => ({
      ...inner,
      acquire: (address, shardIds) =>
        inner
          .acquire(address, shardIds)
          .pipe(
            Effect.tap((shards) =>
              shards.length > 0 ? Deferred.succeed(acquired, undefined) : Effect.void,
            ),
          ),
      refresh: (address, shardIds) =>
        Effect.suspend(() => {
          const first = refreshed.length === 0
          refreshed.push(Array.from(shardIds, label))

          return first
            ? Deferred.await(acquired).pipe(Effect.andThen(inner.refresh(address, shardIds)))
            : inner.refresh(address, shardIds)
        }),
      release: (address, shardId) =>
        Effect.sync(() => released.push(label(shardId))).pipe(
          Effect.andThen(inner.release(address, shardId)),
        ),
    }),
  })

  return { layer, refreshed, released }
})
