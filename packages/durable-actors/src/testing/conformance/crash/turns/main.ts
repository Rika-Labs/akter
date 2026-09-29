import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"

const Increment = Actor.command("Increment", { input: Schema.Finite, output: Schema.Finite })

class Incremented extends Actor.Event<Incremented>()("Incremented", { count: Schema.Finite }) {}

const Counter = Actor.make("ProcessCounter", {
  key: Schema.String,
  events: [Incremented],
  state: Actor.state({ count: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})

const CounterLive = Counter.toLayer(
  Effect.succeed({
    Increment: Effect.fnUntraced(function* (amount: number) {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: turn.state.count + amount })
      yield* turn.emit(Incremented.make({ count: turn.state.count }))

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
    events: number
    state_bytes: Uint8Array
  }>`SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT count(*)::int FROM actor_events) AS events,
      (SELECT value FROM actor_state WHERE key = 'count') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        value: Schema.Finite,
        receipts: Schema.Int,
        events: Schema.Int,
        state: Schema.String,
      }),
    ),
  )({
    value,
    receipts: rows[0]!.receipts,
    events: rows[0]!.events,
    state: decompress(rows[0]!.state_bytes),
  })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
