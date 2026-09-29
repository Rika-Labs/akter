import {
  Cause,
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Random,
  Schedule,
  Schema,
} from "effect"
import { SqlError } from "effect/unstable/sql"
import { Actor, Actors } from "../index.ts"
import { ActorError } from "../errors/actor.ts"
import { ActorTest } from "./actor-test.ts"
import { ActorCluster, type RunnerServices } from "./cluster.ts"
import { conclude, generator, SETTLE_ROUNDS } from "./simulate.ts"

/**
 * A fault `ActorTest.simulateCluster` injects into one command. The turn is
 * the one the command runs on the runner that owns its actor; the caller
 * enters through a seeded runner, which may or may not be that owner.
 * - `crashBeforeCommit` and `crashAfterCommit`: the turn dies at that point, so it rolls back or
 *   its reply is lost, and the command id is sent again.
 * - `dropReply`: the caller discards the reply it got and sends the same command id again.
 * - `runnerKill`: the owner is killed with its turn paused before or after COMMIT, by seed. The
 *   command id goes to a surviving runner, which waits for the dead runner's shard lock to
 *   expire, and the killed runner starts again afterwards.
 * - `heartbeatLoss`: the owner stops refreshing its shard locks with its turn paused before COMMIT.
 *   A rival runner takes the shard once the lock expires and commits the same command id; the
 *   first turn's COMMIT then meets the generation fence.
 * - `connectionLoss`: every runner's database connections are cut at once and reconnect to the same
 *   database. The owner's turn is cut before COMMIT, when the transaction rolls back, or after the
 *   database made the COMMIT and before its reply arrived, when the runner cannot know the outcome,
 *   by seed. The command id is sent again, and a receipt resolves which of the two happened.
 * - `primaryFailover`: `connectionLoss`, and then the database primary is killed and a standby
 *   promoted, so the reconnecting runners find the promoted standby. It needs the `primary` option,
 *   and happens once, on one seeded command of `commands`, since a promoted standby has no standby
 *   of its own to fail over to again.
 */
export type ClusterSimulationFault =
  | "crashBeforeCommit"
  | "crashAfterCommit"
  | "dropReply"
  | "runnerKill"
  | "heartbeatLoss"
  | "connectionLoss"
  | "primaryFailover"

export interface ClusterSimulationOptions {
  /** Every draw, and so the whole fault schedule, follows from it. */
  readonly seed: string
  readonly faults: ReadonlyArray<ClusterSimulationFault>
  /** Chance that a command gets a fault. Default 0.5. */
  readonly faultRate?: number
  /**
   * Kills the primary, promotes a standby, and moves the address the runners
   * dial to it, once the runners' connections are cut; `primaryFailover` runs it.
   */
  readonly primary?: Effect.Effect<void>
  /**
   * How many commands the program sends. `primaryFailover` picks one of them,
   * and the run fails if the program sends fewer.
   */
  readonly commands?: number
  /** How long a caller waits for one attempt before sending its command id again. Default 10 seconds. */
  readonly attempt?: Duration.Input
  /** How long one command may take to commit. Default 2 minutes. */
  readonly within?: Duration.Input
  /** How far every runner's clock moves to settle outstanding deliveries. Default 1 minute per round. */
  readonly settle?: Duration.Input
}

export interface ClusterSimulationStep {
  readonly label: string
  readonly commandId: string
  readonly fault: ClusterSimulationFault | "none"
  /** The runner the caller first sent the command through. */
  readonly runner: number
  /** Where a `runnerKill` cuts the turn; `beforeCommit` for every other fault except `crashAfterCommit`. */
  readonly point: "beforeCommit" | "afterCommit"
  /** Whether a `connectionLoss` or `primaryFailover` lets the database make the COMMIT before the cut. */
  readonly landed: boolean
}

export interface ClusterSimulationReport {
  readonly seed: string
  readonly steps: ReadonlyArray<ClusterSimulationStep>
}

