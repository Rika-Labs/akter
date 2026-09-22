import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

const Counter = Actor.make("ProcessCounter", {
  id: Schema.String,
  commands: [Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })],
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
})

const CounterLive = Counter.toLayer({
  Increment: Effect.fnUntraced(function* (ctx, amount) {
    yield* ctx.state.set({ count: ctx.state.count + amount })

    return ctx.state.count
  }),
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    const hooks = Layer.succeed(TurnHooks, {
      at: (point) =>
        point === mode ? Console.log("READY").pipe(Effect.andThen(Effect.never)) : Effect.void,
    })

    return CounterLive.pipe(
      Layer.provideMerge(
        Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(Layer.provide(hooks)),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")

  if (mode !== "recover") {
    const counter = yield* Counter.get("crashed")
    yield* counter.Increment(47)

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  const sql = yield* SqlClient.SqlClient

  // Recovery must discover the persisted envelope without another external command.
  const recovered = yield* sql<{
    outcome: string
  }>`SELECT outcome FROM actor_receipts WHERE EXISTS (SELECT 1 FROM cluster_messages WHERE processed = true)`.pipe(
    Effect.repeat({ while: (rows) => rows.length === 0, schedule: Schedule.spaced("50 millis") }),
  )

  const state = yield* sql<{
    value: string
  }>`SELECT value::text AS value FROM actor_state WHERE key = 'count'`

  yield* Console.log(
    yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Struct({ receipts: Schema.Int, state: Schema.String })),
    )({ receipts: recovered.length, state: state[0]!.value }),
  )
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
