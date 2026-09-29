import { Cause, Config, DateTime, Duration, Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, Actors } from "../index.ts"
import type { TurnPoint } from "../runtime/turn/hooks.ts"
import type { ActorTest } from "./actor-test.ts"

/**
 * A fault `ActorTest.simulate` injects into one command:
 * - `crashBeforeCommit`: the turn dies before COMMIT, so it rolls back and the handle retries.
 * - `crashAfterCommit`: the turn commits and the reply is lost, so the retry reads the receipt.
 * - `dropReply`: the caller discards the reply it got and sends the same command id again.
 * - `relayCrash`: the next relay delivery dies before deleting its outbox row, so the row
 *   is redelivered once its claim lease ends. Drawn only for commands marked `relays`.
 * - `clockSkew`: the framework clock jumps ahead of the database clock before the command.
 */
export type SimulationFault =
  | "crashBeforeCommit"
  | "crashAfterCommit"
  | "dropReply"
  | "relayCrash"
  | "clockSkew"

export interface SimulationOptions {
  /** Every draw, and so the whole fault schedule, follows from it. */
  readonly seed: string
  readonly faults: ReadonlyArray<SimulationFault>
  /** Chance that a command gets a fault. Default 0.5. */
  readonly faultRate?: number
  /** Largest `clockSkew` jump. Default 5 minutes. */
  readonly maxSkew?: Duration.Input
  /** How far the clock moves to settle outstanding deliveries. Default 1 minute per round. */
  readonly settle?: Duration.Input
}

export interface SimulationStep {
  readonly label: string
  readonly commandId: string
  readonly fault: SimulationFault | "none"
  /** The `clockSkew` jump in milliseconds, 0 otherwise. */
  readonly skewMs: number
}

export interface SimulationReport {
  readonly seed: string
  readonly steps: ReadonlyArray<SimulationStep>
}

export interface Simulation {
  readonly seed: string
  /**
   * Runs one command under the seed's next fault, with a command id minted
   * for it. `effect` must be a single command call, so it commits one receipt.
   * `relays` marks a command whose turn stages an intent, so a relay crash
   * drawn for it must be reached by that intent's delivery.
   */
  readonly command: <A, E, R>(
    label: string,
    effect: Effect.Effect<A, E, R>,
    options?: { readonly relays?: boolean },
  ) => Effect.Effect<A, E, R>
  /** A seeded integer in `[min, max]`. */
  readonly int: (min: number, max: number) => Effect.Effect<number>
  /** A seeded element of a non-empty list. */
  readonly pick: <A>(values: readonly [A, ...Array<A>]) => Effect.Effect<A>
}

/** A small seeded generator, so the schedule never depends on the runtime's own randomness. */
export const generator = (seed: string) => {
  let state = 2166136261

  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619)

  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const crashPoint: Partial<Record<SimulationFault | "none", TurnPoint>> = {
  crashBeforeCommit: "beforeCommit",
  crashAfterCommit: "afterCommit",
  relayCrash: "beforeOutboxDelete",
}

/** Settling rounds before undelivered outbox rows count as lost. */
export const SETTLE_ROUNDS = 5

const schedule = (steps: ReadonlyArray<{ readonly label: string; readonly fault: string }>) =>
  steps.map(({ label, fault }) => `${label}:${fault}`).join(" ")

/**
 * Runs a simulation's `run`, then reports it: a defect or a violation dies
 * with the seed and the schedule drawn, and `cleanup` runs however `run` ends.
 */
export const conclude = <Step extends { readonly label: string; readonly fault: string }, E, R>({
  seed,
  steps,
  violations,
  run,
  cleanup,
}: {
  readonly seed: string
  readonly steps: ReadonlyArray<Step>
  readonly violations: ReadonlyArray<string>
  readonly run: Effect.Effect<void, E, R>
  readonly cleanup: Effect.Effect<unknown>
}): Effect.Effect<{ readonly seed: string; readonly steps: ReadonlyArray<Step> }, never, R> =>
  Effect.gen(function* () {
    yield* run.pipe(
      Effect.ensuring(cleanup),
      Effect.catchCause((cause) =>
        Effect.die(
          new Error(
            `Simulation failed with seed ${seed} after ${steps.length} steps\n${Cause.pretty(cause)}\nschedule: ${schedule(steps)}`,
          ),
        ),
      ),
    )

    if (violations.length > 0)
      return yield* Effect.die(
        new Error(
          `Simulation failed with seed ${seed}\n${violations.join("\n")}\nschedule: ${schedule(steps)}`,
        ),
      )

    return { seed, steps }
  })

/**
 * Runs `program` against `test`'s runtime under a fault
 * schedule drawn from `options.seed`, then settles the relay and checks that
 * every command committed exactly one receipt and no due or attempted outbox
 * row was left undelivered. Any failure dies with the seed, so rerunning that
 * seed repeats the program's choices and the fault on each step; command ids
 * are minted fresh on every run.
 */
