import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"

const log = Actor.blob("log")

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

/** Appends one chunk and returns the entry's length as the turn reads it. */
const Append = Actor.command("Append", { input: Schema.String, output: Schema.Int })

const AppendThenRefuse = Actor.command("AppendThenRefuse", {
  input: Schema.String,
  output: Schema.Int,
  errors: [Refused],
})

const Journal = Actor.make("ProcessBlobJournal", {
  key: Schema.String,
  blobs: [log],
  api: { Append, AppendThenRefuse },
})

// Counts handler runs in this process, so recovery can show a replay did not run it again.
let handled = 0

const JournalLive = Journal.toLayer(
  Effect.succeed({
    Append: Effect.fnUntraced(function* (text: string) {
      handled += 1
      const blob = (yield* Journal.Turn).blob(log)
      yield* blob.append("entry", new TextEncoder().encode(text))

      return Option.getOrThrow(yield* blob.get("entry")).byteLength
    }),
    AppendThenRefuse: Effect.fnUntraced(function* (text: string) {
      handled += 1
      yield* (yield* Journal.Turn).blob(log).append("entry", new TextEncoder().encode(text))

      return yield* Refused.make({})
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

    return JournalLive.pipe(
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
  const refuse = (yield* Config.String("CRASH_COMMAND")) === "AppendThenRefuse"
  const journal = yield* Journal.get("crashed")

  const call = (refuse ? journal.AppendThenRefuse("chunk") : journal.Append("chunk")).pipe(
    Actor.commandId(commandId),
  )

  if (mode !== "recover") {
    yield* call.pipe(Effect.ignore)

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  // The caller sees either the committed entry length or the declared failure.
  const reply = yield* call.pipe(
    Effect.map(String),
    Effect.catchTag("Refused", (error) => Effect.succeed(error._tag)),
  )

  const sql = yield* SqlClient.SqlClient

  const [counts] = yield* sql<{ receipts: number; chunks: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT count(*)::int FROM actor_blobs) AS chunks`

  // Tagged so the parent ignores runtime logs that share stdout.
  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        reply: Schema.String,
        handled: Schema.Int,
        receipts: Schema.Int,
        chunks: Schema.Int,
      }),
    ),
  )({ reply, handled, receipts: counts!.receipts, chunks: counts!.chunks })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
