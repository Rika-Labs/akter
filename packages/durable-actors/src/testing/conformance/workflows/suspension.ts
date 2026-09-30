import { Effect, Exit } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Unauthorized } from "../../../index.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Ship, Shipper } from "./actors.ts"
import { reset, suspendedRow } from "./harness.ts"

/** Waits, races, interrupts, and keyless restarts of suspended workflows. */
export const workflowSuspensionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "workflows: a wait sees a matching owner event appended after it registered",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const shipper = yield* Shipper.get("waiting")
          const run = yield* shipper.Ship({ orderId: "o4", sku: "wait" })
          yield* suspendedRow(run.executionId)
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
          yield* suspendedRow(run.executionId)
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
          yield* suspendedRow(run.executionId)
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
]
