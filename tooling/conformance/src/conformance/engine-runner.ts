import { Clock, Context, Duration, Effect, Layer, Schema } from "effect"
import { Actor, user } from "../../../../packages/akter/src/index.ts"
import { CommandIds } from "../../../../packages/akter/src/execution/command-ids.ts"
import type { Catalog } from "../../../../packages/akter/src/execution/durable.ts"
import { Engine } from "../../../../packages/akter/src/execution/engine.ts"
import { Transports } from "../../../../packages/akter/src/execution/transport.ts"
import type { ReplayPolicy } from "../../../../packages/akter/src/snapshots/recovery.ts"
import type { Bucket } from "../../../../packages/akter/src/store/bucket.ts"
import { Faults } from "../../../../packages/akter/src/store/faults.ts"
import { Store, storeOf } from "../../../../packages/akter/src/store/service.ts"

/** Shards of every store the engine scenarios open. */
export const SHARDS = 4

/** A counter whose reminder fires one second later: enough to see totals, sends and timers recover. */
export const Tally = Actor.make("Tally", {
  state: Schema.Struct({
    total: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    add: Actor.action(Schema.Finite, { success: Schema.Finite }),
    remind: Actor.action(Schema.Finite),
    note: Actor.action(Schema.Finite, { internal: true }),
  },
})

const TallyLive = Tally.toLayer({
  add: (tally, amount) => {
    tally.total += amount
    return tally.total
  },
  remind: (_, amount, { schedule }) => {
    schedule("1 second").note(amount)
  },
  note: (tally, amount) => {
    tally.total += amount
  },
})

/** How one runner of a scenario is set up over the shared location. */
export interface RunnerOptions {
  readonly writer: string
  readonly bundle?: string
  readonly policy?: ReplayPolicy
  readonly faults?: Faults
  readonly checkpointEvery?: number
}

/**
 * One runner over a store location: its own store instance and engine, alive for the enclosing
 * scope. Closing that scope without a drain is the runner's crash: memory goes, the log stays.
 */
export const runner = Effect.fnUntraced(function* (bucket: Bucket, options: RunnerOptions) {
  const store = yield* storeOf(bucket, {
    writer: options.writer,
    build: { bundle: options.bundle ?? "conformance", framework: "0.2.0-conformance" },
    shards: SHARDS,
    faults: options.faults ?? Faults.plan(),
  })
  const context = yield* Layer.build(TallyLive)
  const catalog: Catalog = {
    actors: new Map([
      [Tally.name, { actor: Tally, registered: Context.get(context, Tally.implementation) }],
    ]),
    shards: SHARDS,
  }
  const engine = yield* Engine.make(catalog, {
    shards: SHARDS,
    policy: options.policy ?? "matching",
    maxBatch: 64,
    checkpointEvery: options.checkpointEvery ?? 2,
    cronSkipIfOlderThan: 3_600_000,
    doubleRun: false,
    observer: undefined,
  }).pipe(Effect.provideService(Store, store))
  return { engine, store }
})

/** A runner as {@link runner} returns it. */
export type Runner = Effect.Success<ReturnType<typeof runner>>

const every = Array.from({ length: SHARDS }, (_, shard) => shard)

/** Assigns the runner every shard and waits until each one is open or refused. */
export const assignAll = (engine: Engine) =>
  Effect.gen(function* () {
    yield* engine.assign(every)
    for (let poll = 0; poll < 2_000; poll++) {
      if (every.every((shard) => ["open", "refused"].includes(engine.status(shard).status))) return
      yield* Effect.sleep(Duration.millis(10))
    }
    return yield* Effect.die(new Error("the runner's shards never opened"))
  })

const caller = user("conformance")

/** A fresh client id, as a client mints one per call. */
export const mint = Effect.flatMap(Clock.currentTimeMillis, CommandIds.mint)

/** One client attempt at `add` with a fixed id. */
export const add = Effect.fnUntraced(function* (
  engine: Engine,
  commandId: string,
  key: string,
  amount: number,
) {
  return yield* Transports.admit(engine, caller, commandId, {
    actor: Tally,
    id: key,
    member: "add",
    payload: amount,
  })
})

/** One client attempt at `remind` with a fresh id. */
export const remind = Effect.fnUntraced(function* (engine: Engine, key: string, amount: number) {
  const commandId = yield* mint
  return yield* Transports.admit(engine, caller, commandId, {
    actor: Tally,
    id: key,
    member: "remind",
    payload: amount,
  })
})

/** A tally's durable total as its owner answers it. */
export const total = Effect.fnUntraced(function* (engine: Engine, key: string) {
  const record = yield* engine.durableRecord(Tally, key)
  return Number(record.image.encoded["total"])
})
