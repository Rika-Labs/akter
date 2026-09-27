import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

class Moderate extends Actor.effect<Moderate>()("Moderate", {
  input: { body: Schema.String },
  success: Schema.Struct({ flagged: Schema.Boolean }),
}) {}

const Post = Actor.command("Post", { input: Schema.String })

const Moderated = Actor.command("Moderated", { input: Schema.Struct({ flagged: Schema.Boolean }) })

const Author = Actor.make("ProcessAuthor", {
  key: Schema.String,
  state: Actor.state({ flags: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  effects: [Moderate],
  api: { Post },
  internal: { Moderated },
  policy: { effects: { Moderate: { retry: { times: 3 }, onSuccess: Moderated } } },
})

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    // The fake provider is an idempotent ledger outside the framework: it
    // counts every call it receives under its idempotency key.
    const provider = new Pool({ connectionString: database, max: 1 })
    yield* Effect.addFinalizer(() => Effect.promise(() => provider.end()))

    const live = Layer.mergeAll(
      Author.toLayer(
        Effect.succeed({
          Post: Effect.fnUntraced(function* (body: string) {
            yield* (yield* Author.Turn).perform(Moderate.make({ body }))
          }),
          Moderated: Effect.fnUntraced(function* ({ flagged }) {
            const turn = yield* Author.Turn
            yield* turn.state.set({ flags: turn.state.flags + (flagged ? 1 : 0) })
          }),
        }),
      ),
      Author.toEffectLayer(
        Effect.succeed({
          Moderate: Effect.fnUntraced(function* ({ body }) {
            const exec = yield* Author.Executor
            yield* Effect.promise(() =>
              provider.query(
                `INSERT INTO provider_calls (idempotency_key, calls) VALUES ($1, 1)
                 ON CONFLICT (idempotency_key) DO UPDATE SET calls = provider_calls.calls + 1`,
                [exec.effectId],
              ),
            )

            return { flagged: body.includes("spam") }
          }),
        }),
      ),
    )

    // Only the effect's own steps and its route's delivery stop, so the
    // author's turn commits first.
    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && (request.command === "Moderate" || request.command === "Moderated")
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    // The recovering process runs past the crashed attempt's execution lease.
    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 120_000 : 0),
    })

    return live.pipe(
      Layer.provideMerge(
        Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(
          Layer.provide(Layer.mergeAll(hooks, clock)),
        ),
      ),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

// A crashed process leaves its committed effect in actor_outbox; a fresh
// process must settle it and deliver its route exactly once.
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

  // Tagged so the parent ignores runtime logs that share stdout.
  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
