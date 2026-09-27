import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actor, User } from "durable-actors"
import { Actors, Database } from "durable-actors/runtime"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"

const live = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DATABASE_URL")

    return CounterLive.pipe(
      Layer.provideMerge(
        Actors.layer({
          authorize: ({ caller, ref }) =>
            Effect.succeed(
              Schema.is(User)(caller) &&
                caller.subject === "counter-demo" &&
                ref.tenant === "counter-demo",
            ),
        }),
      ),
      Layer.provide(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits").pipe(
    Actor.tenant("counter-demo"),
    Actor.as(User.make({ subject: "counter-demo" })),
  )

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
