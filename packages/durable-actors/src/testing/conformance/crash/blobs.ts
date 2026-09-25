import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

const log = Actor.blob("log")

/** Appends one chunk and returns the entry's length as the turn reads it. */
const Append = Actor.command("Append", { input: Schema.String, output: Schema.Int })

const Journal = Actor.make("ProcessBlobJournal", {
  key: Schema.String,
  blobs: [log],
  api: { Append },
})

const JournalLive = Journal.toLayer(
  Effect.succeed({
    Append: Effect.fnUntraced(function* (text: string) {
      const blob = (yield* Journal.Turn).blob(log)
      yield* blob.append("entry", new TextEncoder().encode(text))

      return Option.getOrThrow(yield* blob.get("entry")).byteLength
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
  const journal = yield* Journal.get("crashed")
  const call = journal.Append("chunk").pipe(Actor.commandId(commandId))

  if (mode !== "recover") {
    yield* call

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  const value = yield* call
  const sql = yield* SqlClient.SqlClient

  const [counts] = yield* sql<{ receipts: number; chunks: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT count(*)::int FROM actor_blobs) AS chunks`

  // Tagged so the parent ignores runtime logs that share stdout.
  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ value: Schema.Int, receipts: Schema.Int, chunks: Schema.Int }),
    ),
  )({ value, receipts: counts!.receipts, chunks: counts!.chunks })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
