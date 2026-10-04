import { Context, Deferred, Duration, Effect, Exit, Fiber, Option, type Scope } from "effect"
import { ActorError, ActorUnavailable } from "../errors/actor.ts"

/**
 * Whether this runner should receive traffic. A runner is ready once its
 * storage answers, its schemas are migrated and compatible (checked when the
 * layer builds), it registers at least one actor, job, or query layer, its
 * routing is up, a public runner has its currently assigned shards, and it
 * is not draining. Readiness never waits for actors to
 * wake or workflows to finish.
 */
export type Readiness =
  | { readonly ready: true }
  | {
      readonly ready: false
      /**
       * `draining` or `drained` after `drain`; `storage` when the database does
       * not answer; `routing` while acquiring shards or once sharding has
       * shut down; `peering` when a mutual TLS runner's certificate has
       * expired or its credentials have failed to load for too long;
       * `unregistered` before any actor, job, or query layer registers.
       */
      readonly reason: "draining" | "drained" | "storage" | "routing" | "peering" | "unregistered"
    }

/** What a drain did. */
export interface DrainReport {
  /**
   * `clean` when claims and background work stopped and every in-flight turn
   * and job attempt finished before the deadline; `deadline-expired`
   * otherwise, when the deadline interrupted what was still in flight.
   */
  readonly outcome: "clean" | "deadline-expired"
  /**
   * Turns the deadline interrupted. Each rolled back, unless its commit had
   * already been sent, in which case its receipt answers the caller's retry.
   */
  readonly interruptedTurns: number
  /**
   * Job attempts the deadline interrupted. The provider may have applied
   * each call, so each stays ambiguous, and another runner takes it over once
   * its lease ends.
   */
  readonly interruptedJobs: number
}

/**
 * Readiness and bounded graceful drain of this runner. `Actors.layer`
 * provides it.
 */
export class RuntimeControl extends Context.Service<
  RuntimeControl,
  {
    readonly readiness: Effect.Effect<Readiness>
    /**
     * Makes the runner unready, refuses new commands, and stops claiming
     * intents, timers, jobs, and subscription deliveries, releasing claimed
     * deliveries to other runners. In-flight turns and job attempts then
     * get until `deadline` to finish before they are interrupted. Pending
     * durable work stays in the database for other runners. The runner keeps
     * its shards until its layer closes, which hands them to the other runners
     * and ends workflow runs still live here, for another runner to replay; so
     * close the layer once the drain returns. A second call waits for the
     * first drain and returns its report.
     */
    readonly drain: (options: { readonly deadline: Duration.Input }) => Effect.Effect<DrainReport>
  }
>()("@rikalabs/akter/runtime/drain/RuntimeControl") {}

const refused = () =>
  ActorError.make({
    reason: ActorUnavailable.make({ cause: new Error("Runner is draining") }),
  })

/**
 * Admits turns until a drain closes it, counts the turns in flight, and
 * interrupts them all once the drain's deadline passes.
 */
export const turnGate = () => {
  let open = true
  let inFlight = 0
  let interrupted = 0
  let idle: Deferred.Deferred<void> | undefined
  const expired = Deferred.makeUnsafe<void>()

  const deadline = Deferred.await(expired).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        interrupted += 1

        return Effect.fail(refused())
      }),
    ),
  )

  return {
    /**
     * Runs a turn unless the runner drains. A turn the deadline interrupts
     * fails as unavailable once it has rolled back, so its caller retries on
     * the actor's next owner.
     */
    run: <A, E, R>(turn: Effect.Effect<A, E, R>): Effect.Effect<A, E | ActorError, R> =>
      Effect.suspend(() => {
        if (!open) return Effect.fail(refused())

        inFlight += 1

        return Effect.raceFirst(turn, deadline).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight -= 1

              if (inFlight === 0 && idle !== undefined) Deferred.doneUnsafe(idle, Exit.void)
            }),
          ),
        )
      }),
    get open() {
      return open
    },
    /** Refuses new turns and waits until none is in flight. */
    close: Effect.suspend(() => {
      open = false

      if (inFlight === 0) return Effect.void

      idle ??= Deferred.makeUnsafe<void>()

      return Deferred.await(idle)
    }),
    /**
     * Refuses new turns, interrupts every turn in flight, and returns how many
     * it interrupted, once they have ended.
     */
    expire: Effect.suspend(() => {
      open = false
      Deferred.doneUnsafe(expired, Exit.void)

      if (inFlight > 0) idle ??= Deferred.makeUnsafe<void>()

      return (idle === undefined ? Effect.void : Deferred.await(idle)).pipe(
        Effect.map(() => interrupted),
      )
    }),
  }
}

