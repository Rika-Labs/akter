import { BunCrypto, BunFileSystem, BunRuntime } from "@effect/platform-bun"
import {
  Config,
  Console,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor } from "../../../index.ts"
import { ActorError } from "../../../errors/actor.ts"
import { Actors, Database } from "../../../runtime/index.ts"
import { decompress } from "../../../runtime/storage/codec.ts"
import { databaseTime } from "../../../runtime/turn/admission.ts"
import { TurnHooks } from "../../../runtime/turn/hooks.ts"

/**
 * One embedded process on a file-backed PGlite `dataDir`, driven by
 * `pglite-production.test.ts`: it prints what the parent waits for, and the
 * parent SIGKILLs it or lets it finish. `PGLITE_MODE` picks the step.
 */

const Incremented = Actor.event("Incremented", { count: Schema.Int })

const Charge = Actor.job("Charge", {
  payload: { amount: Schema.Int },
  success: Schema.Int,
})

const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

const Send = Actor.command("Send", {
  payload: Schema.Struct({ to: Schema.String, amount: Schema.Int }),
})

const Bill = Actor.command("Bill", { payload: Schema.Int })

const Receive = Actor.command("Receive", { payload: Schema.Int })

const Charged = Actor.command("Charged", { payload: Schema.Int })

const Ledger = Actor.make("EmbeddedLedger", {
  key: Schema.String,
  state: Actor.state({
    count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    charged: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  events: [Incremented],
  jobs: { Charge: { job: Charge, retry: { times: 3 }, onSuccess: Charged } },
  api: { Increment, Send, Bill },
  internal: { Receive, Charged },
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
        yield* (yield* Ledger.Turn).enqueue(Charge.make({ amount }))
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
  Ledger.toJobLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const calls = yield* Config.String("PGLITE_CALLS").pipe(Config.withDefault(""), Effect.orDie)

      return {
        Charge: Effect.fnUntraced(function* ({ amount }) {
          const exec = yield* Ledger.Executor
          yield* fs.writeFileString(calls, `${exec.jobId}\n`, { flag: "a" }).pipe(Effect.orDie)

          return amount
        }),
      }
    }),
  ).pipe(Layer.provide(BunFileSystem.layer)),
)

const RETRY_WINDOW_MS = 60_000

const runtime = (dataDir: string, hang: ReadonlyArray<string>) =>
  LedgerLive.pipe(
    Layer.provideMerge(
      Actors.layer({
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

/** Runs `effect` with `layer` built for it alone, then releases the layer. */
const within = <A, E, ROut, E2>(
  layer: Layer.Layer<ROut, E2>,
  effect: Effect.Effect<A, E, ROut | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)),
  )

const Delivered = Schema.fromJsonString(
  Schema.Struct({
    outbox: Schema.Int,
    receives: Schema.Int,
    charged: Schema.Int,
    runs: Schema.Int,
    payee: Schema.optional(Schema.String),
  }),
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

  if (step === "turn") {
    return yield* within(
      runtime(dataDir, detail === "recover" ? [] : [detail]),
      Effect.gen(function* () {
        const ledger = yield* Ledger.get("crashed")
        const value = yield* ledger.Increment(47).pipe(Actor.commandId(commandId))

        if (detail !== "recover")
          return yield* Effect.die(new Error("The crash point was not reached"))

        yield* report({ runs, value, count: yield* stateOf("crashed", "count") })
      }),
    )
  }

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

  if (step === "deliver") {
    return yield* within(
      runtime(dataDir, detail === "crash" ? ["beforeOutboxDelete", "afterExecute"] : []),
      Effect.gen(function* () {
        const payer = yield* Ledger.get("payer")

        if (detail === "crash") {
          yield* payer.Send({ to: "payee", amount: 3 })
          yield* payer.Bill(9)

          return yield* Effect.never
        }

        yield* until(stateOf("payer", "charged"), (value) => value === "9")
        yield* until(stateOf("payee", "count"), (value) => value !== undefined)
        yield* Effect.sleep("1500 millis")
        const sql = yield* SqlClient.SqlClient

        const [rows] = yield* sql<{ outbox: number; receives: number; charged: number }>`SELECT
          (SELECT count(*)::int FROM actor_outbox) AS outbox,
          (SELECT count(*)::int FROM actor_receipts WHERE command = 'Receive') AS receives,
          (SELECT count(*)::int FROM actor_receipts WHERE command = 'Charged') AS charged`

        yield* Console.log(
          `DELIVERED ${yield* Schema.encodeEffect(Delivered)({ ...rows!, runs, payee: yield* stateOf("payee", "count") })}`,
        )
      }),
    )
  }

  if (step === "deposit") {
    return yield* within(
      runtime(dataDir, []),
      Effect.gen(function* () {
        const ledger = yield* Ledger.get("restored")
        const id = yield* expiringId(Number(detail))
        yield* ledger.Increment(1).pipe(Actor.commandId(id))
        yield* Console.log(`ID ${id}`)
      }),
    )
  }

  if (step === "restored") {
    return yield* within(
      runtime(dataDir, []),
      Effect.gen(function* () {
        const ledger = yield* Ledger.get("restored")
        const ids = commandId.split(",")
        const expiry = Math.max(...ids.map((id) => Number(id.split(".")[2])))
        yield* Effect.sleep(`${Math.max(0, expiry - (yield* databaseTime)) + 100} millis`)

        const outcomes = yield* Effect.forEach(ids, (id) =>
          outcome(ledger.Increment(1).pipe(Actor.commandId(id))),
        )

        yield* report({ runs, outcomes, count: yield* stateOf("restored", "count") })
      }),
    )
  }

  return yield* Effect.die(new Error(`Unknown PGLITE_MODE ${mode}`))
})

if (import.meta.main) program.pipe(Effect.scoped, BunRuntime.runMain)
