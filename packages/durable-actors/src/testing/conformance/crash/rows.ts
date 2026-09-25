import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

const entries = Actor.table(pgTable("crash_entries", { id: text("id").primaryKey() }))

const Append = Actor.command("Append", { input: Schema.String, output: Schema.Int })

const Journal = Actor.make("ProcessJournal", {
  key: Schema.String,
  tables: [entries],
  api: { Append },
})

const JournalLive = Journal.toLayer(
  Effect.succeed({
    Append: Effect.fnUntraced(function* (id: string) {
      const rows = (yield* Journal.Turn).rows(entries)
      yield* rows.insert({ id })

      return yield* rows.count()
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

    // drizzle-kit's DDL for `entries`, applied before the actor registers.
    const schema = Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE IF NOT EXISTS crash_entries (routing_key bigint, tenant_id text,
          actor_id text, id text, PRIMARY KEY (routing_key, tenant_id, actor_id, id))`
      }),
    )

    return JournalLive.pipe(
      Layer.provideMerge(
        Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(Layer.provide(hooks)),
      ),
      Layer.provideMerge(schema),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

// The caller's retry with its saved command id is the only recovery path.
const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const commandId = yield* Config.String("CRASH_COMMAND_ID")
  const journal = yield* Journal.get("crashed")
  const call = journal.Append("entry").pipe(Actor.commandId(commandId))

  if (mode !== "recover") {
    yield* call

    return yield* Effect.die(new Error("Crash point was not reached"))
  }

  const value = yield* call
  const sql = yield* SqlClient.SqlClient

  const [counts] = yield* sql<{ receipts: number; rows: number }>`
    SELECT (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT count(*)::int FROM crash_entries) AS rows`

  // Tagged so the parent ignores runtime logs that share stdout.
  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ value: Schema.Int, receipts: Schema.Int, rows: Schema.Int }),
    ),
  )({ value, receipts: counts!.receipts, rows: counts!.rows })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
