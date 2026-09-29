import { appendFileSync } from "node:fs"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Config, Console, Crypto, Effect, Layer, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors as ActorIds } from "../../../index.ts"
import { ActorError } from "../../../errors/actor.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { migrations, migrator } from "../../../runtime/database/migrations.ts"
import { decompress } from "../../../runtime/storage/codec.ts"
import { databaseTime } from "../../../runtime/turn/admission.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

/**
 * One embedded process on a file-backed PGlite `dataDir`, driven by
 * `pglite-production.test.ts`: it prints what the parent waits for, and the
 * parent SIGKILLs it or lets it finish. `PGLITE_MODE` picks the step.
 */

class Incremented extends Actor.Event<Incremented>()("Incremented", { count: Schema.Int }) {}

class Charge extends Actor.effect<Charge>()("Charge", {
  input: { amount: Schema.Int },
  success: Schema.Int,
}) {}

const Increment = Actor.command("Increment", { input: Schema.Int, output: Schema.Int })

const Send = Actor.command("Send", {
  input: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const Bill = Actor.command("Bill", { input: Schema.Int })

const Receive = Actor.command("Receive", { input: Schema.Int })

const Charged = Actor.command("Charged", { input: Schema.Int })

const Ledger = Actor.make("EmbeddedLedger", {
  key: Schema.String,
  state: Actor.state({
    count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    charged: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  events: [Incremented],
  effects: [Charge],
  api: { Increment, Send, Bill },
  internal: { Receive, Charged },
  policy: { effects: { Charge: { retry: { times: 3 }, onSuccess: Charged } } },
})

/** Handler runs in this process, so a replay shows as zero. */
let runs = 0

const LedgerLive = Layer.mergeAll(
  Ledger.toLayer(
    Effect.succeed({
      Increment: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Ledger.Turn
        runs += 1
        yield* turn.state.set({ count: turn.state.count + amount })
        yield* turn.emit(Incremented.make({ count: turn.state.count }))

        return turn.state.count
      }),
      Send: Effect.fnUntraced(function* ({ to, amount }) {
        yield* Ledger.Turn
        yield* (yield* Ledger.intents(to)).Receive(amount)
      }),
      Bill: Effect.fnUntraced(function* (amount: number) {
        yield* (yield* Ledger.Turn).perform(Charge.make({ amount }))
      }),
      Receive: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Ledger.Turn
        runs += 1
        yield* turn.state.set({ count: turn.state.count + amount })
      }),
      Charged: Effect.fnUntraced(function* (amount: number) {
        const turn = yield* Ledger.Turn
        yield* turn.state.set({ charged: turn.state.charged + amount })
      }),
    }),
  ),
  Ledger.toEffectLayer(
    Effect.succeed({
      // The provider's own record of calls, which outlives this process.
      Charge: Effect.fnUntraced(function* ({ amount }) {
        const exec = yield* Ledger.Executor
        const calls = yield* Config.String("PGLITE_CALLS").pipe(Effect.orDie)
        appendFileSync(calls, `${exec.effectId}\n`)

        return amount
      }),
    }),
  ),
)

const RETRY_WINDOW_MS = 60_000

const runtime = (dataDir: string, hang: ReadonlyArray<string>) =>
  LedgerLive.pipe(
    Layer.provideMerge(
      // Short leases, so work a killed process claimed is taken back within seconds.
      Actors.layer({
        authorize: () => Effect.succeed(true),
        retryWindowMs: RETRY_WINDOW_MS,
        relay: { claimLease: "3 seconds" },
        executors: { lease: "3 seconds" },
      }).pipe(
        Layer.provide(
          Layer.succeed(TurnHooks, {
            at: (point) =>
              hang.includes(point)
                ? Console.log(`READY ${point}`).pipe(Effect.andThen(Effect.never))
                : Effect.void,
          }),
        ),
      ),
    ),
    Layer.provideMerge(Database.pglite({ dataDir })),
    Layer.provideMerge(BunCrypto.layer),
  )

const Stored = Schema.Struct({
  runs: Schema.Int,
  value: Schema.optional(Schema.Int),
  receipts: Schema.Int,
  events: Schema.Int,
  count: Schema.optional(Schema.String),
  outcomes: Schema.optional(Schema.Array(Schema.String)),
})

