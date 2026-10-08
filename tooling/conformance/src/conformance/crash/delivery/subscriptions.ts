import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Actor } from "../../../../../../packages/akter/src/index.ts"
import { Actors, Database } from "../../../../../../packages/akter/src/runtime/index.ts"
import { decompress } from "../../../../../../packages/akter/src/runtime/storage/codec.ts"
import { TurnHooks } from "../../../../../../packages/akter/src/runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../../../packages/akter/src/runtime/turn/admission.ts"

const Posted = Actor.event("Posted", { body: Schema.String })

const Post = Actor.command("Post", { payload: Schema.String })

const Source = Actor.make("ProcessSource", { key: Schema.String, events: [Posted], api: { Post } })

const Posts = Actor.Delivery({ source: Source, events: [Posted] })

const Record = Actor.command("Record", { payload: Posts })

const Followed = Actor.subscription("Followed", {
  delivery: Posts,

  handler: Record,
})

const Follow = Actor.command("Follow", { payload: Schema.String })

const Subscriber = Actor.make("ProcessSubscriber", {
  key: Schema.String,
  state: Actor.state({ seen: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Follow },
  internal: { Record },
  subscriptions: [Followed],
})

const live = Layer.mergeAll(
  Source.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* (body: string) {
        yield* (yield* Source.Turn).emit(Posted.make({ body }))
      }),
    }),
  ),
  Subscriber.toLayer(
    Effect.succeed({
      Follow: Effect.fnUntraced(function* (source: string) {
        yield* (yield* Subscriber.Turn).subscribe(Followed, source)
      }),
      Record: Effect.fnUntraced(function* () {
        const turn = yield* Subscriber.Turn
        yield* turn.state.set({ seen: turn.state.seen + 1 })
      }),
    }),
  ),
)

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && (request.command === "Record" || request.command === "Followed")
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 60_000 : 0),
    })

    return live.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(Layer.mergeAll(hooks, clock)))),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const sql = yield* SqlClient.SqlClient

  const row = sql<{ delivered: string; due: boolean }>`
    SELECT delivered::text AS delivered, due_at_ms IS NOT NULL AS due FROM actor_subscriptions`

  if (mode !== "recover") {
    yield* (yield* Subscriber.get("subscriber")).Follow("source")

    while ((yield* row).length === 0) yield* Effect.sleep("50 millis")

    yield* (yield* Source.get("source")).Post("hello")

    return yield* Effect.never
  }

  for (;;) {
    const [current] = yield* row

    if (current?.delivered === "1" && !current.due) break
    yield* Effect.sleep("100 millis")
  }

  const rows = yield* sql<{
    receipts: number
    state_bytes: Uint8Array
  }>`SELECT (SELECT count(*)::int FROM actor_receipts WHERE command = 'Record') AS receipts,
      (SELECT value FROM actor_state WHERE actor_type = 'ProcessSubscriber' AND key = 'seen') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ receipts: Schema.Int, state: Schema.String })),
  )({ receipts: rows[0]!.receipts, state: decompress(rows[0]!.state_bytes) })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
