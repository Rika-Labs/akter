import { Deferred, Effect, Exit, Option, Predicate } from "effect"
import { InvalidExecutionId } from "../../../../../packages/akter/src/index.ts"
import { ActorTest } from "../../../../../packages/akter/src/testing/actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import { RuntimeControl } from "../../../../../packages/akter/src/runtime/drain.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { EngineProbe, Probe, Ship, Shipper, type WorkflowsFixture } from "./actors.ts"
import { advance, eventually, killOwner, on, reset, suspendedRow, withCluster } from "./harness.ts"
import { SqlClient } from "effect/sql"

/** Redelivery, execution-id validation, eviction, owner death, and drain recovery of workflows. */
export const workflowRecoveryConformance: ReadonlyArray<ConformanceCase<WorkflowsFixture>> = [
  {
    name: "workflows: a resume whose reply is lost after commit still wakes the execution on redelivery",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("resume-replay")
          const run = yield* shipper.Ship({ orderId: "rr1", sku: "sleep-rr" })
          yield* suspendedRow(run.executionId)
          yield* test.crashNext("afterCommit")
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-sleep-rr:v2")
          expect(fixture.runs.get("reserve:rr1")).toBe(1)
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
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("evicted")
          const run = yield* shipper.Ship({ orderId: "o8", sku: "sleep-e" })
          yield* suspendedRow(run.executionId)
          yield* test.invalidate(shipper.ref)
          yield* test.advance("11 seconds")
          const reattached = yield* Shipper.run(Ship, run.executionId)
          expect(yield* reattached.result).toBe("r-sleep-e:v2")
          expect(fixture.runs.get("reserve:o8")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: a killed owner's suspended execution resumes on a survivor via its relay timer",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 90_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
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
          expect(fixture.runs.get("reserve:k1")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: abandons a running execution on drain and resumes it on another runner",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.blocked = gate

          const id = yield* on(
            0,
            Effect.gen(function* () {
              const run = yield* (yield* Shipper.get("drained-activity")).Ship({
                orderId: "d1",
                sku: "block",
              })

              return run.executionId
            }),
          )

          yield* eventually(
            Effect.sync(() => fixture.runs.get("reserve:d1") === 1),
            "the activity to start",
          )

          const cluster = yield* ActorCluster
          const ref = (yield* cluster.on(0)(Shipper.get("drained-activity"))).ref
          const owner = (yield* cluster.owner(ref))!
          const survivor = (owner + 1) % cluster.runners

          expect(
            yield* on(
              owner,
              RuntimeControl.use((control) => control.drain({ deadline: "5 seconds" })),
            ),
          ).toEqual({ outcome: "clean", interruptedTurns: 0, interruptedJobs: 0 })
          yield* cluster.shutdown(owner)
          yield* cluster.ready
          yield* advance(survivor, "31 seconds")

          const result = yield* on(
            survivor,
            Effect.gen(function* () {
              return yield* (yield* Shipper.run(Ship, id)).result
            }),
          )

          expect(result).toBe("r-block:v2")
          expect(fixture.runs.get("reserve:d1")).toBe(2)
          yield* Deferred.succeed(gate, undefined)
        }),
      ),
  },
  {
    name: "workflows: replays an interrupted execution's compensation on a survivor when its runner dies mid-compensation, and records the interrupt once",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        Effect.gen(function* () {
          const engine = fixture.engine
          const key = "compensation-kill"
          const hold = yield* Deferred.make<void>()
          const compensating = yield* Deferred.make<void>()
          engine.gates.set(key, hold)
          engine.gates.set(`compensate:${key}`, compensating)
          engine.runs.clear()

          const executionId = yield* on(
            0,
            Effect.gen(function* () {
              const run = yield* (yield* EngineProbe.get(key)).Probe({
                scenario: "compensate-block",
                key,
              })

              return run.executionId
            }),
          )

          yield* eventually(
            Effect.sync(() => (engine.runs.get(`hold:${key}`) ?? 0) >= 1),
            "the activity to start",
          )
          yield* on(
            0,
            Effect.flatMap(EngineProbe.run(Probe, executionId), (run) => run.interrupt),
          )
          yield* eventually(
            Effect.sync(() => (engine.runs.get(`compensate:${key}`) ?? 0) >= 1),
            "the compensation to start",
          )

          const survivor = yield* ActorCluster.use((cluster) =>
            Effect.gen(function* () {
              const ref = (yield* cluster.on(0)(EngineProbe.get(key))).ref
              const owner = (yield* cluster.owner(ref))!
              yield* cluster.kill(owner)
              yield* cluster.ready

              return (owner + 1) % cluster.runners
            }),
          )

          yield* advance(survivor, "31 seconds")
          yield* eventually(
            Effect.sync(() => (engine.runs.get(`compensate:${key}`) ?? 0) >= 2),
            "the survivor to run the compensation again",
          )
          yield* Deferred.succeed(compensating, undefined)

          const exit = yield* on(
            survivor,
            Effect.flatMap(EngineProbe.run(Probe, executionId), (run) => run.result).pipe(
              Effect.exit,
            ),
          )

          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
          expect((engine.runs.get(`compensate:${key}`) ?? 0) >= 2).toBe(true)

          const rows = yield* on(
            survivor,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient

              return yield* sql<{ status: string; steps: number }>`SELECT status,
                  (SELECT count(*)::int FROM actor_workflow_step
                    WHERE execution_id = ${executionId}) AS steps
                FROM actor_workflow_executions WHERE execution_id = ${executionId}`
            }).pipe(Effect.orDie),
          )

          expect(rows).toEqual([{ status: "finished", steps: 0 }])
          yield* Deferred.succeed(hold, undefined)
        }),
      ),
  },
  {
    name: "workflows: an activity whose runner is killed mid-run is rerun on a survivor with the same identity",
    requiresFreshDatabase: true,
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      withCluster(
        environment,
        fixture,
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>()
          fixture.blocked = gate

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
            Effect.sync(() => fixture.runs.get("reserve:k2") === 1),
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
          expect(fixture.runs.get("reserve:k2")).toBe(2)
          yield* Deferred.succeed(gate, undefined)
        }),
      ),
  },
]
