import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Result, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { decompress } from "../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

class Overflow extends Schema.TaggedError<Overflow>()("Overflow", {
  max: Schema.Int,
}) {}

const TallyState = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

// Counts `reduce` calls in this process, so recovery can show a replay did not reduce again.
let reductions = 0

const Add = Actor.reducer("Add", {
  state: TallyState,
  input: Schema.Int,
  errors: [Overflow],
  reduce: (state, amount) => {
    reductions += 1

    return state.count + amount > 100
      ? Result.fail(Overflow.make({ max: 100 }))
      : Result.succeed({ count: state.count + amount })
  },
})

const Tally = Actor.make("ProcessTally", {
  key: Schema.String,
  state: TallyState,
  api: { Add },
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    const hooks = Layer.succeed(TurnHooks, {
      at: (point) =>
        point === mode ? Console.log("READY").pipe(Effect.andThen(Effect.never)) : Effect.void,
    })

    return Tally.toLayer(Effect.succeed({})).pipe(
      Layer.provideMerge(
        Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(Layer.provide(hooks)),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

// The caller's retry with its saved command id is the only recovery path.
const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const commandId = yield* Config.String("CRASH_COMMAND_ID")
  const amount = yield* Config.Int("CRASH_AMOUNT")
  const tally = yield* Tally.get("crashed")
  const call = tally.Add(amount).pipe(Actor.commandId(commandId))

  if (mode !== "recover") {
    yield* call.pipe(Effect.ignore)

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  // The caller sees either the committed state or the declared failure.
  const reply = yield* call.pipe(
    Effect.map(({ count }) => String(count)),
    Effect.catchTag("Overflow", (error) => Effect.succeed(error._tag)),
  )

  const sql = yield* SqlClient.SqlClient

  const [rows] = yield* sql<{
    receipts: number
    state_bytes: Uint8Array | null
  }>`
    SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT value FROM actor_state WHERE key = 'count') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        reply: Schema.String,
        reductions: Schema.Int,
        receipts: Schema.Int,
        state: Schema.NullOr(Schema.String),
      }),
    ),
  )({
    reply,
    reductions,
    receipts: rows!.receipts,
    state: rows!.state_bytes === null ? null : decompress(rows!.state_bytes),
  })

  // Tagged so the parent ignores runtime logs that share stdout.
  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
