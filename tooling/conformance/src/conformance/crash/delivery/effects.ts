import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { Actor } from "../../../../../../packages/akter/src/index.ts"
import { Actors, Database } from "../../../../../../packages/akter/src/runtime/index.ts"
import { decompress } from "../../../../../../packages/akter/src/runtime/storage/codec.ts"
import { TurnHooks } from "../../../../../../packages/akter/src/runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../../../packages/akter/src/runtime/turn/admission.ts"

const Moderate = Actor.job("Moderate", {
  payload: { body: Schema.String },
  success: Schema.Struct({ flagged: Schema.Boolean }),
})

const Post = Actor.command("Post", { payload: Schema.String })

const Moderated = Actor.command("Moderated", {
  payload: Schema.Struct({ flagged: Schema.Boolean }),
})

const Author = Actor.make("ProcessAuthor", {
  key: Schema.String,
  state: Actor.state({ flags: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  jobs: { Moderate: { job: Moderate, retry: { times: 3 }, onSuccess: Moderated } },
  api: { Post },
  internal: { Moderated },
})

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    const provider = new Pool({ connectionString: database, max: 1 })
    yield* Effect.addFinalizer(() => Effect.promise(() => provider.end()))

    const live = Layer.mergeAll(
      Author.toLayer(
        Effect.succeed({
          Post: Effect.fnUntraced(function* (body: string) {
            yield* (yield* Author.Turn).enqueue(Moderate.make({ body }))
          }),
          Moderated: Effect.fnUntraced(function* ({ flagged }) {
            const turn = yield* Author.Turn
            yield* turn.state.set({ flags: turn.state.flags + (flagged ? 1 : 0) })
          }),
        }),
      ),
      Author.toJobLayer(
        Effect.succeed({
          Moderate: Effect.fnUntraced(function* ({ body }) {
            const exec = yield* Author.Executor
            yield* Effect.promise(() =>
              provider.query(
                `INSERT INTO provider_calls (idempotency_key, calls) VALUES ($1, 1)
                 ON CONFLICT (idempotency_key) DO UPDATE SET calls = provider_calls.calls + 1`,
                [exec.jobId],
              ),
            )

            return { flagged: body.includes("spam") }
          }),
        }),
      ),
    )

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && (request.command === "Moderate" || request.command === "Moderated")
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 120_000 : 0),
    })

    return live.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(Layer.mergeAll(hooks, clock)))),
      Layer.provideMerge(
        Database.postgres({ url: Redacted.make(database), preset: "low-connection" }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const sql = yield* SqlClient.SqlClient

  if (mode !== "recover") {
    yield* (yield* Author.get("author")).Post("spam")

    return yield* Effect.never
  }

  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const rows = yield* sql<{
    receipts: number
    routed_id: string
    state_bytes: Uint8Array
  }>`SELECT (SELECT count(*)::int FROM actor_receipts WHERE command = 'Moderated') AS receipts,
      (SELECT command_id FROM actor_receipts WHERE command = 'Moderated') AS routed_id,
      (SELECT value FROM actor_state WHERE actor_type = 'ProcessAuthor' AND key = 'flags') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ receipts: Schema.Int, routedId: Schema.String, state: Schema.String }),
    ),
  )({
    receipts: rows[0]!.receipts,
    routedId: rows[0]!.routed_id,
    state: decompress(rows[0]!.state_bytes),
  })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
