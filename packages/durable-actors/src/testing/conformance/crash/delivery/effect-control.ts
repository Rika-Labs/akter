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

const Withdraw = Actor.command("Withdraw")

const Moderated = Actor.command("Moderated", { input: Schema.Struct({ flagged: Schema.Boolean }) })

const Withdrawn = Actor.command("Withdrawn", { input: Actor.Cancelled(Moderate) })

const Author = Actor.make("ProcessCanceller", {
  key: Schema.String,
  state: Actor.state({
    outcomes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  }),
  effects: [Moderate],
  api: { Post, Withdraw },
  internal: { Moderated, Withdrawn },
  policy: {
    effects: { Moderate: { retry: { times: 3 }, onSuccess: Moderated, onCancelled: Withdrawn } },
  },
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
            yield* (yield* Author.Turn).perform(Moderate.make({ body }), { key: "moderation" })
          }),
          Withdraw: Effect.fnUntraced(function* () {
            yield* (yield* Author.Turn).cancelEffect("moderation")
          }),
          Moderated: Effect.fnUntraced(function* () {
            const turn = yield* Author.Turn
            yield* turn.state.set({ outcomes: [...turn.state.outcomes, "Succeeded via onSuccess"] })
          }),
          Withdrawn: Effect.fnUntraced(function* ({ outcome, ambiguous }) {
            const turn = yield* Author.Turn
            yield* turn.state.set({
              outcomes: [...turn.state.outcomes, `${outcome._tag} ambiguous=${ambiguous}`],
            })
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

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && request.command === "Moderate"
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

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

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const sql = yield* SqlClient.SqlClient

  if (mode !== "recover") {
    yield* (yield* Author.get("author")).Post("spam")

    return yield* Effect.never
  }

  yield* (yield* Author.get("author")).Withdraw()

  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const rows = yield* sql<{
    receipts: number
    routed_id: string
    state_bytes: Uint8Array
  }>`SELECT (SELECT count(*)::int FROM actor_receipts
        WHERE command IN ('Moderated', 'Withdrawn')) AS receipts,
      (SELECT command_id FROM actor_receipts WHERE command = 'Withdrawn') AS routed_id,
      (SELECT value FROM actor_state WHERE actor_type = 'ProcessCanceller'
        AND key = 'outcomes') AS state_bytes`

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
