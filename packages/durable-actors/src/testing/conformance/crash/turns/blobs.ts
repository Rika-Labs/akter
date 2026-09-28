import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

const log = Actor.blob("log")

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

/** Appends one chunk and returns the entry's length as the turn reads it. */
const Append = Actor.command("Append", { input: Schema.String, output: Schema.Int })

const AppendThenRefuse = Actor.command("AppendThenRefuse", {
  input: Schema.String,
  output: Schema.Int,
  errors: [Refused],
})

class Appended extends Actor.Event<Appended>()("Appended", { text: Schema.String }) {}

const Note = Actor.command("Note", { input: Schema.String })

// Receives the intent each append stages, so recovery can show its later delivery.
const Reader = Actor.make("ProcessBlobReader", {
  key: Schema.String,
  api: {},
  internal: { Note },
})

const Journal = Actor.make("ProcessBlobJournal", {
  key: Schema.String,
  blobs: [log],
  events: [Appended],
  api: { Append, AppendThenRefuse },
})

// Counts handler runs in this process, so recovery can show a replay did not run it again.
let handled = 0

// Counts deliveries in this process, so recovery can show the intent reached its receiver once.
let noted = 0

// Appends the chunk and stages both notifications, so a crash or a declared
// failure has every consequence of the turn to keep or roll back together.
const append = Effect.fnUntraced(function* (text: string) {
  handled += 1
  const turn = yield* Journal.Turn
  yield* turn.blob(log).append("entry", new TextEncoder().encode(text))
  yield* turn.emit(Appended.make({ text }))
  yield* (yield* Reader.intents("reader")).Note(text)
})

const JournalLive = Layer.mergeAll(
  Journal.toLayer(
    Effect.succeed({
      Append: Effect.fnUntraced(function* (text: string) {
        yield* append(text)

        return Option.getOrThrow(yield* (yield* Journal.Turn).blob(log).get("entry")).byteLength
      }),
      AppendThenRefuse: Effect.fnUntraced(function* (text: string) {
        yield* append(text)

        return yield* Refused.make({})
      }),
    }),
  ),
  Reader.toLayer(
    Effect.succeed({
      Note: () =>
        Effect.sync(() => {
          noted += 1
        }),
    }),
  ),
)

const live = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    // The journal's turn stops at the crash point. The killed process's relay
    // may claim a committed intent but never runs its handler, so only
    // recovery can deliver it.
    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        mode === "recover"
          ? Effect.void
          : request.command === "Note"
            ? point === "beforeHandler"
              ? Effect.never
              : Effect.void
            : point === mode
              ? Console.log("READY").pipe(Effect.andThen(Effect.never))
              : Effect.void,
    })

    // The recovering process runs past a claim lease the killed relay may hold.
    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 60_000 : 0),
    })

    return JournalLive.pipe(
      Layer.provideMerge(
        Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(
          Layer.provide(Layer.mergeAll(hooks, clock)),
        ),
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

  // A committed intent is delivered after the reply; wait for the relay to settle it.
  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const [counts] = yield* sql<{ receipts: number; chunks: number; events: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts WHERE command <> 'Note') AS receipts,
      (SELECT count(*)::int FROM actor_blobs) AS chunks,
      (SELECT count(*)::int FROM actor_events) AS events`

  // Tagged so the parent ignores runtime logs that share stdout.
  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        reply: Schema.String,
        handled: Schema.Int,
        noted: Schema.Int,
        receipts: Schema.Int,
        chunks: Schema.Int,
        events: Schema.Int,
      }),
    ),
  )({ reply, handled, noted, ...counts! })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
