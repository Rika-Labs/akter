import {
  Deferred,
  type Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { Activity, Workflow } from "effect/unstable/workflow"
import type { WorkflowEngine } from "effect/unstable/workflow"
import type { ConformanceExpect, ConformanceRegistrar } from "../conformance.ts"

/**
 * The shared workflow-engine suite. Every case runs the same body against
 * the framework's engine and against Effect's `ClusterWorkflowEngine`; each
 * engine supplies the step primitives the body compiles to and a driver for
 * starting, polling, interrupting, and restarting executions.
 */

/** A declared activity failure; carries the attempt that failed. */
export class Flake extends Schema.TaggedError<Flake>()("Flake", { attempt: Schema.Int }) {}

export const ProbeInput = { scenario: Schema.String, key: Schema.String }

export type Scenario =
  | "plain"
  | "replay"
  | "retry"
  | "race"
  | "hold"
  | "compensate-sleep"
  | "compensate-hold"

/** Counters and gates the bodies share with the cases, by label and execution key. */
export interface EngineFixture {
  readonly runs: Map<string, number>
  readonly gates: Map<string, Deferred.Deferred<void>>
}

export const engineFixture = (): EngineFixture => ({ runs: new Map(), gates: new Map() })

const runsOf = (fixture: EngineFixture, label: string, key: string) =>
  fixture.runs.get(`${label}:${key}`) ?? 0

const bump = (fixture: EngineFixture, label: string, key: string) =>
  Effect.sync(() => fixture.runs.set(`${label}:${key}`, runsOf(fixture, label, key) + 1))

export type ActivityName = "once" | "fast" | "hold" | "flaky"

/** The step primitives a body uses, as each engine compiles them. */
export interface EnginePrimitives<R> {
  readonly activity: (
    name: ActivityName,
    execute: Effect.Effect<string, Flake>,
  ) => Effect.Effect<string, Flake, R>
  readonly sleep: (name: "nap", duration: Duration.Input) => Effect.Effect<void, never, R>
  readonly race: (
    name: "pick",
    effects: readonly [Effect.Effect<string, never, R>, Effect.Effect<string, never, R>],
  ) => Effect.Effect<string, never, R>
}

/** Short enough to wait for on a real clock; long enough to observe the suspension. */
export const SHORT_SLEEP = "1 second"

const LONG_SLEEP = "1 hour"

/** The one workflow body both engines run, chosen by its input's scenario. */
export const probeBody = <R>({
  primitives,
  fixture,
  input,
}: {
  readonly primitives: EnginePrimitives<R>
  readonly fixture: EngineFixture
  readonly input: { readonly scenario: string; readonly key: string }
}): Effect.Effect<string, Flake, R | WorkflowEngine.WorkflowInstance | Scope.Scope> =>
  Effect.gen(function* () {
    const { key } = input
    const once = primitives.activity("once", bump(fixture, "once", key).pipe(Effect.as("once")))

    const hold = primitives.activity(
      "hold",
      Effect.gen(function* () {
        yield* bump(fixture, "hold", key)
        const gate = fixture.gates.get(key)

        if (gate !== undefined) yield* Deferred.await(gate)

        return "held"
      }),
    )

    const compensated = once.pipe(Workflow.withCompensation(() => bump(fixture, "compensate", key)))

    switch (input.scenario as Scenario) {
      case "plain":
        return yield* once
      case "replay": {
        const value = yield* once
        yield* primitives.sleep("nap", SHORT_SLEEP)

        return value
      }

      case "retry": {
        const value = yield* primitives
          .activity(
            "flaky",
            Effect.gen(function* () {
              const attempt = yield* Activity.CurrentAttempt
              yield* bump(fixture, `flaky-${attempt}`, key)

              if (attempt < 3) return yield* Flake.make({ attempt })

              return `ok-${attempt}`
            }),
          )
          .pipe(Activity.retry({ times: 5 }))

        yield* primitives.sleep("nap", SHORT_SLEEP)

        return value
      }

      case "race": {
        const value = yield* primitives.race("pick", [
          primitives
            .activity("fast", bump(fixture, "fast", key).pipe(Effect.as("fast")))
            .pipe(Effect.orDie),
          bump(fixture, "loser", key).pipe(Effect.andThen(Effect.never)),
        ])

        yield* primitives.sleep("nap", SHORT_SLEEP)

        return value
      }

      case "compensate-sleep":
        yield* compensated
        yield* primitives.sleep("nap", LONG_SLEEP)

        return "done"
      case "hold":
        return yield* hold
      case "compensate-hold":
        yield* compensated
        yield* hold
        // Where an engine that lets the activity finish observes the interrupt.
        yield* primitives.sleep("nap", LONG_SLEEP)

        return "done"
    }

    return yield* Effect.die(new Error(`Unknown scenario ${input.scenario}`))
  })

export type EngineResult = Workflow.Result<string, unknown>

/** One execution as a case sees it. */
export interface EngineRun {
  readonly executionId: string
  readonly poll: Effect.Effect<Option.Option<EngineResult>>
  readonly interrupt: Effect.Effect<void>
}

export interface WorkflowEngineDriver {
  /** What `poll` returns while the body runs and hasn't yet suspended. */
  readonly pollWhileRunning: "Suspended" | "None"
  /** Starts or attaches to the execution for `key` and waits for its result. */
  readonly execute: (scenario: Scenario, key: string) => Effect.Effect<Exit.Exit<string, unknown>>
  /** Starts the execution and returns once the start is durable (`discard: true`). */
  readonly start: (scenario: Scenario, key: string) => Effect.Effect<EngineRun>
  /** The execution for `key`, without starting it. */
  readonly attach: (scenario: Scenario, key: string) => Effect.Effect<EngineRun>
  /** Waits until the execution has suspended, not merely started. */
  readonly awaitSuspended: (run: EngineRun) => Effect.Effect<void>
  /** Moves the engine's durable clock forward. */
  readonly advance: (duration: Duration.Input) => Effect.Effect<void>
  /** Tears the engine down and builds it again over the same storage. */
  readonly restart: Effect.Effect<void>
}

export interface EngineCaseContext {
  readonly driver: WorkflowEngineDriver
  readonly fixture: EngineFixture
  readonly expect: ConformanceExpect
  /** Unique per case run, so cases sharing one engine don't collide. */
  readonly key: string
}

export interface EngineCase {
  readonly name: string
  readonly run: (context: EngineCaseContext) => Effect.Effect<void>
}

export const eventually = ({
  check,
  what,
}: {
  readonly check: Effect.Effect<boolean>
  readonly what: string
}) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const isComplete = (
  polled: Option.Option<EngineResult>,
): polled is Option.Some<Workflow.Complete<string, unknown>> =>
  Option.isSome(polled) && Predicate.isTagged(polled.value, "Complete")

/** Polls until the execution completes and returns its exit. */
export const awaitComplete = (run: EngineRun) =>
  Effect.gen(function* () {
    let found: Option.Option<EngineResult> = Option.none()

    yield* eventually({
      check: run.poll.pipe(
        Effect.map((polled) => {
          found = polled

          return isComplete(polled)
        }),
      ),
      what: `${run.executionId} to complete`,
    })

    return (found as Option.Some<Workflow.Complete<string, unknown>>).value.exit
  })

const expectInterrupted = (expect: ConformanceExpect, exit: Exit.Exit<string, unknown>) =>
  expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)