const report = Effect.fnUntraced(function* (
  fields: Omit<typeof Stored.Type, "receipts" | "events">,
) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ receipts: number; events: number }>`SELECT
      (SELECT count(*)::int FROM actor_receipts) AS receipts,
      (SELECT count(*)::int FROM actor_events) AS events`

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Stored))({
    ...fields,
    receipts: row!.receipts,
    events: row!.events,
  })

  yield* Console.log(`RESULT ${encoded}`)
})

const stateOf = Effect.fnUntraced(function* (id: string, key: string) {
  const sql = yield* SqlClient.SqlClient

  const [row] = yield* sql<{ value: Uint8Array }>`
    SELECT value FROM actor_state WHERE actor_type = 'EmbeddedLedger' AND actor_id = ${id} AND key = ${key}`

  return row === undefined ? undefined : decompress(row.value)
})

const outcome = <A, R>(effect: Effect.Effect<A, ActorError, R>) =>
  effect.pipe(
    Effect.map(String),
    Effect.catchIf(Schema.is(ActorError), (error) => Effect.succeed(error.reason._tag)),
  )

/** A command id minted now whose expiry is `inMs` away under the deployment's window. */
const expiringId = Effect.fnUntraced(function* (inMs: number) {
  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
  const expiresAt = (yield* databaseTime) + inMs

  return `v1.${expiresAt - RETRY_WINDOW_MS}.${expiresAt}.${uuid}`
})

const until = <A, E, R>(effect: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  effect.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("50 millis") }))

