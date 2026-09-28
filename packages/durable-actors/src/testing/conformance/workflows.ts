import {
  Cause,
  Crypto,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { WorkflowEngine } from "effect/unstable/workflow"
import {
  Actor,
  type Caller,
  InvalidExecutionId,
  InvalidExecutionKey,
  System,
  Unauthorized,
  User,
} from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import { encodeExecutionId } from "../../identity/execution.ts"
import { routingKey } from "../../runtime/storage/codec.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"
import {
  type EngineFixture,
  engineCases,
  engineFixture,
  type EnginePrimitives,
  type EngineRun,
  eventually as eventuallyEngine,
  Flake,
  probeBody,
  ProbeInput,
  type Scenario,
  type WorkflowEngineDriver,
} from "./workflow-engine.ts"

/** Shared by the workflow actors and every workflow case. */
export interface WorkflowsFixture {
  /** Activity runs by step and key, including runs whose outcome was lost. */
  readonly runs: Map<string, number>
  /** Holds the first run of a `block` activity until the case releases it. */
  blocked: Deferred.Deferred<void> | undefined
  /** The shared engine suite's counters and gates. */
  readonly engine: EngineFixture
  /** What each `Audit.Record` turn saw, by audit key: its tenant and caller. */
  readonly audits: Map<string, { readonly tenant: string; readonly caller: Caller }>
  /** Holds a `Watch` activity, by order id, until the case releases it. */
  readonly gates: Map<string, Deferred.Deferred<void>>
}

export const workflowsFixture = (): WorkflowsFixture => ({
  runs: new Map(),
  blocked: undefined,
  engine: engineFixture(),
  audits: new Map(),
  gates: new Map(),
})

class Paid extends Actor.Event<Paid>()("Paid", { orderId: Schema.String, amount: Schema.Int }) {}

class OutOfStock extends Schema.TaggedError<OutOfStock>()("OutOfStock", {
  sku: Schema.String,
}) {}

const Ship = Actor.workflow("Ship", {
  input: { orderId: Schema.String, sku: Schema.String },
  output: Schema.String,
  errors: [OutOfStock],
  key: ({ orderId }) => orderId,
  versions: { label: { current: 2, min: 0 } },
})

const Reserve = Ship.step("reserve", {
  input: Schema.String,
  success: Schema.String,
  errors: [OutOfStock],
})

const CoolOff = Ship.sleep("cool-off")

const AwaitPaid = Ship.wait("paid", Paid)

const Grace = Ship.sleep("grace")

const FirstSignal = Ship.race("first-signal", { success: Schema.String })

const Quote = Actor.workflow("Quote", {
  input: { n: Schema.Int },
  output: Schema.String,
})

const Pay = Actor.command("Pay", {
  input: Schema.Struct({ orderId: Schema.String, amount: Schema.Int }),
})

const Charge = Actor.command("Charge", { input: Schema.String, output: Schema.Int })

const Record = Actor.command("Record", { input: Schema.String })

/** Records the tenant and caller of each call it receives. */
const Audit = Actor.make("Audit", { key: Schema.String, api: { Record } })

/** Sleeps, then calls `Audit` from an activity, so the call runs after a resume. */
const Attributed = Actor.workflow("Attributed", {
  input: { key: Schema.String },
  output: Schema.String,
  key: ({ key }) => key,
})

const AttributedNap = Attributed.sleep("nap")

const Report = Attributed.step("report", { input: Schema.String, success: Schema.String })

/** Owner-event waits and clocks in the shapes the W2 and clock cases need, by `mode`. */
const Watch = Actor.workflow("Watch", {
  input: { mode: Schema.String, orderId: Schema.String },
  output: Schema.String,
  key: ({ mode, orderId }) => `${mode}/${orderId}`,
})

const WatchHold = Watch.step("hold", { input: Schema.String, success: Schema.String })

const WatchSlow = Watch.step("slow", { input: Schema.String, success: Schema.String })

const WatchFirst = Watch.wait("first", Paid)

const WatchSecond = Watch.wait("second", Paid)

const WatchPick = Watch.race("pick", { success: Schema.String })

const WatchNapA = Watch.sleep("nap-a")

const WatchNapB = Watch.sleep("nap-b")

const WatchMarkA = Watch.step("mark-a", { input: Schema.String, success: Schema.String })

const WatchMarkB = Watch.step("mark-b", { input: Schema.String, success: Schema.String })

const WatchLong = Watch.sleep("long")

const Emit = Actor.command("Emit", {
  input: Schema.Struct({ orderId: Schema.String, amount: Schema.Int }),
})

/** Waits for a `Paid` event for order `k`, with no timeout. */
const Held = Actor.workflow("Held", { output: Schema.String })

const HeldPaid = Held.wait("paid", Paid)

/** Prunes events after an hour, so a case can see which ones a pending wait pins. */
const Keeper = Actor.make("Keeper", {
  key: Schema.String,
  events: [Paid],
  api: { Emit, Held },
  policy: { keepEvents: "1 hour" },
})

/** Creates a step constructor inside its body, which the engine must refuse. */
const Loose = Actor.workflow("Loose", { output: Schema.String })

let looseSteps = 0

const Ledger = Actor.make("Ledger", {
  key: Schema.String,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Charge },
})

const Begin = Actor.command("Begin", {
  input: Schema.Struct({ orderId: Schema.String, sku: Schema.String }),
  output: Schema.String,
})

const Shipper = Actor.make("Shipper", {
  key: Schema.String,
  events: [Paid],
  api: { Ship, Quote, Pay, Begin, Attributed, Loose, Watch },
})

// The shared engine suite's workflow, compiled to typed step constructors.
const Probe = Actor.workflow("Probe", {
  input: ProbeInput,
  output: Schema.String,
  errors: [Flake],
  key: ({ scenario, key }) => `${scenario}/${key}`,
})

const probeSteps = {
  once: Probe.step("once", { success: Schema.String, errors: [Flake] }),
  fast: Probe.step("fast", { success: Schema.String, errors: [Flake] }),
  hold: Probe.step("hold", { success: Schema.String, errors: [Flake] }),
  flaky: Probe.step("flaky", { success: Schema.String, errors: [Flake] }),
}

const Nap = Probe.sleep("nap")

const Pick = Probe.race("pick", { success: Schema.String })

/** Reports whether a body can reach an Effect `WorkflowEngine`, as `DurableDeferred.done` needs. */
const Inspect = Actor.workflow("Inspect", { output: Schema.String })

const EngineProbe = Actor.make("EngineProbe", { key: Schema.String, api: { Probe, Inspect } })

const probePrimitives: EnginePrimitives<never> = {
  activity: (name, execute) => probeSteps[name].run(undefined, () => execute),
  sleep: (_, duration) => Nap(duration),
  race: (_, effects) => Pick.run(effects),
}

const bump = (fixture: WorkflowsFixture, key: string) =>
  Effect.sync(() => fixture.runs.set(key, (fixture.runs.get(key) ?? 0) + 1))