export interface ClusterSimulation {
  readonly seed: string
  /**
   * Runs one command through a seeded runner under the seed's next fault,
   * with a command id minted for it, and sends that id again until a receipt
   * answers. `effect` must get its handles itself, since it runs on whichever
   * runner carries it, and must be a single command call, so it commits one
   * receipt.
   */
  readonly command: <A, E, R>(
    label: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ActorError | Cause.TimeoutError, Exclude<R, RunnerServices>>
  /** A seeded integer in `[min, max]`. */
  readonly int: (min: number, max: number) => Effect.Effect<number>
  /** A seeded element of a non-empty list. */
  readonly pick: <A>(values: readonly [A, ...Array<A>]) => Effect.Effect<A>
}

const isActorError = Schema.is(ActorError)

/**
 * Runs `program` on `cluster` under a fault schedule drawn from
 * `options.seed`, then checks that every command committed exactly one
 * receipt and no due or attempted outbox row was left undelivered. A failure
 * dies with the seed. Rerunning it repeats the program's choices and each
 * command's entry runner and fault; which runner owns an actor depends on
 * runner addresses, which change from run to run, and command ids are minted
 * fresh. Settling advances every runner's clock, so simulate once per
 * cluster after any runner has restarted.
 */
export const simulateCluster =
  (cluster: ActorCluster["Service"]) =>
  <E, R>(
    options: ClusterSimulationOptions,
    program: (simulation: ClusterSimulation) => Effect.Effect<void, E, R>,
  ): Effect.Effect<ClusterSimulationReport, never, R> =>
    Effect.gen(function* () {
      const draw = generator(options.seed)
      const rate = options.faultRate ?? 0.5
      const attempt = Duration.fromInputUnsafe(options.attempt ?? "10 seconds")
      const within = Duration.fromInputUnsafe(options.within ?? "2 minutes")
      const settle = options.settle ?? "1 minute"
      const steps: Array<ClusterSimulationStep> = []
      const violations: Array<string> = []
      const runners = Array.from({ length: cluster.runners }, (_, index) => index)
      const on = cluster.on
      const planned = options.faults.includes("primaryFailover")
      const others = options.faults.filter((fault) => fault !== "primaryFailover")

      if (runners.length < 2)
        return yield* Effect.die(new Error("ActorTest.simulateCluster needs at least two runners"))

      if (planned && options.primary === undefined)
        return yield* Effect.die(new Error("primaryFailover needs the primary option"))

      if (planned && (options.commands === undefined || options.commands < 1))
        return yield* Effect.die(new Error("primaryFailover needs the number of commands"))

      const failoverAt = planned ? Math.floor(draw() * options.commands!) : -1

      const eachRunner = <A, E1, R1>(effect: Effect.Effect<A, E1, R1>) =>
        Effect.forEach(runners, (runner) => on(runner)(effect))

      const clearFaults = ActorTest.use((test) => test.clearFaults)

      // Settling moves every running runner's clock forward, which a runner
      // that starts afterwards does not share, and a command id minted on the
      // runner ahead is in the future to the runner behind.
      const clocks = (yield* eachRunner(ActorTest.use((test) => test.now))).map(
        DateTime.toEpochMillis,
      )

      if (Math.max(...clocks) - Math.min(...clocks) > 1_000)
        return yield* Effect.die(
          new Error(
            "ActorTest.simulateCluster needs runners whose clocks agree; an earlier simulation settled some runners' clocks ahead of a restarted one, so simulate once per cluster",
          ),
        )

      // The cluster's own pool reconnects through a failover like any other.
      const read = <A>(query: Effect.Effect<A, SqlError.SqlError>) =>
        query.pipe(
          Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
          Effect.orDie,
        )

      const command = <A, E1, R1>(
        label: string,
        effect: Effect.Effect<A, E1, R1>,
      ): Effect.Effect<A, E1 | ActorError | Cause.TimeoutError, Exclude<R1, RunnerServices>> =>
        Effect.gen(function* () {
          const fault: ClusterSimulationFault | "none" =
            steps.length === failoverAt
              ? "primaryFailover"
              : others.length === 0 || draw() >= rate
                ? "none"
                : others[Math.floor(draw() * others.length)]!

          const entry = Math.floor(draw() * runners.length)

          const point =
            fault === "crashAfterCommit" || (fault === "runnerKill" && draw() < 0.5)
              ? "afterCommit"
              : "beforeCommit"

          const landed = (fault === "connectionLoss" || fault === "primaryFailover") && draw() < 0.5

          // Minting reads the database clock, which a failover briefly takes away.
          const commandId = yield* on(entry)(
            Effect.gen(function* () {
              return yield* (yield* Actors).mintCommandId
            }),
          ).pipe(
            Effect.retry({
              while: (error) => error.isRetryable,
              schedule: Schedule.spaced("200 millis"),
              times: 100,
            }),
            Effect.orDie,
          )

          steps.push({ label, commandId, fault, runner: entry, point, landed })
          const call = effect.pipe(Actor.commandId(commandId))
          const send = (runner: number) => on(runner)(call).pipe(Effect.timeout(attempt))

          // The same id through each runner in turn, skipping `avoid`, until
          // a receipt answers; only the command's own declared failures end it.
          const deliver = (from: number, avoid?: number) => {
            const order = runners.filter((runner) => runner !== avoid)
            const start = Math.max(order.indexOf(from), 0)

            return Effect.gen(function* () {
              for (let round = 0; ; round++) {
                const exit = yield* Effect.exit(send(order[(start + round) % order.length]!))

                if (Exit.isSuccess(exit)) return exit.value

                const error = Cause.findErrorOption(exit.cause)

                const resendable =
                  Option.isNone(error) ||
                  Predicate.isTagged(error.value, "TimeoutError") ||
                  (isActorError(error.value) && error.value.isRetryable)

                if (!resendable) return yield* Effect.failCause(exit.cause)

                yield* Effect.sleep("100 millis")
              }
            })
          }

          // Whichever runner runs this command's turn reaches its pause; every
          // runner holds one, and the others' are cleared once it is known.
          const holdTurn = Effect.gen(function* () {
            const paused = yield* Effect.forEach(runners, (runner) =>
              on(runner)(ActorTest.use((test) => test.pauseNext(point, { commandId }))),
            )

            const first = yield* Effect.forkChild(Effect.exit(send(entry)))

            const owner = yield* Effect.raceAll(
              paused.map((pause, runner) => Effect.as(pause.reached, runner)),
            ).pipe(
              Effect.timeoutOrElse({
                duration: within,
                orElse: () =>
                  Effect.die(new Error(`${label} (${commandId}) never reached ${point}`)),
              }),
            )

            yield* Effect.forEach(
              runners.filter((runner) => runner !== owner),
              (runner) => on(runner)(clearFaults),
            )

            return { owner, first, release: paused[owner]!.release }
          })

          const survivor = (owner: number) =>
            entry === owner ? (owner + 1) % runners.length : entry

          if (fault === "none") return yield* deliver(entry)

          if (fault === "dropReply") {
            yield* Effect.exit(send(entry))

            return yield* deliver(entry)
          }

          if (fault === "crashBeforeCommit" || fault === "crashAfterCommit") {
            yield* eachRunner(ActorTest.use((test) => test.crashNext(point, { commandId })))
            const result = yield* deliver(entry)
            const left = (yield* eachRunner(clearFaults)).flat()

            // One runner took its crash; every other runner's stayed queued.
            if (left.length === runners.length)
              violations.push(`${label} (${commandId}) never reached its ${point} crash`)

            return result
          }

          if (fault === "runnerKill") {
            const { owner, first, release } = yield* holdTurn
            yield* cluster.kill(owner)
            yield* release
            const result = yield* deliver(survivor(owner), owner)
            yield* Fiber.interrupt(first)
            yield* cluster.restart(owner)
            yield* cluster.ready

            return result
          }

          if (fault === "heartbeatLoss") {
            const { owner, first, release } = yield* holdTurn
            const heartbeat = yield* cluster.pauseHeartbeat(owner)
            const result = yield* deliver(survivor(owner), owner)
            yield* release
            yield* Fiber.join(first)
            yield* heartbeat.resume
            yield* cluster.ready

            return result
          }

          const { first, release } = yield* holdTurn

          if (!landed) {
            yield* cluster.failover
            yield* release
          } else {
            yield* cluster.holdReplies
            yield* release

            yield* read(
              cluster.sql<{ count: number }>`
                SELECT count(*)::integer AS count FROM actor_receipts
                WHERE tenant_id = ${cluster.tenant} AND command_id = ${commandId}`,
            ).pipe(
              Effect.repeat({
                until: ([receipts]) => receipts!.count > 0,
                schedule: Schedule.spaced("20 millis"),
              }),
              Effect.timeoutOrElse({
                duration: within,
                orElse: () => Effect.die(new Error(`${label} (${commandId}) never committed`)),
              }),
            )

            yield* cluster.failover
          }

          if (fault === "primaryFailover") yield* options.primary!

          const settled = yield* Fiber.join(first)

          return Exit.isSuccess(settled) ? settled.value : yield* deliver(entry)
        }).pipe(
          Effect.timeoutOrElse({
            duration: within,
            orElse: () =>
              Effect.die(new Error(`${label} did not commit within ${Duration.format(within)}`)),
          }),
        )

      const simulation: ClusterSimulation = {
        seed: options.seed,
        int: (min, max) => Effect.sync(() => min + Math.floor(draw() * (max - min + 1))),
        pick: (values) => Effect.sync(() => values[Math.floor(draw() * values.length)]!),
        command,
      }

      const run = Effect.gen(function* () {
        yield* program(simulation)

        if (steps.length === 0) violations.push("the program sent no command")

        if (planned && steps.length <= failoverAt)
          violations.push(`the primary failover planned for command ${failoverAt} never happened`)

        // A row that was ever attempted is still in flight, while one never
        // attempted and not yet due is a timer the program scheduled.
        const pending = read(
          Effect.gen(function* () {
            const now = DateTime.toEpochMillis(yield* on(0)(ActorTest.use((test) => test.now)))

            const [rows] = yield* cluster.sql<{ count: number }>`
              SELECT count(*)::integer AS count FROM actor_outbox
              WHERE tenant_id = ${cluster.tenant} AND (due_at_ms <= ${now} OR attempts > 0)`

            return rows!.count
          }),
        )

        let unsettled = Number.POSITIVE_INFINITY

        for (let round = 0; round < SETTLE_ROUNDS && unsettled > 0; round++) {
          yield* eachRunner(ActorTest.use((test) => test.advance(settle)))

          unsettled = yield* pending.pipe(
            Effect.repeat({
              until: (count) => count === 0,
              schedule: Schedule.spaced("100 millis"),
            }),
            Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => pending }),
          )
        }

        if (unsettled > 0)
          violations.push(`${unsettled} due or attempted outbox rows were never delivered`)

        const left = (yield* eachRunner(clearFaults)).flat()

        if (left.length > 0) violations.push(`faults at ${left.join(", ")} were never reached`)

        for (const step of steps) {
          const [receipts] = yield* read(
            cluster.sql<{ count: number }>`
              SELECT count(*)::integer AS count FROM actor_receipts
              WHERE tenant_id = ${cluster.tenant} AND command_id = ${step.commandId}`,
          )

          if (receipts!.count !== 1)
            violations.push(`${step.label} (${step.commandId}) has ${receipts!.count} receipts`)
        }
      })

