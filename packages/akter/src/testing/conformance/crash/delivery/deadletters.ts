import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {}) {}

const Charge = Actor.job("Charge", { payload: { amount: Schema.Finite } })

const Gauge = Actor.job("Gauge", {
  payload: { value: Schema.Finite },
  success: Schema.Finite,
})

const Order = Actor.command("Order", { payload: Schema.Finite })

const Charged = Actor.command("Charged")

const ChargeFailed = Actor.command("ChargeFailed", { payload: Actor.DeadLetter(Charge) })

const Measure = Actor.command("Measure", { payload: Schema.Finite })

const Gauged = Actor.command("Gauged", { payload: Schema.Int })

const GaugeFailed = Actor.command("GaugeFailed", { payload: Actor.DeadLetter(Gauge) })

const Buyer = Actor.make("ProcessBuyer", {
  key: Schema.String,
  state: Actor.state({
    failures: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  jobs: {
    Charge: { job: Charge, retry: { times: 0 }, onSuccess: Charged, onDeadLetter: ChargeFailed },
    Gauge: { job: Gauge, retry: { times: 2 }, onSuccess: Gauged, onDeadLetter: GaugeFailed },
  },
  api: { Order, Measure },
  internal: { Charged, ChargeFailed, Gauged, GaugeFailed },
})

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const effect = yield* Config.String("CRASH_EFFECT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    const provider = new Pool({ connectionString: database, max: 1 })
    yield* Effect.addFinalizer(() => Effect.promise(() => provider.end()))

    const call = Effect.fnUntraced(function* () {
      const exec = yield* Buyer.Executor
      yield* Effect.promise(() =>
        provider.query(
          `INSERT INTO provider_calls (idempotency_key, calls) VALUES ($1, 1)
           ON CONFLICT (idempotency_key) DO UPDATE SET calls = provider_calls.calls + 1`,
          [exec.jobId],
        ),
      )
    })

    const fail = Effect.fnUntraced(function* () {
      const turn = yield* Buyer.Turn
      yield* turn.state.set({ failures: turn.state.failures + 1 })
    })

    const live = Layer.mergeAll(
      Buyer.toLayer(
        Effect.succeed({
          Order: Effect.fnUntraced(function* (amount: number) {
            yield* (yield* Buyer.Turn).enqueue(Charge.make({ amount }))
          }),
          Charged: () => Effect.void,
          ChargeFailed: fail,
          Measure: Effect.fnUntraced(function* (value: number) {
            yield* (yield* Buyer.Turn).enqueue(Gauge.make({ value }))
          }),
          Gauged: () => Effect.void,
          GaugeFailed: fail,
        }),
      ),
      Buyer.toJobLayer(
        Effect.succeed({
          Charge: () => call().pipe(Effect.andThen(ProviderDown.make({}))),
          Gauge: ({ value }) => call().pipe(Effect.as(value)),
        }),
      ),
    )

    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && (request.command === effect || request.command === `${effect}Failed`)
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    const clock = Layer.succeed(FrameworkClock, {
      offsetMillis: () => (mode === "recover" ? 120_000 : 0),
    })

    return live.pipe(
      Layer.provideMerge(Actors.layer().pipe(Layer.provide(Layer.mergeAll(hooks, clock)))),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("CRASH_POINT")
  const effect = yield* Config.String("CRASH_EFFECT")
  const sql = yield* SqlClient.SqlClient

  if (mode !== "recover") {
    const buyer = yield* Buyer.get("buyer")
    yield* effect === "Gauge" ? buyer.Measure(1.5) : buyer.Order(12)

    return yield* Effect.never
  }

  const pending = sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox`

  while ((yield* pending)[0]!.count > 0) yield* Effect.sleep("100 millis")

  const rows = yield* sql<{
    routed_id: string
    state_bytes: Uint8Array
  }>`SELECT (SELECT command_id FROM actor_receipts WHERE command = ${`${effect}Failed`}) AS routed_id,
      (SELECT value FROM actor_state WHERE actor_type = 'ProcessBuyer' AND key = 'failures') AS state_bytes`

  const result = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ routedId: Schema.String, state: Schema.String })),
  )({ routedId: rows[0]!.routed_id, state: decompress(rows[0]!.state_bytes) })

  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