const LedgerLive = Ledger.toLayer(
  Effect.succeed({
    Charge: Effect.fnUntraced(function* () {
      const turn = yield* Ledger.Turn
      yield* turn.state.set({ count: turn.state.count + 1 })

      return turn.state.count
    }),
  }),
)

export const workflowsLayer = (fixture: WorkflowsFixture) =>
  Layer.mergeAll(
    LedgerLive,
    Keeper.toLayer(
      Effect.succeed({
        Emit: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly amount: number
        }) {
          yield* (yield* Keeper.Turn).emit(Paid.make(input))
        }),
        Held: () =>
          HeldPaid({ where: (event) => event.orderId === "k" }).pipe(
            Effect.map(
              Option.match({ onNone: () => "unpaid", onSome: (event) => `paid-${event.amount}` }),
            ),
          ),
      }),
    ),
    Audit.toLayer(
      Effect.succeed({
        Record: Effect.fnUntraced(function* (key: string) {
          const turn = yield* Audit.Turn
          fixture.audits.set(key, { tenant: turn.ref.tenant, caller: turn.caller })
        }),
      }),
    ),
    EngineProbe.toLayer(
      Effect.succeed({
        Probe: (input: { readonly scenario: string; readonly key: string }) =>
          probeBody({ primitives: probePrimitives, fixture: fixture.engine, input }),
        Inspect: () =>
          Effect.serviceOption(WorkflowEngine.WorkflowEngine).pipe(
            Effect.map((engine) => (Option.isSome(engine) ? "present" : "absent")),
          ),
      }),
    ),
    Shipper.toLayer(
      Effect.succeed({
        Begin: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly sku: string
        }) {
          const turn = yield* Shipper.Turn
          yield* turn.emit(Paid.make({ orderId: input.orderId, amount: 3 }))

          return yield* (yield* Shipper.intents(turn.id)).Ship(input)
        }),
        Pay: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly amount: number
        }) {
          const turn = yield* Shipper.Turn

          yield* turn.emit(Paid.make(input))
        }),
        Quote: (input: { readonly n: number }) => Effect.succeed(`q-${input.n}`),
        Attributed: Effect.fnUntraced(function* (input: { readonly key: string }) {
          const wf = yield* Shipper.Workflow
          yield* AttributedNap("10 seconds")

          yield* Report.run(input.key, (key) =>
            Effect.gen(function* () {
              yield* (yield* Audit.get(key)).Record(key).pipe(Effect.orDie)

              return key
            }),
          )

          return Option.match(wf.principal, {
            onNone: () => "anonymous",
            onSome: ({ subject }) => subject,
          })
        }),
        Watch: Effect.fnUntraced(function* (input: {
          readonly mode: string
          readonly orderId: string
        }) {
          const { mode, orderId } = input

          const gated = (step: typeof WatchHold | typeof WatchSlow, label: string) =>
            step.run(orderId, (key) =>
              Effect.gen(function* () {
                yield* bump(fixture, `${label}:${key}`)
                const gate = fixture.gates.get(key)

                if (gate !== undefined) yield* Deferred.await(gate)

                return label
              }),
            )

          const marked = (step: typeof WatchMarkA | typeof WatchMarkB, label: string) =>
            step.run(orderId, (key) => bump(fixture, `${label}:${key}`).pipe(Effect.as(label)))

          const paid = (wait: typeof WatchFirst | typeof WatchSecond, where: boolean) =>
            wait({
              where: where ? (event) => event.orderId === orderId : undefined,
              timeout: "1 minute",
            }).pipe(
              Effect.map(
                Option.match({ onNone: () => "unpaid", onSome: (event) => `paid-${event.amount}` }),
              ),
            )

          switch (mode) {
            case "gated":
              yield* gated(WatchHold, "hold")

              return yield* paid(WatchFirst, true)

            case "plain":
              return yield* paid(WatchFirst, true)

            case "any":
              return yield* paid(WatchFirst, false)

            case "two":
              return `${yield* paid(WatchFirst, true)}|${yield* paid(WatchSecond, true)}`

            case "race":
              return yield* WatchPick.run([paid(WatchFirst, true), gated(WatchSlow, "slow")])

            case "clocks":
              yield* Effect.all(
                [
                  WatchNapA("5 seconds").pipe(Effect.andThen(marked(WatchMarkA, "mark-a"))),
                  WatchNapB("10 seconds").pipe(Effect.andThen(marked(WatchMarkB, "mark-b"))),
                ],
                { concurrency: "unbounded" },
              )

              return "clocks"

            case "long":
              yield* WatchLong("10 seconds")

              return yield* marked(WatchMarkA, "slept")
          }

          return yield* Effect.die(new Error(`Unknown mode ${mode}`))
        }),
        Loose: Effect.fnUntraced(function* () {
          looseSteps += 1
          const Late = Loose.step(`late-${looseSteps}`, { success: Schema.String })

          return yield* Late.run(undefined, () => Effect.succeed("ran"))
        }),
        Ship: Effect.fnUntraced(function* (input: {
          readonly orderId: string
          readonly sku: string
        }) {
          const wf = yield* Shipper.Workflow

          const reservation = yield* Reserve.run(input.sku, (sku) =>
            Effect.gen(function* () {
              yield* bump(fixture, `reserve:${input.orderId}`)

              if (sku === "none") return yield* OutOfStock.make({ sku })

              if (sku.startsWith("charge")) {
                const ledger = yield* Ledger.get(input.orderId)
                const first = yield* ledger.Charge(sku).pipe(Effect.orDie)
                const gate = fixture.blocked

                // Holds the first run between its two calls, so a rerun repeats the first.
                if (sku.includes("block") && gate !== undefined) {
                  fixture.blocked = undefined
                  yield* Deferred.await(gate)
                }

                const again = yield* ledger.Charge(sku).pipe(Effect.orDie)

                return `r-${sku}-${first}-${again}`
              }

              const gate = fixture.blocked

              if ((sku.startsWith("block") || sku.startsWith("late")) && gate !== undefined) {
                fixture.blocked = undefined
                yield* Deferred.await(gate)
              }

              // Called after the gate, so a case can move the clock past the id's expiry first.
              if (sku.startsWith("late"))
                return `r-${sku}-${yield* (yield* Ledger.get(input.orderId)).Charge(sku).pipe(Effect.orDie)}`

              return `r-${sku}`
            }),
          )

          const label = yield* wf.version("label")

          if (input.sku.startsWith("twice"))
            return `${reservation}|${yield* Reserve.run("again", (sku) => Effect.succeed(`r-${sku}`))}`

          if (input.sku.startsWith("outside"))
            yield* (yield* Ledger.get(input.orderId)).Charge(input.sku).pipe(Effect.orDie)

          if (input.sku.startsWith("sleep")) yield* CoolOff("10 seconds")

          if (input.sku.startsWith("race"))
            return `${reservation}:${yield* FirstSignal.run([
              AwaitPaid({
                where: (event) => event.orderId === input.orderId,
                timeout: "1 minute",
              }).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => "unpaid",
                    onSome: (event) => `paid-${event.amount}`,
                  }),
                ),
              ),
              Grace("10 seconds").pipe(Effect.as("grace")),
            ])}`

          if (input.sku.startsWith("wait")) {
            const paid = yield* AwaitPaid({
              where: (event) => event.orderId === input.orderId,
              timeout: "1 minute",
            })

            return Option.match(paid, {
              onNone: () => `${reservation}:unpaid`,
              onSome: (event) => `${reservation}:paid-${event.amount}`,
            })
          }

          return `${reservation}:v${label}`
        }),
      }),
    ),
  )

