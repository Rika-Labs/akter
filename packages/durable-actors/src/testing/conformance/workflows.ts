import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
} from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Actor, InvalidExecutionId, Unauthorized, User } from "../../index.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

/** Shared by the workflow actors and every workflow case. */
export interface WorkflowsFixture {
  /** Activity runs by step and key, including runs whose outcome was lost. */
  readonly runs: Map<string, number>
  /** Holds the first run of a `block` activity until the case releases it. */
  blocked: Deferred.Deferred<void> | undefined
}

export const workflowsFixture = (): WorkflowsFixture => ({ runs: new Map(), blocked: undefined })

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
  api: { Ship, Quote, Pay, Begin },
})

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
        Quote: Effect.fnUntraced(function* (input: { readonly n: number }) {
          return `q-${input.n}`
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
                const again = yield* ledger.Charge(sku).pipe(Effect.orDie)

                return `r-${sku}-${first}-${again}`
              }

              const gate = fixture.blocked

              if (sku.startsWith("block") && gate !== undefined) {
                fixture.blocked = undefined
                yield* Deferred.await(gate)
              }

              return `r-${sku}`
            }),
          )

          const label = yield* wf.version("label")

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

export const workflowsConformance: ReadonlyArray<ConformanceCase> = [
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
]
