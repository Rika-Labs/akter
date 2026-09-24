import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })

const Counter = Actor.make("ProcessCounter", {
  key: Schema.String,
  state: { count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  api: { Increment },
})

const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })

      return turn.state.count
    }),
  }),
)

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

// Commands are direct, so a crashed process leaves no pending message:
// recovery is the caller retrying its saved command id against a fresh process.
const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const commandId = yield* Config.String("CRASH_COMMAND_ID")
  const counter = yield* Counter.get("crashed")
  const call = counter.Increment(47).pipe(Actor.commandId(commandId))

  if (mode !== "recover") {
    yield* call

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  const value = yield* call
  const sql = yield* SqlClient.SqlClient

  const rows = yield* sql<{
    receipts: number
    state: string
  }>`SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT value::text FROM actor_state WHERE key = 'count') AS state`

  yield* Console.log(
    yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({ value: Schema.Finite, receipts: Schema.Int, state: Schema.String }),
      ),
    )({ value, receipts: rows[0]!.receipts, state: rows[0]!.state }),
  )
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
