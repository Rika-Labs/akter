import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Runners, RunnerStorage, Sharding } from "effect/cluster"
import { SqlClient } from "effect/sql"
import { Actor, Intent } from "../../../../../packages/akter/src/index.ts"
import {
  ColdHooks,
  ColdTier,
  type ColdClaim,
} from "../../../../../packages/akter/src/runtime/storage/cold-tier.ts"
import { type ColdStorage } from "../../../../../packages/akter/src/runtime/storage/cold-storage.ts"
import { routingKey } from "../../../../../packages/akter/src/runtime/storage/codec.ts"
import { ActorTest } from "../../../../../packages/akter/src/testing/actor-test.ts"
import { TurnHooks } from "../../../../../packages/akter/src/runtime/turn/hooks.ts"
import { RunnerWiring } from "../../../../../packages/akter/src/runtime/runner.ts"

const archive = Actor.blob("archive")

class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {}) {}

const Seed = Actor.command("Seed", { success: Schema.Int })
const Add = Actor.command("Add", { payload: Schema.Int, success: Schema.Int })
const Refuse = Actor.command("Refuse", { error: Rejected })
const Explode = Actor.command("Explode")
const Ping = Actor.command("Ping")
const Changed = Actor.event("Changed", { amount: Schema.Int })
const Snapshot = Schema.Struct({
  total: Schema.Int,
  untouched: Schema.Int,
  first: Schema.String,
  second: Schema.String,
})
const Read = Actor.query("Read", { success: Snapshot })

/** Asymmetric state and multi-chunk blobs distinguish complete restoration from dirty-key write-back. */
export const ColdLedger = Actor.make("ColdLedger", {
  key: Schema.String,
  state: Actor.state({
    total: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    untouched: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  blobs: [archive],
  events: [Changed],
  api: { Seed, Add, Refuse, Explode, Read },
  internal: { Ping },
  policy: { hibernateAfter: "1 day", coldAfter: 1 },
})

/** Commands write state, blobs, history, and ordinary timers through the real turn interface. */
export const coldLedgerLayer = Layer.mergeAll(
  ColdLedger.toLayer(
    Effect.succeed({
      Seed: Effect.fnUntraced(function* () {
        const turn = yield* ColdLedger.Turn
        yield* turn.state.set({ total: 17, untouched: 43 })
        yield* turn.blob(archive).set("first", new TextEncoder().encode("A"))
        yield* turn.blob(archive).append("first", new TextEncoder().encode("|BC"))
        yield* turn.blob(archive).set("second", new TextEncoder().encode("DZ"))
        yield* turn.emit(Changed.make({ amount: 17 }))
        yield* (yield* ColdLedger.intents(turn.id))
          .Ping()
          .pipe(Intent.key("ordinary"), Intent.after("1 hour"))
        return 17
      }),
      Add: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* ColdLedger.Turn
        yield* turn.state.set({ total: turn.state.total + amount })
        return turn.state.total
      }),
      Refuse: Effect.fnUntraced(function* () {
        const turn = yield* ColdLedger.Turn
        yield* turn.state.set({ total: 999, untouched: -1 })
        yield* turn.blob(archive).set("first", new TextEncoder().encode("refused"))
        yield* turn.emit(Changed.make({ amount: 999 }))
        yield* (yield* ColdLedger.intents(turn.id))
          .Ping()
          .pipe(Intent.key("refused"), Intent.after("1 hour"))
        return yield* Rejected.make({})
      }),
      Explode: Effect.fnUntraced(function* () {
        const turn = yield* ColdLedger.Turn
        yield* turn.state.set({ total: 900 })
        yield* turn.blob(archive).delete("second")
        yield* turn.emit(Changed.make({ amount: 900 }))
        return yield* Effect.die(new Error("cold handler defect"))
      }),
      Ping: () => Effect.void,
    }),
  ),
  ColdLedger.toQueryLayer(
    Effect.succeed({
      Read: Effect.fnUntraced(function* () {
        const read = yield* ColdLedger.Read
        const first = Option.getOrThrow(yield* read.blob(archive).get("first"))
        const second = Option.getOrThrow(yield* read.blob(archive).get("second"))
        return {
          total: read.state.total,
          untouched: read.state.untouched,
          first: new TextDecoder().decode(first),
          second: new TextDecoder().decode(second),
        }
      }),
    }),
  ),
)

/** Independent owner assignments emulate a partition; only the real Postgres generation fence grants authority. */
export const openCold = Effect.fnUntraced(function* (
  database: Redacted.Redacted<string>,
  store: ColdStorage | undefined,
  hooks: typeof ColdHooks.Service = { periodic: false, at: () => Effect.void },
  turns: typeof TurnHooks.Service = { at: () => Effect.void },
  actors: typeof coldLedgerLayer = coldLedgerLayer,
) {
  const context = yield* Layer.build(
    actors.pipe(
      Layer.provideMerge(
        ActorTest.layer({
          database,
          maxConnections: 2,
          coldStorage:
            store === undefined
              ? undefined
              : { store, backupRetention: "1 hour", grace: "1 hour", timeout: 100 },
          relay: { poll: "1 hour" },
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ColdHooks, hooks),
          Layer.succeed(TurnHooks, turns),
          Layer.effect(
            RunnerWiring,
            Effect.map(RunnerStorage.makeMemory, (storage) => ({
              config: {},
              sharding: Sharding.layer.pipe(Layer.provide(Runners.layerNoop)),
              storage: () => storage,
            })),
          ),
        ),
      ),
    ),
  )
  const sql = Context.get(context, SqlClient.SqlClient)
  const test = Context.get(context, ActorTest)
  const tier = Context.get(context, ColdTier)
  const ledger = (id: string) => ColdLedger.get(id).pipe(Effect.provideContext(context))
  const cold = Effect.fnUntraced(function* (id: string) {
    const handle = yield* ledger(id)
    yield* handle.Seed()
    yield* test.hibernate(handle.ref)
    yield* test.advance(2)
    return handle
  })
  const pointer = (id: string) =>
    sql<{
      cold_ref: string | null
      cold_digest: string | null
      cold_state_version: number | null
      generation: string
    }>`
    SELECT cold_ref, cold_digest, cold_state_version, generation::text FROM actor_generations
    WHERE tenant_id = ${test.tenant} AND actor_type = 'ColdLedger' AND actor_id = ${id}`.pipe(
      Effect.map(([row]) => row!),
    )
  const claim = (id: string) =>
    sql<ColdClaim>`UPDATE actor_outbox SET attempts = attempts + 1,
    due_at_ms = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 60000
    WHERE tenant_id = ${test.tenant} AND actor_type = 'ColdLedger' AND actor_id = ${id} AND kind = 'cold'
    RETURNING routing_key::text, tenant_id, actor_type, actor_id, intent_id, attempts, due_at_ms::text AS claimed_until`.pipe(
      Effect.map(([row]) => row!),
    )
  const owned = (id: string) => ({
    ref: { tenant: test.tenant, actor: "ColdLedger", id },
    key: routingKey({ ref: { tenant: test.tenant, actor: "ColdLedger", id }, placement: "tenant" }),
  })
  return { context, sql, test, tier, ledger, cold, pointer, claim, owned }
})
