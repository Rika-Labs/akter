import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Console, Effect, Layer } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"

const live = CounterLive.pipe(
  Layer.provideMerge(Actors.layer()),
  Layer.provide(
    Layer.unwrap(Effect.map(Config.Redacted("DATABASE_URL"), (url) => Database.postgres({ url }))),
  ),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits")

  const increment = counter.Increment(1)
  const committed = yield* increment
  const replayed = yield* increment
  const snapshot = yield* counter.Checkpoint()
  yield* Console.log({ actor: counter.ref.id, committed, replayed, snapshot })
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