/** The turn gate a runtime creates once and shares with its drain. */
export type TurnGate = ReturnType<typeof turnGate>

/** The runtime's side of a drain: its relay and background work. */
interface Drainable {
  readonly gate: TurnGate
  /** Stops claims and releases claimed deliveries. */
  readonly stopClaims: Effect.Effect<void>
  readonly attemptsIdle: Effect.Effect<void>
  /** Interrupts running job attempts and returns how many. */
  readonly interruptAttempts: Effect.Effect<number>
  /** Stops background maintenance such as retention sweeps. */
  readonly stopBackground: Effect.Effect<void>
  /** Readiness apart from draining. */
  readonly serving: Effect.Effect<Readiness>
}

/**
 * The drain runs in the runtime's scope, so a caller that stops waiting
 * neither cancels it nor leaves a later caller without its report.
 *
 * The deadline counts from the call and covers stopping claims and background
 * work too: releasing a claimed delivery or ending a sweep writes to the
 * database, which a slow or contended database can hold for longer than the
 * deadline. That stop runs on in the runtime's scope, so claims still end,
 * while the deadline interrupts the turns and job attempts in flight and
 * the report says it expired.
 */
export const runtimeControl = ({
  scope,
  ...runtime
}: Drainable & { readonly scope: Scope.Scope }) => {
  let state: "serving" | "draining" | "drained" = "serving"
  const report = Deferred.makeUnsafe<DrainReport>()

  const run = (deadline: Duration.Duration) =>
    Effect.gen(function* () {
      const stopping = yield* runtime.stopClaims.pipe(
        Effect.andThen(runtime.stopBackground),
        Effect.forkIn(scope),
      )

      const finished = yield* Fiber.join(stopping).pipe(
        Effect.andThen(
          Effect.all([runtime.gate.close, runtime.attemptsIdle], {
            concurrency: 2,
            discard: true,
          }),
        ),
        Effect.timeoutOption(deadline),
      )

      const done: DrainReport = Option.isSome(finished)
        ? { outcome: "clean", interruptedTurns: 0, interruptedJobs: 0 }
        : yield* Effect.all(
            {
              interruptedTurns: runtime.gate.expire,
              interruptedJobs: runtime.interruptAttempts,
            },
            { concurrency: 2 },
          ).pipe(Effect.map((counts) => ({ outcome: "deadline-expired" as const, ...counts })))

      if (done.outcome === "deadline-expired")
        yield* Effect.logWarning("Drain deadline expired; interrupted in-flight work").pipe(
          Effect.annotateLogs({
            interruptedTurns: done.interruptedTurns,
            interruptedJobs: done.interruptedJobs,
          }),
        )

      state = "drained"
      yield* Deferred.succeed(report, done)
    })

  return RuntimeControl.of({
    readiness: Effect.suspend(() =>
      state === "serving" ? runtime.serving : Effect.succeed({ ready: false, reason: state }),
    ),
    drain: (options) =>
      Effect.suspend(() => {
        if (state !== "serving") return Deferred.await(report)

        state = "draining"

        return run(Duration.fromInputUnsafe(options.deadline)).pipe(
          Effect.forkIn(scope),
          Effect.andThen(Deferred.await(report)),
        )
      }),
  })
}
