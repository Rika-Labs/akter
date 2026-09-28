import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { Actor } from "../../../../index.ts"
import { Actors, Database } from "../../../../runtime/index.ts"
import { decompress } from "../../../../runtime/storage/codec.ts"
import { TurnHooks } from "../../../../runtime/turn/hooks.ts"
import { FrameworkClock } from "../../../../runtime/turn/admission.ts"

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {}) {}

class Charge extends Actor.effect<Charge>()("Charge", { input: { amount: Schema.Finite } }) {}

// Its success type is wider than its route's input, so its only result is final.
class Gauge extends Actor.effect<Gauge>()("Gauge", {
  input: { value: Schema.Finite },
  success: Schema.Finite,
}) {}

const Order = Actor.command("Order", { input: Schema.Finite })

const Charged = Actor.command("Charged")

const ChargeFailed = Actor.command("ChargeFailed", { input: Actor.DeadLetter(Charge) })

const Measure = Actor.command("Measure", { input: Schema.Finite })

const Gauged = Actor.command("Gauged", { input: Schema.Int })

const GaugeFailed = Actor.command("GaugeFailed", { input: Actor.DeadLetter(Gauge) })

const Buyer = Actor.make("ProcessBuyer", {
  key: Schema.String,
  state: Actor.state({
    failures: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  effects: [Charge, Gauge],
  api: { Order, Measure },
  internal: { Charged, ChargeFailed, Gauged, GaugeFailed },
  policy: {
    effects: {
      Charge: { retry: { times: 0 }, onSuccess: Charged, onDeadLetter: ChargeFailed },
      // Retries remain after its final failure, which recovery must not use.
      Gauge: { retry: { times: 2 }, onSuccess: Gauged, onDeadLetter: GaugeFailed },
    },
  },
})

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const mode = yield* Config.String("CRASH_POINT")
    const effect = yield* Config.String("CRASH_EFFECT")
    const database = yield* Config.String("CRASH_DATABASE_URL")

    // The fake provider counts every call it receives under its idempotency
    // key, then refuses a charge, so its single attempt dead-letters, and
    // returns a gauge's result that its route rejects.
    const provider = new Pool({ connectionString: database, max: 1 })
    yield* Effect.addFinalizer(() => Effect.promise(() => provider.end()))

    const call = Effect.fnUntraced(function* () {
      const exec = yield* Buyer.Executor
      yield* Effect.promise(() =>
        provider.query(
          `INSERT INTO provider_calls (idempotency_key, calls) VALUES ($1, 1)
           ON CONFLICT (idempotency_key) DO UPDATE SET calls = provider_calls.calls + 1`,
          [exec.effectId],
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
            yield* (yield* Buyer.Turn).perform(Charge.make({ amount }))
          }),
          Charged: () => Effect.void,
          ChargeFailed: fail,
          Measure: Effect.fnUntraced(function* (value: number) {
            yield* (yield* Buyer.Turn).perform(Gauge.make({ value }))
          }),
          Gauged: () => Effect.void,
          GaugeFailed: fail,
        }),
      ),
      Buyer.toEffectLayer(
        Effect.succeed({
          Charge: () => call().pipe(Effect.andThen(ProviderDown.make({}))),
          Gauge: ({ value }) => call().pipe(Effect.as(value)),
        }),
      ),
    )

    // Only the dead-letter transaction and its route's delivery stop, so the
    // buyer's turn commits first.
    const hooks = Layer.succeed(TurnHooks, {
      at: (point, request) =>
        point === mode && (request.command === effect || request.command === `${effect}Failed`)
          ? Console.log("READY").pipe(Effect.andThen(Effect.never))
          : Effect.void,
    })

    // The recovering process runs past the crashed attempt's backoff.
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

// A crashed process leaves the exhausted effect or its dead-letter route in
// actor_outbox; a fresh process must settle it into one letter and one route.
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

  // Tagged so the parent ignores runtime logs that share stdout.
  yield* Console.log(`RESULT ${result}`)
}).pipe(Effect.timeout("10 seconds"))

Layer.effectDiscard(program).pipe(
  Layer.provide(runtime),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
