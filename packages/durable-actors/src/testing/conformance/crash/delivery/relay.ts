import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { OutboxClock } from "../../../../runtime/turn/outbox.ts"

const Add = Actor.command("Add", { input: Schema.Finite })

const Touch = Actor.command("Touch")

const Receiver = Actor.make("ProcessReceiver", {
  key: Schema.String,
  state: Actor.state({ total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Touch },
  internal: { Add },
})

const Send = Actor.command("Send", { input: Schema.Finite })

const Sender = Actor.make("ProcessSender", { key: Schema.String, api: { Send } })

const live = Layer.mergeAll(
  Receiver.toLayer(
    Effect.succeed({
      Touch: () => Effect.void,
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Receiver.Turn
        yield* turn.state.set({ total: turn.state.total + amount })
      }),
    }),
  ),
  Sender.toLayer(
    Effect.succeed({
      Send: Effect.fnUntraced(function* (amount: number) {
        yield* (yield* Receiver.intents("receiver")).Add(amount)
      }),
    }),
  ),
)

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    // Only the relay's delivery of `Add` stops, so the sender's own turn commits first.
    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && request.command === "Add"
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    // The recovering process runs past the killed relay's claim lease.
    const clock = Layer.succeed(OutboxClock, {
      offsetMillis: () => (mode === "recover" ? 60_000 : 0),
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

// A crashed process leaves its committed intent in actor_outbox; a fresh
// process's relay must deliver it once and then delete the row.
const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const sql = yield* SqlClient.SqlClient

  if (mode !== "recover") {
    yield* (yield* Sender.get("sender")).Send(5)

    return yield* Effect.never
  }

  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const rows = yield* sql<{
    receipts: number
    state_bytes: Uint8Array
  }>`SELECT (SELECT count(*)::int FROM actor_receipts WHERE command = 'Add') AS receipts,
      (SELECT value FROM actor_state WHERE actor_type = 'ProcessReceiver' AND key = 'total') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ receipts: Schema.Int, state: Schema.String })),
  )({ receipts: rows[0]!.receipts, state: decompress(rows[0]!.state_bytes) })

  // Tagged so the parent ignores runtime logs that share stdout.
  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