export const workflowsLive = (fixture: WorkflowsFixture) => Layer.mergeAll(workflowsLayer(fixture))

const reset = (fixture: WorkflowsFixture) =>
  Effect.sync(() => {
    fixture.runs.clear()
    fixture.blocked = undefined
  })

const EXPIRATION_SECONDS = 3

const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: WorkflowsFixture,
  body: Effect.Effect<A, E, ActorCluster>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners: 3,
          shardLockExpiration: `${EXPIRATION_SECONDS} seconds`,
          actors: workflowsLayer(fixture),
          as: User.make({ subject: "alice" }),
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

const advance = (runner: number, duration: Duration.Input) =>
  on(
    runner,
    ActorTest.use((test) => test.advance(duration)),
  )

/** Kills the runner owning `id` and returns a survivor once it holds the shards. */
const killOwner = (id: string) =>
  ActorCluster.use((cluster) =>
    Effect.gen(function* () {
      const ref = (yield* cluster.on(0)(Shipper.get(id))).ref
      const owner = (yield* cluster.owner(ref))!
      yield* cluster.kill(owner)
      yield* cluster.ready

      return (owner + 1) % cluster.runners
    }),
  )

const eventually = <E, R>(check: Effect.Effect<boolean, E, R>, what: string) =>
  check.pipe(
    Effect.repeat({ schedule: Schedule.spaced("25 millis"), until: (held) => held }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.die(new Error(`Timed out waiting for ${what}`)),
    }),
    Effect.asVoid,
  )