export const simulate =
  (test: ActorTest["Service"]) =>
  <E, R>(
    options: SimulationOptions,
    program: (simulation: Simulation) => Effect.Effect<void, E, R>,
  ): Effect.Effect<SimulationReport, never, R | Actors | SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const actors = yield* Actors
      const sql = yield* SqlClient.SqlClient
      const draw = generator(options.seed)
      const rate = options.faultRate ?? 0.5
      const maxSkewMs = Duration.toMillis(Duration.fromInputUnsafe(options.maxSkew ?? "5 minutes"))
      const settle = options.settle ?? "1 minute"
      const steps: Array<SimulationStep> = []

      const int = (min: number, max: number) =>
        Effect.sync(() => min + Math.floor(draw() * (max - min + 1)))

      const direct = options.faults.filter((fault) => fault !== "relayCrash")

      const nextFault = (relays: boolean) =>
        Effect.sync((): SimulationFault | "none" => {
          const faults = relays ? options.faults : direct

          if (faults.length === 0 || draw() >= rate) return "none"

          return faults[Math.floor(draw() * faults.length)]!
        })

      const simulation: Simulation = {
        seed: options.seed,
        int,
        pick: (values) => Effect.sync(() => values[Math.floor(draw() * values.length)]!),
        command: <A, E1, R1>(
          label: string,
          effect: Effect.Effect<A, E1, R1>,
          commandOptions?: { readonly relays?: boolean },
        ) =>
          Effect.gen(function* () {
            const fault = yield* nextFault(commandOptions?.relays === true)
            const skewMs = fault === "clockSkew" ? Math.floor(draw() * maxSkewMs) : 0
            const commandId = yield* actors.mintCommandId.pipe(Effect.orDie)
            steps.push({ label, commandId, fault, skewMs })
            const call = effect.pipe(Actor.commandId(commandId))
            const point = crashPoint[fault]

            if (point !== undefined) yield* test.crashNext(point)

            if (skewMs > 0) yield* test.advance(skewMs)

            if (fault === "dropReply") yield* Effect.exit(call)

            return yield* call
          }),
      }

      const violations: Array<string> = []

      const run = Effect.gen(function* () {
        yield* program(simulation)

        if (steps.length === 0) violations.push("the program sent no command")

        // A crashed delivery pushes its row's due time to the end of its claim
        // lease; a row that was ever attempted is still in flight, while one
        // never attempted and not yet due is a timer the program scheduled.
        let unsettled = Number.POSITIVE_INFINITY

        for (let round = 0; round < SETTLE_ROUNDS && unsettled > 0; round++) {
          yield* test.advance(settle)
          const now = DateTime.toEpochMillis(yield* test.now)

          const [pending] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM actor_outbox
          WHERE tenant_id = ${test.tenant} AND (due_at_ms <= ${now} OR attempts > 0)`

          unsettled = pending!.count
        }

        if (unsettled > 0)
          violations.push(`${unsettled} due or attempted outbox rows were never delivered`)

        const left = yield* test.clearFaults

        if (left.length > 0) violations.push(`faults at ${left.join(", ")} were never reached`)

        for (const step of steps) {
          const [receipts] = yield* sql<{ count: number }>`
          SELECT count(*)::integer AS count FROM actor_receipts
          WHERE tenant_id = ${test.tenant} AND command_id = ${step.commandId}`

          if (receipts!.count !== 1)
            violations.push(`${step.label} (${step.commandId}) has ${receipts!.count} receipts`)
        }
      })

      const queued = yield* test.clearFaults

      if (queued.length > 0)
        return yield* Effect.die(
          new Error(
            `ActorTest.simulate injects every fault itself; faults at ${queued.join(", ")} were already queued`,
          ),
        )

      return yield* conclude({
        seed: options.seed,
        steps,
        violations,
        run,
        cleanup: test.clearFaults,
      })
    })

/** Seeds pull requests run: `0` to `19`. */
export const SIMULATION_SEEDS = 20

/**
 * The seeds this run simulates: `SIMULATION_SEEDS` of them (default 20)
 * counted up from `SIMULATION_SEED_BASE` (default 0), so a nightly run sets
 * both and a failure names the seed to rerun.
 */
export const simulationSeeds = Effect.gen(function* () {
  const count = yield* Config.Int("SIMULATION_SEEDS").pipe(Config.withDefault(SIMULATION_SEEDS))
  const base = yield* Config.Int("SIMULATION_SEED_BASE").pipe(Config.withDefault(0))

  return Array.from({ length: count }, (_, index) => String(base + index))
}).pipe(Effect.orDie)
