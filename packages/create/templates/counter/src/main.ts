import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
import { Actors } from "@durable-actors/core/runtime"
import { Console, Effect, Layer, Schema } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"
import { DatabaseLive } from "./database.ts"

const live = CounterLive.pipe(
  Layer.provideMerge(
    Actors.layer({
      authorize: ({ caller, ref }) =>
        Effect.succeed(Schema.is(User)(caller) && ref.tenant === "quickstart"),
    }),
  ),
  Layer.provide(DatabaseLive),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits").pipe(
    Actor.tenant("quickstart"),
    Actor.as(User.make({ subject: "you" })),
  )

  yield* Console.log(`visits: ${yield* counter.Increment(1)}`)
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