      return yield* conclude({
        seed: options.seed,
        steps,
        violations,
        run,
        cleanup: eachRunner(clearFaults).pipe(Effect.ignore),
      })
    })

/** Seeds pull requests run on a cluster: `0` and `1`. */
export const CLUSTER_SIMULATION_SEEDS = 2

/** Seeds the nightly run covers on a cluster: about a minute each. */
export const NIGHTLY_CLUSTER_SIMULATION_SEEDS = 6

/** Seeds pull requests run through a real primary failover, each on a primary and standby of its own: `0`. */
export const FAILOVER_SIMULATION_SEEDS = 1

/** Seeds the nightly run puts through a real primary failover: under a minute each. */
export const NIGHTLY_FAILOVER_SIMULATION_SEEDS = 3

const seedsOf = (countName: string, pullRequest: number, nightly: number) =>
  Effect.gen(function* () {
    const property = yield* Config.String("PROPERTY_SEED").pipe(Config.withDefault(""))
    const random = property === "random"

    const count = yield* Config.Int(countName).pipe(
      Config.withDefault(random ? nightly : pullRequest),
    )

    const configured = yield* Config.Int("SIMULATION_SEED_BASE").pipe(Config.option)

    const base = Option.isSome(configured)
      ? configured.value
      : random
        ? yield* Random.nextIntBetween(0, 2 ** 31 - 1 - count)
        : 0

    if (random && Option.isNone(configured)) yield* Console.error(`${countName} seeds from ${base}`)

    return Array.from({ length: count }, (_, index) => String(base + index))
  }).pipe(Effect.orDie)

