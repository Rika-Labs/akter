import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

const log = Actor.blob("log")

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

/** Appends one chunk and returns the entry's length as the turn reads it. */
const Append = Actor.command("Append", { payload: Schema.String, success: Schema.Int })

const AppendThenRefuse = Actor.command("AppendThenRefuse", {
  payload: Schema.String,
  success: Schema.Int,
  error: Refused,
})

const Appended = Actor.event("Appended", { text: Schema.String })

const Note = Actor.command("Note", { payload: Schema.String })

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

let handled = 0

let noted = 0

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

    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 60_000 : 0),
    })

    return JournalLive.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(Layer.mergeAll(hooks, clock)))),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

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

  const reply = yield* call.pipe(
    Effect.map(String),
    Effect.catchTag("Refused", (error) => Effect.succeed(error._tag)),
  )

  const sql = yield* SqlClient.SqlClient

  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const [counts] = yield* sql<{ receipts: number; chunks: number; events: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts WHERE command <> 'Note') AS receipts,
      (SELECT count(*)::int FROM actor_blobs) AS chunks,
      (SELECT count(*)::int FROM actor_events) AS events`

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