const program = Effect.gen(function* () {
  const mode = yield* Config.String("PGLITE_MODE")
  const dataDir = yield* Config.String("PGLITE_DATA_DIR")
  const commandId = yield* Config.String("PGLITE_COMMAND_ID").pipe(Config.withDefault(""))
  const [step, detail = ""] = mode.split(":")

  // A turn killed at a crash point, then its retry in a fresh process.
  if (step === "turn") {
    return yield* Effect.gen(function* () {
      const ledger = yield* Ledger.get("crashed")
      const value = yield* ledger.Increment(47).pipe(Actor.commandId(commandId))

      if (detail !== "recover")
        return yield* Effect.die(new Error("The crash point was not reached"))

      yield* report({ runs, value, count: yield* stateOf("crashed", "count") })
    }).pipe(Effect.provide(runtime(dataDir, detail === "recover" ? [] : [detail])))
  }

  // Holds the dataDir open until killed, or reports why it could not open it.
  if (step === "open") {
    return yield* Layer.build(runtime(dataDir, [])).pipe(
      Effect.andThen(Console.log("OPEN")),
      Effect.andThen(Effect.never),
      Effect.catchTags({
        DataDirLocked: (error) => Console.log(`REFUSED ${error._tag} ${error.dataDir}`),
        DataDirVersion: (error) => Console.log(`REFUSED ${error._tag} ${error.found}`),
      }),
    )
  }

  // An intent and an effect committed together; the relay dies after the
  // receiver commits and after the provider call, before either settles.
  if (step === "deliver") {
    return yield* Effect.gen(function* () {
      const payer = yield* Ledger.get("payer")

      if (detail === "crash") {
        yield* payer.Send({ to: "payee", amount: 3 })
        yield* payer.Bill(9)

        return yield* Effect.never
      }

      yield* until(stateOf("payer", "charged"), (value) => value === "9")
      yield* until(stateOf("payee", "count"), (value) => value !== undefined)
      // Let any duplicate delivery or settle land before counting.
      yield* Effect.sleep("1500 millis")
      const sql = yield* SqlClient.SqlClient

      const [rows] = yield* sql<{ outbox: number; receives: number; charged: number }>`SELECT
          (SELECT count(*)::int FROM actor_outbox) AS outbox,
          (SELECT count(*)::int FROM actor_receipts WHERE command = 'Receive') AS receives,
          (SELECT count(*)::int FROM actor_receipts WHERE command = 'Charged') AS charged`

      yield* Console.log(
        `DELIVERED ${JSON.stringify({ ...rows, runs, payee: yield* stateOf("payee", "count") })}`,
      )
    }).pipe(
      Effect.provide(
        runtime(dataDir, detail === "crash" ? ["beforeOutboxDelete", "afterExecute"] : []),
      ),
    )
  }

  // A dataDir left at migration 14 with rows a runtime of that time wrote.
  if (step === "seed") {
    const rows = yield* Effect.gen(function* () {
      const ledger = yield* Ledger.get("migrated")
      const id = yield* (yield* ActorIds).mintCommandId
      yield* ledger.Increment(5).pipe(Actor.commandId(id))
      const sql = yield* SqlClient.SqlClient

      return {
        id,
        generations: yield* sql`SELECT routing_key::text, tenant_id, actor_type, actor_id,
            generation::text, created, event_sequence::text FROM actor_generations`,
        placements: yield* sql`SELECT actor_type, placement, encoding FROM actor_placements`,
        state: yield* sql<{
          routing_key: string
          tenant_id: string
          actor_type: string
          actor_id: string
          key: string
          value: Uint8Array
        }>`SELECT routing_key::text, tenant_id, actor_type, actor_id, key, value FROM actor_state`,
        receipts: yield* sql`SELECT routing_key::text, tenant_id, actor_type, actor_id, command_id,
            command, payload_hash, caller_key, outcome, expires_at_ms::text FROM actor_receipts`,
      }
    }).pipe(Effect.provide(runtime(`memory://`, [])))

    const through14 = Object.fromEntries(
      Object.entries(migrations).filter(([id]) => id < "0015"),
    ) as typeof migrations

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* migrator(through14)
      yield* sql`INSERT INTO actor_deployment (protocol, retry_window_ms) VALUES (1, ${RETRY_WINDOW_MS})`

      for (const row of rows.placements) yield* sql`INSERT INTO actor_placements ${sql.insert(row)}`
      for (const row of rows.generations)
        yield* sql`INSERT INTO actor_generations ${sql.insert(row)}`
      for (const row of rows.state) yield* sql`INSERT INTO actor_state ${sql.insert(row)}`
      for (const row of rows.receipts) yield* sql`INSERT INTO actor_receipts ${sql.insert(row)}`
    }).pipe(Effect.provide(Database.pglite({ dataDir })))

    return yield* Console.log(`SEEDED ${rows.id}`)
  }

  // Runs the pending migrations and one more that never finishes, in their one transaction.
  if (step === "migrate") {
    return yield* migrator({
      ...migrations,
      "9999_hang": Console.log("READY migrating").pipe(Effect.andThen(Effect.never)),
    }).pipe(Effect.provide(Database.pglite({ dataDir })))
  }

  // Boots the runtime, which migrates, and retries the seeded id.
  if (step === "boot") {
    return yield* Effect.gen(function* () {
      const ledger = yield* Ledger.get("migrated")
      const replay = yield* ledger.Increment(5).pipe(Actor.commandId(commandId))
      const next = yield* ledger.Increment(1)
      const sql = yield* SqlClient.SqlClient

      const applied = yield* sql<{
        id: number
      }>`SELECT max(migration_id)::int AS id FROM actor_migrations`

      yield* Console.log(
        `MIGRATED ${JSON.stringify({ replay, next, runs, latest: applied[0]!.id })}`,
      )
    }).pipe(Effect.provide(runtime(dataDir, [])))
  }

  // Commits one command whose id expires soon and stops cleanly.
  if (step === "deposit") {
    return yield* Effect.gen(function* () {
      const ledger = yield* Ledger.get("restored")
      const id = yield* expiringId(Number(detail))
      yield* ledger.Increment(1).pipe(Actor.commandId(id))
      yield* Console.log(`ID ${id}`)
    }).pipe(Effect.provide(runtime(dataDir, [])))
  }

  // On a restored copy: waits for both ids to expire and retries them.
  if (step === "restored") {
    return yield* Effect.gen(function* () {
      const ledger = yield* Ledger.get("restored")
      const ids = commandId.split(",")
      const expiry = Math.max(...ids.map((id) => Number(id.split(".")[2])))
      yield* Effect.sleep(`${Math.max(0, expiry - (yield* databaseTime)) + 100} millis`)
      const outcomes = yield* Effect.forEach(ids, (id) =>
        outcome(ledger.Increment(1).pipe(Actor.commandId(id))),
      )
      yield* report({ runs, outcomes, count: yield* stateOf("restored", "count") })
    }).pipe(Effect.provide(runtime(dataDir, [])))
  }

  return yield* Effect.die(new Error(`Unknown PGLITE_MODE ${mode}`))
})

if (import.meta.main) program.pipe(Effect.scoped, BunRuntime.runMain)