/**
 * The seeds this run simulates on a cluster: `CLUSTER_SIMULATION_SEEDS` of
 * them counted up from `SIMULATION_SEED_BASE`. A run whose `PROPERTY_SEED` is
 * `random`, as the nightly run's is, defaults to
 * `NIGHTLY_CLUSTER_SIMULATION_SEEDS` seeds from a base it draws and prints,
 * so each night covers seeds no other night did; every other run defaults to
 * `CLUSTER_SIMULATION_SEEDS` from 0. A failure names its seed; rerun it with
 * `CLUSTER_SIMULATION_SEEDS=1 SIMULATION_SEED_BASE=<seed>`.
 */
export const clusterSimulationSeeds = seedsOf(
  "CLUSTER_SIMULATION_SEEDS",
  CLUSTER_SIMULATION_SEEDS,
  NIGHTLY_CLUSTER_SIMULATION_SEEDS,
)

/** The seeds for the failover drill, chosen like `clusterSimulationSeeds` from `FAILOVER_SIMULATION_SEEDS`. */
export const failoverSimulationSeeds = seedsOf(
  "FAILOVER_SIMULATION_SEEDS",
  FAILOVER_SIMULATION_SEEDS,
  NIGHTLY_FAILOVER_SIMULATION_SEEDS,
)