const suspendedRow = (executionId: string) =>
  eventually(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const rows = yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
        WHERE execution_id = ${executionId}`

      return rows[0]?.status === "suspended"
    }).pipe(Effect.orDie),
    "the execution to suspend",
  )

/**
 * The shared engine suite's driver for the framework engine, on the
 * conformance environment's database. Every call pins the first runtime's
 * tenant, so an execution stays reachable across `restart`.
 */
const frameworkDriver = (environment: ConformanceEnvironment) =>
  Effect.gen(function* () {
    const tenant = yield* Effect.promise(() =>
      environment.run(Effect.map(Effect.service(ActorTest), (test) => test.tenant)),
    )

    const inTenant = <A, E>(effect: Effect.Effect<A, E, ConformanceServices | Scope.Scope>) =>
      Effect.promise(() => environment.run(effect.pipe(Actor.tenant(tenant))))

    const runOf = (scenario: Scenario, key: string) =>
      Effect.gen(function* () {
        const executionId = yield* encodeExecutionId({
          tenant,
          actor: "EngineProbe",
          id: key,
          workflow: "Probe",
          key: `${scenario}/${key}`,
        }).pipe(Effect.orDie)

        const reattach = EngineProbe.run(Probe, executionId).pipe(Effect.orDie)

        return {
          executionId,
          poll: inTenant(Effect.flatMap(reattach, (run) => run.poll).pipe(Effect.orDie)),
          interrupt: inTenant(Effect.flatMap(reattach, (run) => run.interrupt).pipe(Effect.orDie)),
        } satisfies EngineRun
      })

    const start = (scenario: Scenario, key: string) =>
      inTenant(
        Effect.flatMap(EngineProbe.get(key), (probe) => probe.Probe({ scenario, key })).pipe(
          Effect.orDie,
        ),
      )

    const driver: WorkflowEngineDriver = {
      pollWhileRunning: "Suspended",
      execute: (scenario, key) =>
        start(scenario, key).pipe(Effect.flatMap((run) => inTenant(Effect.exit(run.result)))),
      start: (scenario, key) => Effect.andThen(start(scenario, key), runOf(scenario, key)),
      attach: runOf,
      awaitSuspended: (run) =>
        eventuallyEngine({
          check: inTenant(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              const rows = yield* sql<{
                status: string
              }>`SELECT status FROM actor_workflow_executions
                WHERE execution_id = ${run.executionId}`

              return rows[0]?.status === "suspended"
            }).pipe(Effect.orDie),
          ),
          what: `${run.executionId} to suspend`,
        }),
      advance: (duration) =>
        inTenant(
          ActorTest.use((test) =>
            test.advance(Duration.sum(Duration.fromInputUnsafe(duration), Duration.seconds(1))),
          ),
        ),
      // A restarted runtime's test clock starts at database time again; move
      // it back to where the old one stood, as real time would be.
      restart: Effect.gen(function* () {
        const now = (test: ActorTest["Service"]) =>
          test.now.pipe(Effect.map(DateTime.toEpochMillis))

        const before = yield* inTenant(Effect.flatMap(Effect.service(ActorTest), now))
        yield* environment.restart
        const after = yield* inTenant(Effect.flatMap(Effect.service(ActorTest), now))

        if (before > after) yield* inTenant(ActorTest.use((test) => test.advance(before - after)))
      }),
    }

    return driver
  })

/** The shared engine suite on the framework engine, plus its ours-only divergences. */
const engineConformance: ReadonlyArray<ConformanceCase> = [
  ...engineCases.map((engineCase, index): ConformanceCase => ({
    name: `workflow engine: ${engineCase.name}`,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const driver = yield* frameworkDriver(environment)

          yield* engineCase.run({
            driver,
            fixture: fixture.workflows.engine,
            expect,
            key: `engine-${index}`,
          })
        }),
      ),
  })),
  {
    name: "workflow engine: a body reaches no Effect WorkflowEngine, so external DurableDeferred completion is unsupported",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const probe = yield* EngineProbe.get("inspect")
          expect(yield* (yield* probe.Inspect({})).result).toBe("absent")
        }),
      ),
  },
]

export const workflowsConformance: ReadonlyArray<ConformanceCase> = [
  ...engineConformance,
  {
    name: "workflows: a start returns a stable execution id, records the activity once, and finishes",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("stable")
          const run = yield* shipper.Ship({ orderId: "o1", sku: "a" })
          expect(run.executionId.startsWith("w1.")).toBe(true)
          expect(yield* run.result).toBe("r-a:v2")
          const again = yield* shipper.Ship({ orderId: "o1", sku: "a" })
          expect(again.executionId).toBe(run.executionId)
          expect(yield* again.result).toBe("r-a:v2")
          expect(fixture.workflows.runs.get("reserve:o1")).toBe(1)
          const polled = yield* run.poll
          expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
          const reattached = yield* Shipper.run(Ship, run.executionId)
          expect(yield* reattached.result).toBe("r-a:v2")
        }),
      ),
  },
  {
    name: "workflows: a declared activity failure is recorded and fails the run with its class",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("failing")
          const run = yield* shipper.Ship({ orderId: "o2", sku: "none" })
          const error = yield* run.result.pipe(Effect.flip)
          expect(error).toBeInstanceOf(OutOfStock)
          expect(error).toEqual(OutOfStock.make({ sku: "none" }))
          expect(fixture.workflows.runs.get("reserve:o2")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: a durable sleep suspends and the relay resumes it when due",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("sleeping")
          const run = yield* shipper.Ship({ orderId: "o3", sku: "sleep" })
          yield* Effect.sleep("100 millis")
          const pending = yield* run.poll
          expect(Option.isSome(pending) && pending.value._tag).toBe("Suspended")
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-sleep:v2")
          expect(fixture.workflows.runs.get("reserve:o3")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: durable.workflows and durable.workflow_steps show a suspended then finished execution",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("inspected")
          const run = yield* shipper.Ship({ orderId: "o-inspect", sku: "sleep" })

          const execution = () =>
            sql<{
              execution_id: string
              tenant_id: string
              workflow: string
              workflow_key: string
              status: string
              finished: boolean
              stored: boolean | null
            }>`SELECT execution_id, tenant_id, workflow, workflow_key, status,
                finished_at IS NOT NULL AS finished, result_bytes > 0 AS stored
              FROM durable.workflows
              WHERE tenant_id = ${test.tenant} AND actor_type = 'Shipper' AND actor_id = 'inspected'`

          const steps = () =>
            sql<{ step: string; kind: string; settled: boolean; dated: boolean }>`
              SELECT step, kind, exit IS NOT NULL AS settled,
                due_at IS NOT DISTINCT FROM to_timestamp(due_at_ms::float8 / 1000) AS dated
              FROM durable.workflow_steps
              WHERE tenant_id = ${test.tenant} AND execution_id = ${run.executionId}
                AND kind IN ('activity', 'clock')
              ORDER BY started_at_ms, step`

          yield* suspendedRow(run.executionId)
          expect(yield* execution()).toEqual([
            {
              execution_id: run.executionId,
              tenant_id: test.tenant,
              workflow: "Ship",
              workflow_key: "o-inspect",
              status: "suspended",
              finished: false,
              stored: null,
            },
          ])
          expect(yield* steps()).toEqual([
            { step: "reserve", kind: "activity", settled: true, dated: true },
            { step: "cool-off", kind: "clock", settled: false, dated: true },
          ])
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-sleep:v2")
          expect(yield* execution()).toMatchObject([
            { status: "finished", finished: true, stored: true },
          ])
          expect(yield* steps()).toEqual([])
        }),
      ),
  },
  {
    name: "workflows: a wait sees a matching owner event appended after it registered",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("waiting")
          const run = yield* shipper.Ship({ orderId: "o4", sku: "wait" })
          yield* Effect.sleep("100 millis")
          yield* shipper.Pay({ orderId: "other", amount: 1 })
          yield* shipper.Pay({ orderId: "o4", amount: 7 })
          expect(yield* run.result).toBe("r-wait:paid-7")
        }),
      ),
  },
  {
    name: "workflows: a wait times out on the framework clock",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("timeout")
          const run = yield* shipper.Ship({ orderId: "o5", sku: "wait" })
          yield* Effect.sleep("100 millis")
          yield* test.advance("61 seconds")
          expect(yield* run.result).toBe("r-wait:unpaid")
        }),
      ),
  },
  {
    name: "workflows: interrupt finishes a suspended execution as interrupted",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const shipper = yield* Shipper.get("interrupt")
          const run = yield* shipper.Ship({ orderId: "o6", sku: "wait" })
          yield* Effect.sleep("100 millis")
          yield* run.interrupt
          yield* run.interrupt
          const exit = yield* run.result.pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)

          const steps = yield* sql<{ count: number }>`SELECT count(*)::int AS count
            FROM actor_workflow_step WHERE execution_id = ${run.executionId}`

          expect(steps[0]!.count).toBe(0)
        }),
      ),
  },
  {
    name: "workflows: a race whose branches all suspend resumes and records the event winner",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("race-event")
          const run = yield* shipper.Ship({ orderId: "r1", sku: "race" })
          yield* suspendedRow(run.executionId)
          yield* shipper.Pay({ orderId: "r1", amount: 5 })
          expect(yield* run.result).toBe("r-race:paid-5")
          expect(fixture.workflows.runs.get("reserve:r1")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: a race whose branches all suspend resumes and records the clock winner",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("race-clock")
          const run = yield* shipper.Ship({ orderId: "r2", sku: "race" })
          yield* suspendedRow(run.executionId)
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-race:grace")
          const again = yield* Shipper.run(Ship, run.executionId)
          expect(yield* again.result).toBe("r-race:grace")
        }),
      ),
  },
  {
    name: "workflows: rerunning one keyless start effect attaches to its execution",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const shipper = yield* Shipper.get("keyless")
          const start = shipper.Quote({ n: 1 })
          const first = yield* start
          const retried = yield* start
          expect(retried.executionId).toBe(first.executionId)
          expect(yield* retried.result).toBe("q-1")
          const fresh = yield* shipper.Quote({ n: 1 })
          expect(fresh.executionId).not.toBe(first.executionId)
        }),
      ),
  },
  {
    name: "workflows: interrupt is authorized as the execution's workflow member",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("interrupt-authz")
          const run = yield* shipper.Ship({ orderId: "a1", sku: "wait" })
          yield* suspendedRow(run.executionId)
          fixture.denied.add("Ship")
          expect(yield* run.interrupt.pipe(Effect.flip)).toMatchObject({
            reason: Unauthorized.make({ code: "access_denied" }),
          })
          fixture.denied.delete("Ship")
          yield* run.interrupt
          const exit = yield* run.result.pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.denied.delete("Ship")))),
      ),
  },
  {
    name: "workflows: a resume whose reply is lost after commit still wakes the execution on redelivery",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("resume-replay")
          const run = yield* shipper.Ship({ orderId: "rr1", sku: "sleep-rr" })
          yield* suspendedRow(run.executionId)
          yield* test.crashNext("afterCommit")
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-sleep-rr:v2")
          expect(fixture.workflows.runs.get("reserve:rr1")).toBe(1)
          expect(yield* test.receiptsFor(shipper.ref, "$workflow/resume")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: a malformed, foreign, or wrong-member execution id is InvalidExecutionId",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const bad = yield* Shipper.run(Ship, "w1.nope").pipe(Effect.flip)
          expect(bad).toBeInstanceOf(InvalidExecutionId)
          const other = yield* Shipper.run(Ship, "x1.abc").pipe(Effect.flip)
          expect(other).toBeInstanceOf(InvalidExecutionId)
        }),
      ),
  },
  {
    name: "workflows: an evicted activation resumes its suspended execution without rerunning the activity",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("evicted")
          const run = yield* shipper.Ship({ orderId: "o8", sku: "sleep-e" })
          yield* Effect.sleep("100 millis")
          yield* test.invalidate(shipper.ref)
          yield* test.advance("11 seconds")
          const reattached = yield* Shipper.run(Ship, run.executionId)
          expect(yield* reattached.result).toBe("r-sleep-e:v2")
          expect(fixture.workflows.runs.get("reserve:o8")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: a killed owner's suspended execution resumes on a survivor via its relay timer",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.workflows,
        Effect.gen(function* () {
          const id = yield* on(
            0,
            Effect.gen(function* () {
              const run = yield* (yield* Shipper.get("killed-sleep")).Ship({
                orderId: "k1",
                sku: "sleep-k",
              })

              return run.executionId
            }),
          )

          yield* on(
            0,
            eventually(
              Effect.gen(function* () {
                const polled = yield* (yield* Shipper.run(Ship, id)).poll

                return Option.isSome(polled) && Predicate.isTagged(polled.value, "Suspended")
              }),
              "the sleep to suspend",
            ),
          )
          const survivor = yield* killOwner("killed-sleep")
          yield* advance(survivor, "11 seconds")

          const result = yield* on(
            survivor,
            Effect.gen(function* () {
              return yield* (yield* Shipper.run(Ship, id)).result
            }),
          )

          expect(result).toBe("r-sleep-k:v2")
          expect(fixture.workflows.runs.get("reserve:k1")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: an activity whose runner is killed mid-run is rerun on a survivor with the same identity",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.workflows,
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.workflows.blocked = gate

          const id = yield* on(
            0,
            Effect.gen(function* () {
              const run = yield* (yield* Shipper.get("killed-activity")).Ship({
                orderId: "k2",
                sku: "block",
              })

              return run.executionId
            }),
          )

          yield* eventually(
            Effect.sync(() => fixture.workflows.runs.get("reserve:k2") === 1),
            "the activity to start",
          )
          const survivor = yield* killOwner("killed-activity")
          yield* advance(survivor, "31 seconds")

          const result = yield* on(
            survivor,
            Effect.gen(function* () {
              return yield* (yield* Shipper.run(Ship, id)).result
            }),
          )

          expect(result).toBe("r-block:v2")
          expect(fixture.workflows.runs.get("reserve:k2")).toBe(2)
          yield* Deferred.succeed(gate, undefined)
        }),
      ),
  },
  {
    name: "workflows: a turn stages a start whose wait sees that turn's own event",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("staged")
          const id = yield* shipper.Begin({ orderId: "s1", sku: "wait-s" })
          expect(yield* (yield* Shipper.run(Ship, id)).result).toBe("r-wait-s:paid-3")
          const again = yield* shipper.Ship({ orderId: "s1", sku: "wait-s" })
          expect(again.executionId).toBe(id)
          expect(yield* again.result).toBe("r-wait-s:paid-3")
        }),
      ),
  },
  {
    name: "workflows: activity actor calls get distinct ids per call and reach the receiver once each",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("charging")
          const run = yield* shipper.Ship({ orderId: "c1", sku: "charge" })
          expect(yield* run.result).toBe("r-charge-1-2:v2")
          const ledger = yield* Ledger.get("c1")
          expect(yield* test.receiptsFor(ledger.ref, "Charge")).toBe(2)
        }),
      ),
  },
  {
    name: "workflows: an event appended while a wait is registering is never lost",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)

          const results = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const shipper = yield* Shipper.get(`race-${index}`)
                const orderId = `race-${index}`
                const run = yield* shipper.Ship({ orderId, sku: "wait-race" })
                yield* shipper.Pay({ orderId, amount: index })

                return yield* run.result
              }),
            { concurrency: 5 },
          )

          expect(results).toEqual(
            Array.from({ length: 20 }, (_, index) => `r-wait-race:paid-${index}`),
          )
        }),
      ),
  },
  {
    name: "workflows: separates equal keys across tenants and owners",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const other = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie)

          const start = (tenant: string, id: string, sku: string) =>
            Effect.flatMap(Shipper.get(id), (shipper) =>
              shipper.Ship({ orderId: "same", sku }),
            ).pipe(Actor.tenant(tenant))

          const runs = [
            yield* start(test.tenant, "iso-a", "sleep-a"),
            yield* start(other, "iso-a", "sleep-other"),
            yield* start(test.tenant, "iso-b", "sleep-b"),
          ]

          expect(new Set(runs.map((run) => run.executionId)).size).toBe(3)
          yield* Effect.forEach(runs, (run) => suspendedRow(run.executionId))
          yield* test.advance("11 seconds")

          const results = yield* Effect.forEach(
            [
              [runs[0]!, test.tenant],
              [runs[1]!, other],
              [runs[2]!, test.tenant],
            ] as const,
            ([run, tenant]) => run.result.pipe(Actor.tenant(tenant)),
          )

          expect(results).toEqual(["r-sleep-a:v2", "r-sleep-other:v2", "r-sleep-b:v2"])
          expect(fixture.workflows.runs.get("reserve:same")).toBe(3)
        }),
      ),
  },
  {
    name: "workflows: writes every workflow row under the owner's routing key",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const shipper = yield* Shipper.get("routed")
          const run = yield* shipper.Ship({ orderId: "routed", sku: "sleep-routed" })
          yield* suspendedRow(run.executionId)
          const expected = String(routingKey({ ref: shipper.ref, placement: "tenant" }))

          const rows = yield* sql<{ kind: string; routing_key: string }>`
            SELECT 'execution' AS kind, routing_key::text AS routing_key FROM actor_workflow_executions
              WHERE execution_id = ${run.executionId}
            UNION ALL SELECT 'step:' || step, routing_key::text FROM actor_workflow_step
              WHERE execution_id = ${run.executionId}
            UNION ALL SELECT 'timer', routing_key::text FROM actor_outbox
              WHERE timer_key = ${`wf:${run.executionId}`}
            ORDER BY 1`

          expect(rows).toEqual([
            { kind: "execution", routing_key: expected },
            { kind: "step:cool-off", routing_key: expected },
            { kind: "step:label", routing_key: expected },
            { kind: "step:reserve", routing_key: expected },
            { kind: "timer", routing_key: expected },
          ])

          // No workflow row sits under another routing key for this owner.
          const [strays] = yield* sql<{ count: number }>`
            SELECT count(*)::int AS count FROM actor_workflow_step
            WHERE tenant_id = ${shipper.ref.tenant} AND actor_id = 'routed'
              AND routing_key <> ${BigInt(expected)}`

          expect(strays!.count).toBe(0)
          yield* ActorTest.use((test) => test.advance("11 seconds"))
          expect(yield* run.result).toBe("r-sleep-routed:v2")
        }),
      ),
  },
  {
    name: "workflows: rejects an execution id from another tenant",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const run = yield* (yield* Shipper.get("foreign")).Ship({ orderId: "f1", sku: "a" })
          expect(yield* run.result).toBe("r-a:v2")
          const other = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4).pipe(Effect.orDie)

          const foreign = yield* Shipper.run(Ship, run.executionId).pipe(
            Actor.tenant(other),
            Effect.flip,
          )

          expect(foreign).toBeInstanceOf(InvalidExecutionId)
          // The id names the Ship member, so another member of the owner rejects it too.
          expect(yield* Shipper.run(Quote, run.executionId).pipe(Effect.flip)).toBeInstanceOf(
            InvalidExecutionId,
          )
        }),
      ),
  },
  {
    name: "workflows: continues with recorded attribution after the starting caller loses access",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("revoked")
          const run = yield* shipper.Attributed({ key: "h2" })
          yield* suspendedRow(run.executionId)
          fixture.revoked.add("alice")

          // New external calls from the revoked caller are refused.
          expect(yield* shipper.Pay({ orderId: "h2", amount: 1 }).pipe(Effect.flip)).toMatchObject({
            reason: Unauthorized.make({ code: "access_denied" }),
          })

          yield* test.advance("11 seconds")

          const result = yield* Shipper.run(Attributed, run.executionId).pipe(
            Effect.flatMap((reattached) => reattached.result),
            Actor.as(User.make({ subject: "bob" })),
          )

          expect(result).toBe("alice")
          expect(fixture.workflows.audits.get("h2")).toEqual({
            tenant: test.tenant,
            caller: System.make({
              source: "workflow",
              ref: shipper.ref,
              onBehalfOf: { subject: "alice" },
            }),
          })
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.revoked.delete("alice")))),
      ),
  },
  {
    name: "workflows: denies poll to a revoked caller",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("poll-revoked")
          const run = yield* shipper.Ship({ orderId: "pr1", sku: "sleep-pr" })
          yield* suspendedRow(run.executionId)
          fixture.revoked.add("alice")
          const denied = { reason: Unauthorized.make({ code: "access_denied" }) }
          expect(yield* run.poll.pipe(Effect.flip)).toMatchObject(denied)
          expect(yield* run.result.pipe(Effect.flip)).toMatchObject(denied)
          expect(yield* run.interrupt.pipe(Effect.flip)).toMatchObject(denied)

          // Another caller with access still reads it; the revoked one never did.
          const polled = yield* Shipper.run(Ship, run.executionId).pipe(
            Effect.flatMap((reattached) => reattached.poll),
            Actor.as(User.make({ subject: "bob" })),
          )

          expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.revoked.delete("alice")))),
      ),
  },
  {
    name: "workflows: restores tenant and onBehalfOf on resume elsewhere",
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture.workflows,
        Effect.gen(function* () {
          const { id, ref, tenant } = yield* on(
            0,
            Effect.gen(function* () {
              const shipper = yield* Shipper.get("attributed")
              const run = yield* shipper.Attributed({ key: "elsewhere" })

              return { id: run.executionId, ref: shipper.ref, tenant: (yield* ActorTest).tenant }
            }),
          )

          yield* on(
            0,
            eventually(
              Effect.gen(function* () {
                const polled = yield* (yield* Shipper.run(Attributed, id)).poll

                return Option.isSome(polled) && Predicate.isTagged(polled.value, "Suspended")
              }),
              "the sleep to suspend",
            ),
          )
          const survivor = yield* killOwner("attributed")
          yield* advance(survivor, "11 seconds")

          const result = yield* on(
            survivor,
            Effect.gen(function* () {
              return yield* (yield* Shipper.run(Attributed, id)).result
            }),
          )

          expect(result).toBe("alice")
          expect(fixture.workflows.audits.get("elsewhere")).toEqual({
            tenant,
            caller: System.make({ source: "workflow", ref, onBehalfOf: { subject: "alice" } }),
          })
        }),
      ),
  },
  {
    name: "workflows: dies with ActivityOutcomeUnknown instead of calling past the expiry bound",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const gate = yield* Deferred.make<void>()
          fixture.workflows.blocked = gate
          const run = yield* (yield* Shipper.get("late")).Ship({ orderId: "late1", sku: "late" })

          yield* eventually(
            Effect.sync(() => fixture.workflows.runs.get("reserve:late1") === 1),
            "the activity to start",
          )

          // Past the attempt's derived-id expiry, minus the delivery bound.
          yield* test.advance("61 seconds")
          yield* Deferred.succeed(gate, undefined)
          const exit = yield* run.result.pipe(Effect.exit)
          expect(
            Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("ActivityOutcomeUnknown"),
          ).toBe(true)
          const ledger = yield* Ledger.get("late1")
          expect(yield* test.receiptsFor(ledger.ref, "Charge")).toBe(0)
        }),
      ),
  },
  {
    name: "workflows: interrupts once when interrupt races completion",
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const engine = fixture.workflows.engine
          const outcomes = new Set<string>()

          for (let round = 0; round < 8; round++) {
            const key = `race-${round}`
            const gate = yield* Deferred.make<void>()
            engine.gates.set(key, gate)
            const probe = yield* EngineProbe.get(key)
            const run = yield* probe.Probe({ scenario: "compensate-last", key })

            yield* eventually(
              Effect.sync(() => (engine.runs.get(`hold:${key}`) ?? 0) >= 1),
              "the activity to start",
            )

            yield* Effect.all([Deferred.succeed(gate, undefined), run.interrupt], {
              concurrency: 2,
            })

            const exit = yield* run.result.pipe(Effect.exit)
            const interrupted = Exit.isFailure(exit) && Exit.hasInterrupts(exit)

            if (!interrupted) expect(exit).toEqual(Exit.succeed("held"))
            outcomes.add(interrupted ? "interrupted" : "completed")
            // Compensation runs exactly when the interrupt won.
            expect(engine.runs.get(`compensate:${key}`) ?? 0).toBe(interrupted ? 1 : 0)

            // One terminal result: a second interrupt and a second read change nothing.
            yield* run.interrupt
            const again = yield* run.result.pipe(Effect.exit)
            expect(Exit.isFailure(again) && Exit.hasInterrupts(again)).toBe(interrupted)

            const [left] = yield* sql<{ steps: number; timers: number }>`
              SELECT (SELECT count(*)::int FROM actor_workflow_step WHERE execution_id = ${run.executionId}) AS steps,
                (SELECT count(*)::int FROM actor_outbox WHERE timer_key = ${`wf:${run.executionId}`}) AS timers`

            expect(left).toEqual({ steps: 0, timers: 0 })
            expect(engine.runs.get(`compensate:${key}`) ?? 0).toBe(interrupted ? 1 : 0)
          }

          expect(outcomes.size > 0).toBe(true)
        }),
      ),
  },
  {
    name: "workflows: rejects step writes from a stale generation",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const gate = yield* Deferred.make<void>()
          fixture.workflows.blocked = gate
          const shipper = yield* Shipper.get("stale")
          const run = yield* shipper.Ship({ orderId: "st1", sku: "block-stale" })

          yield* eventually(
            Effect.sync(() => fixture.workflows.runs.get("reserve:st1") === 1),
            "the activity to start",
          )

          // As if another runner acquired the owner while this activation's activity ran.
          yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE tenant_id = ${shipper.ref.tenant} AND actor_type = 'Shipper' AND actor_id = 'stale'`

          yield* Deferred.succeed(gate, undefined)
          yield* Effect.sleep("300 millis")

          const pending = () =>
            sql<{ exit: boolean }>`SELECT exit IS NOT NULL AS exit FROM actor_workflow_step
              WHERE execution_id = ${run.executionId} AND step = 'reserve'`

          // The stale settle wrote nothing.
          expect(yield* pending()).toEqual([{ exit: false }])
          yield* test.invalidate(shipper.ref)
          yield* test.advance("31 seconds")
          expect(yield* run.result).toBe("r-block-stale:v2")
          expect(fixture.workflows.runs.get("reserve:st1")).toBe(2)
        }),
      ),
  },
  {
    name: "workflows: deduplicates a rerun activity's actor calls by derived command id",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const gate = yield* Deferred.make<void>()
          fixture.workflows.blocked = gate
          const shipper = yield* Shipper.get("rerun-calls")
          const run = yield* shipper.Ship({ orderId: "rc1", sku: "charge-block" })
          const ledger = yield* Ledger.get("rc1")

          yield* eventually(
            test.receiptsFor(ledger.ref, "Charge").pipe(Effect.map((count) => count === 1)),
            "the first call",
          )

          // The activation goes away mid-activity; the recovery timer reruns the attempt.
          // The cases' retry window is 60 seconds, so the 30-second recovery would put
          // the rerun past the expiry bound (production's window is a day): fire it now.
          yield* test.invalidate(shipper.ref)
          const sql = yield* SqlClient.SqlClient
          const now = DateTime.toEpochMillis(yield* test.now)
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${now}
            WHERE timer_key = ${`wf:${run.executionId}`}`
          yield* test.advance("1 second")
          expect(yield* run.result).toBe("r-charge-block-1-2:v2")
          expect(fixture.workflows.runs.get("reserve:rc1")).toBe(2)
          // The rerun's first call replayed its receipt: two receiver turns, not three.
          expect(yield* test.receiptsFor(ledger.ref, "Charge")).toBe(2)
          yield* Deferred.succeed(gate, undefined)
        }),
      ),
  },
  {
    name: "workflows: replays the first result when a step is called twice",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const run = yield* (yield* Shipper.get("twice")).Ship({ orderId: "tw1", sku: "twice" })
          expect(yield* run.result).toBe("r-twice|r-twice")
          expect(fixture.workflows.runs.get("reserve:tw1")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: dies on an actor call outside an activity",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest

          const run = yield* (yield* Shipper.get("outside")).Ship({
            orderId: "out1",
            sku: "outside",
          })

          const exit = yield* run.result.pipe(Effect.exit)
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("outside a step")).toBe(
            true,
          )
          expect(yield* test.receiptsFor((yield* Ledger.get("out1")).ref, "Charge")).toBe(0)
        }),
      ),
  },
  {
    name: "workflows: dies on a constructor created inside a body with Unregistered workflow step",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const run = yield* (yield* Shipper.get("loose")).Loose({})
          const exit = yield* run.result.pipe(Effect.exit)

          expect(
            Exit.isFailure(exit) && Cause.pretty(exit.cause).includes("Unregistered workflow step"),
          ).toBe(true)
        }),
      ),
  },
  {
    name: "workflows: rejects an oversized key with InvalidExecutionKey",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const shipper = yield* Shipper.get("oversized")

          const error = yield* shipper
            .Ship({ orderId: "k".repeat(257), sku: "a" })
            .pipe(Effect.flip)

          expect(error).toBeInstanceOf(InvalidExecutionKey)
          expect(error).toMatchObject({ bytes: 257 })
        }),
      ),
  },
  {
    name: "workflows: attaches a repeated start without rewriting its markers",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("markers")
          const run = yield* shipper.Ship({ orderId: "mk1", sku: "sleep-mk" })
          yield* suspendedRow(run.executionId)

          // As if the execution had started under an older `current`.
          yield* sql`UPDATE actor_workflow_step SET version = 1
            WHERE execution_id = ${run.executionId} AND kind = 'version'`

          const again = yield* shipper.Ship({ orderId: "mk1", sku: "sleep-mk" })
          expect(again.executionId).toBe(run.executionId)

          const markers = yield* sql<{ step: string; version: number }>`
            SELECT step, version FROM actor_workflow_step
            WHERE execution_id = ${run.executionId} AND kind = 'version'`

          expect(markers).toEqual([{ step: "label", version: 1 }])
          yield* test.advance("11 seconds")
          expect(yield* again.result).toBe("r-sleep-mk:v1")
          expect(fixture.workflows.runs.get("reserve:mk1")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: resolves an event committed between start and registration",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const gate = yield* Deferred.make<void>()
          fixture.workflows.gates.set("w2-between", gate)
          const shipper = yield* Shipper.get("w2-between")
          const run = yield* shipper.Watch({ mode: "gated", orderId: "w2-between" })

          yield* eventually(
            Effect.sync(() => fixture.workflows.runs.get("hold:w2-between") === 1),
            "the activity before the wait",
          )

          // The event commits after the start and before the wait registers.
          yield* shipper.Pay({ orderId: "w2-between", amount: 4 })
          yield* Deferred.succeed(gate, undefined)
          expect(yield* run.result).toBe("paid-4")
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.workflows.gates.delete("w2-between")))),
      ),
  },
  {
    name: "workflows: resolves an event committed while the run is suspending",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("w2-suspending")
          const pause = yield* test.pauseNext("beforeWorkflowSuspend")
          const run = yield* shipper.Watch({ mode: "plain", orderId: "w2-suspending" })

          // The wait registered and scanned nothing; the run has not suspended yet.
          yield* pause.reached
          yield* shipper.Pay({ orderId: "w2-suspending", amount: 5 })
          yield* pause.release
          expect(yield* run.result).toBe("paid-5")
        }),
      ),
  },
  {
    name: "workflows: resolves an event delivered while the run is live",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const gate = yield* Deferred.make<void>()
          fixture.workflows.gates.set("w2-live", gate)
          const shipper = yield* Shipper.get("w2-live")
          const run = yield* shipper.Watch({ mode: "race", orderId: "w2-live" })

          // The wait is registered and parked while the other branch's activity still runs.
          yield* eventually(
            Effect.gen(function* () {
              const rows = yield* sql<{ step: string }>`SELECT step FROM actor_workflow_step
                WHERE execution_id = ${run.executionId} AND step = 'first'`

              return rows.length === 1 && fixture.workflows.runs.get("slow:w2-live") === 1
            }).pipe(Effect.orDie),
            "the wait to park beside the running activity",
          )

          yield* shipper.Pay({ orderId: "w2-live", amount: 6 })

          const result = yield* run.result.pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () => Effect.die(new Error("The live run was not preempted for its event")),
            }),
          )

          expect(result).toBe("paid-6")
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const gate = fixture.workflows.gates.get("w2-live")

              if (gate !== undefined) yield* Deferred.succeed(gate, undefined)
              fixture.workflows.gates.delete("w2-live")
            }),
          ),
        ),
      ),
  },
  {
    name: "workflows: resolves two sequential waits with two events",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("w2-two")
          const run = yield* shipper.Watch({ mode: "two", orderId: "w2-two" })
          yield* shipper.Pay({ orderId: "w2-two", amount: 1 })
          yield* shipper.Pay({ orderId: "w2-two", amount: 2 })
          expect(yield* run.result).toBe("paid-1|paid-2")
        }),
      ),
  },
  {
    name: "workflows: resolves concurrent waits for one tag",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("w2-concurrent")

          const runs = yield* Effect.forEach(["c1", "c2", "c3"], (orderId) =>
            shipper.Watch({ mode: "any", orderId }),
          )

          yield* Effect.forEach(runs, (run) => suspendedRow(run.executionId))
          yield* shipper.Pay({ orderId: "anyone", amount: 9 })

          expect(yield* Effect.forEach(runs, (run) => run.result, { concurrency: 3 })).toEqual([
            "paid-9",
            "paid-9",
            "paid-9",
          ])
        }),
      ),
  },
  {
    name: "workflows: settles a wait exactly once when its event and timeout race",
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest

          for (let round = 0; round < 6; round++) {
            const orderId = `w2-timeout-${round}`
            const shipper = yield* Shipper.get(orderId)
            const run = yield* shipper.Watch({ mode: "plain", orderId })
            yield* suspendedRow(run.executionId)

            const [wait] = yield* sql<{ due: string }>`SELECT due_at_ms::text AS due
              FROM actor_workflow_step WHERE execution_id = ${run.executionId} AND step = 'first'`

            // Round 0 commits the event just before the deadline; the rest race it.
            if (round === 0) {
              yield* test.advance("59 seconds")
              yield* shipper.Pay({ orderId, amount: round })
              yield* test.advance("2 seconds")
            } else
              yield* Effect.all(
                [shipper.Pay({ orderId, amount: round }), test.advance("61 seconds")],
                {
                  concurrency: 2,
                },
              )

            const result = yield* run.result

            const [event] = yield* sql<{ at: string }>`SELECT emitted_at_ms::text AS at
              FROM actor_events WHERE actor_type = 'Shipper' AND actor_id = ${orderId}
                AND tenant_id = ${shipper.ref.tenant}`

            // An event committed by the deadline always wins over the timeout.
            if (Number(event!.at) <= Number(wait!.due)) expect(result).toBe(`paid-${round}`)
            else expect([`paid-${round}`, "unpaid"]).toContain(result)

            // One recorded exit: every later read agrees.
            expect(yield* (yield* Shipper.run(Watch, run.executionId)).result).toBe(result)
          }
        }),
      ),
  },
  {
    name: "workflows: resumes two concurrent clocks at their own due times",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("clocks")
          const run = yield* shipper.Watch({ mode: "clocks", orderId: "clocks" })
          yield* suspendedRow(run.executionId)

          const marks = () =>
            ["mark-a", "mark-b"].map((label) => fixture.workflows.runs.get(`${label}:clocks`) ?? 0)

          expect(marks()).toEqual([0, 0])
          yield* test.advance("6 seconds")

          yield* eventually(
            Effect.sync(() => marks()[0] === 1),
            "the 5-second clock to resume",
          )

          yield* suspendedRow(run.executionId)
          expect(marks()).toEqual([1, 0])
          yield* test.advance("5 seconds")
          expect(yield* run.result).toBe("clocks")
          expect(marks()).toEqual([1, 1])
        }),
      ),
  },
  {
    name: "workflows: keeps a clock's due time across replays",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("long")
          const run = yield* shipper.Watch({ mode: "long", orderId: "long" })
          yield* suspendedRow(run.executionId)

          const due = () =>
            sql<{ due: string }>`SELECT due_at_ms::text AS due FROM actor_workflow_step
              WHERE execution_id = ${run.executionId} AND step = 'long'`.pipe(
              Effect.map((rows) => rows[0]?.due),
            )

          const recorded = yield* due()
          yield* test.advance("5 seconds")

          // A replay mid-sleep on a fresh activation.
          yield* test.invalidate(shipper.ref)
          const now = DateTime.toEpochMillis(yield* test.now)
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${now}
            WHERE timer_key = ${`wf:${run.executionId}`}`
          yield* test.advance("1 second")

          yield* eventually(
            test
              .receiptsFor(shipper.ref, "$workflow/resume")
              .pipe(Effect.map((count) => count > 0)),
            "the replay",
          )

          yield* suspendedRow(run.executionId)
          expect(yield* due()).toBe(recorded)
          yield* test.advance("2 seconds")
          expect(fixture.workflows.runs.get("slept:long") ?? 0).toBe(0)
          yield* test.advance("3 seconds")
          expect(yield* run.result).toBe("slept")
          expect(fixture.workflows.runs.get("slept:long")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: keeps events above an open cursor or pending wait from pruning",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const keeper = yield* Keeper.get("pinned")

          const sequences = () =>
            sql<{ sequence: string }>`SELECT sequence::text AS sequence FROM actor_events
              WHERE tenant_id = ${keeper.ref.tenant} AND actor_type = 'Keeper' AND actor_id = 'pinned'
              ORDER BY sequence`.pipe(Effect.map((rows) => rows.map((row) => Number(row.sequence))))

          for (const amount of [1, 2, 3]) yield* keeper.Emit({ orderId: "noise", amount })
          const run = yield* keeper.Held({})
          yield* suspendedRow(run.executionId)

          // Scanned past these by the wait, but still above its `wait_after`.
          for (const amount of [4, 5]) yield* keeper.Emit({ orderId: "noise", amount })
          yield* Effect.sleep("200 millis")
          yield* test.advance("2 hours")
          yield* test.cleanup
          expect(yield* sequences()).toEqual([4, 5])

          yield* keeper.Emit({ orderId: "k", amount: 6 })
          expect(yield* run.result).toBe("paid-6")

          // Once the execution finishes, nothing pins them.
          yield* test.advance("2 hours")
          yield* test.cleanup
          expect(yield* sequences()).toEqual([])
        }),
      ),
  },
]