export const engineCases: ReadonlyArray<EngineCase> = [
  {
    name: "replays a recorded activity without rerunning",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("replay", key)
        yield* driver.awaitSuspended(run)
        expect(runsOf(fixture, "once", key)).toBe(1)
        yield* driver.advance(SHORT_SLEEP)
        expect(yield* awaitComplete(run)).toEqual(Exit.succeed("once"))
        expect(runsOf(fixture, "once", key)).toBe(1)
      }),
  },
  {
    name: "records each Activity.retry attempt",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("retry", key)
        yield* driver.awaitSuspended(run)
        expect([1, 2, 3, 4].map((attempt) => runsOf(fixture, `flaky-${attempt}`, key))).toEqual([
          1, 1, 1, 0,
        ])
        yield* driver.advance(SHORT_SLEEP)
        expect(yield* awaitComplete(run)).toEqual(Exit.succeed("ok-3"))
        // The replay returned the final attempt's exit without running any attempt again.
        expect([1, 2, 3, 4].map((attempt) => runsOf(fixture, `flaky-${attempt}`, key))).toEqual([
          1, 1, 1, 0,
        ])
      }),
  },
  {
    name: "resumes a durable clock after engine restart",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("replay", key)
        yield* driver.awaitSuspended(run)
        yield* driver.restart
        yield* driver.advance(SHORT_SLEEP)
        const again = yield* driver.attach("replay", key)
        expect(yield* awaitComplete(again)).toEqual(Exit.succeed("once"))
        expect(runsOf(fixture, "once", key)).toBe(1)
      }),
  },
  {
    name: "replays a DurableDeferred.raceAll winner",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("race", key)
        yield* driver.awaitSuspended(run)
        expect(runsOf(fixture, "loser", key)).toBe(1)
        yield* driver.advance(SHORT_SLEEP)
        expect(yield* awaitComplete(run)).toEqual(Exit.succeed("fast"))
        expect(runsOf(fixture, "fast", key)).toBe(1)
        expect(runsOf(fixture, "loser", key)).toBe(1)
      }),
  },
  {
    name: "interrupts a suspended execution",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("compensate-sleep", key)
        yield* driver.awaitSuspended(run)
        expect(runsOf(fixture, "compensate", key)).toBe(0)
        yield* run.interrupt
        expectInterrupted(expect, yield* awaitComplete(run))
        expect(runsOf(fixture, "compensate", key)).toBe(1)
        expect(runsOf(fixture, "once", key)).toBe(1)
        // Interrupting a finished execution changes nothing.
        yield* run.interrupt
        expectInterrupted(expect, yield* awaitComplete(run))
        expect(runsOf(fixture, "compensate", key)).toBe(1)
      }),
  },
  {
    name: "interrupts a running execution",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        fixture.gates.set(key, gate)
        const run = yield* driver.start("compensate-hold", key)
        yield* eventually({
          check: Effect.sync(() => runsOf(fixture, "hold", key) >= 1),
          what: "the activity to start",
        })
        yield* run.interrupt
        // An engine may let the running activity finish before it interrupts.
        yield* Deferred.succeed(gate, undefined)
        expectInterrupted(expect, yield* awaitComplete(run))
        expect(runsOf(fixture, "compensate", key)).toBe(1)
      }),
  },
  {
    name: "polls unknown and complete",
    run: ({ driver, expect, key }) =>
      Effect.gen(function* () {
        const unknown = yield* driver.attach("plain", key)
        expect(Option.isNone(yield* unknown.poll)).toBe(true)
        expect(yield* driver.execute("plain", key)).toEqual(Exit.succeed("once"))
        const polled = yield* unknown.poll
        expect(isComplete(polled) && polled.value.exit).toEqual(Exit.succeed("once"))
      }),
  },
  {
    name: "attaches a repeated execute to one execution",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [driver.execute("plain", key), driver.execute("plain", key)],
          { concurrency: 2 },
        )

        expect(first).toEqual(Exit.succeed("once"))
        expect(second).toEqual(Exit.succeed("once"))
        expect(yield* driver.execute("plain", key)).toEqual(Exit.succeed("once"))
        expect(runsOf(fixture, "once", key)).toBe(1)
      }),
  },
  {
    name: "discards an execute",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const run = yield* driver.start("plain", key)
        expect(yield* awaitComplete(run)).toEqual(Exit.succeed("once"))
        expect(runsOf(fixture, "once", key)).toBe(1)
      }),
  },
  {
    name: "polls a running execution as the engine reports it",
    run: ({ driver, fixture, expect, key }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        fixture.gates.set(key, gate)
        const run = yield* driver.start("hold", key)
        yield* eventually({
          check: Effect.sync(() => runsOf(fixture, "hold", key) >= 1),
          what: "the activity to start",
        })
        const polled = yield* run.poll
        // The expected divergence: ours reads its row, Cluster has no reply yet.
        expect(Option.isSome(polled) ? polled.value._tag : "None").toBe(driver.pollWhileRunning)
        yield* Deferred.succeed(gate, undefined)
        expect(yield* awaitComplete(run)).toEqual(Exit.succeed("held"))
      }),
  },
]

/**
 * Registers every shared case against one engine. `open` builds a fresh
 * engine and its driver in the given scope; `run` executes a case.
 */
export const describeWorkflowEngine = (options: {
  readonly name: string
  readonly registrar: ConformanceRegistrar
  readonly open: (fixture: EngineFixture) => Effect.Effect<WorkflowEngineDriver, never, Scope.Scope>
  readonly timeoutMs?: number
}): void => {
  const { registrar } = options

  registrar.describe(options.name, () => {
    engineCases.forEach((engineCase, index) => {
      registrar.it(
        engineCase.name,
        () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const fixture = engineFixture()
              const driver = yield* options.open(fixture)

              yield* engineCase.run({
                driver,
                fixture,
                expect: registrar.expect,
                key: `case-${index}`,
              })
            }).pipe(Effect.scoped),
          ),
        options.timeoutMs ?? 60_000,
      )
    })
  })
}
