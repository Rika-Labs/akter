import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

const entries = Actor.table(pgTable("crash_entries", { id: text("id").primaryKey() }))

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const Append = Actor.command("Append", {
  input: Schema.String,
  output: Schema.Int,
})

const AppendThenRefuse = Actor.command("AppendThenRefuse", {
  input: Schema.String,
  output: Schema.Int,
  errors: [Refused],
})

class Appended extends Actor.Event<Appended>()("Appended", { id: Schema.String }) {}

const Note = Actor.command("Note", { input: Schema.String })

const Reader = Actor.make("ProcessJournalReader", {
  key: Schema.String,
  api: {},
  internal: { Note },
})

const Journal = Actor.make("ProcessJournal", {
  key: Schema.String,
  tables: [entries],
  events: [Appended],
  api: { Append, AppendThenRefuse },
})

let handled = 0

let noted = 0

const append = Effect.fnUntraced(function* (id: string) {
  handled += 1
  const turn = yield* Journal.Turn
  yield* turn.rows(entries).insert({ id })
  yield* turn.emit(Appended.make({ id }))
  yield* (yield* Reader.intents("reader")).Note(id)
})

const JournalLive = Layer.mergeAll(
  Journal.toLayer(
    Effect.succeed({
      Append: Effect.fnUntraced(function* (id: string) {
        yield* append(id)

        return yield* (yield* Journal.Turn).rows(entries).count()
      }),
      AppendThenRefuse: Effect.fnUntraced(function* (id: string) {
        yield* append(id)

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

    const schema = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE IF NOT EXISTS crash_entries (routing_key bigint, tenant_id text,
          actor_id text, id text, PRIMARY KEY (routing_key, tenant_id, actor_id, id))`
      }),
    )

    return JournalLive.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(Layer.mergeAll(hooks, clock)))),
      Layer.provideMerge(schema),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const commandId = yield* Config.String("CRASH_COMMAND_ID")
  const refuse = (yield* Config.String("CRASH_COMMAND")) === "AppendThenRefuse"
  const journal = yield* Journal.get("crashed")

  const call = (refuse ? journal.AppendThenRefuse("entry") : journal.Append("entry")).pipe(
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

  const [counts] = yield* sql<{ receipts: number; rows: number; events: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts WHERE command <> 'Note') AS receipts,
      (SELECT count(*)::int FROM crash_entries) AS rows,
      (SELECT count(*)::int FROM actor_events) AS events`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        reply: Schema.String,
        handled: Schema.Int,
        noted: Schema.Int,
        receipts: Schema.Int,
        rows: Schema.Int,
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
