import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors } from "@durable-actors/core/runtime"
import { Console, Effect, Layer } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"
import { DatabaseLive } from "./database.ts"

const live = CounterLive.pipe(
  Layer.provideMerge(Actors.layer()),
  Layer.provide(DatabaseLive),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits")

  yield* Console.log(`visits: ${yield* counter.Increment(1)}`)
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
