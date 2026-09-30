import { Deferred, Effect, Exit, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { EngineProbe, OutOfStock, Ship, Shipper } from "./actors.ts"
import { eventually, reset, suspendedRow } from "./harness.ts"

/** Starts, recorded activities, durable sleeps, status, and inspection views of workflows. */
export const workflowBasicConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "workflows: a live interrupt finishes well within the recovery interval",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const engine = fixture.workflows.engine
          const key = "live-interrupt"
          const gate = yield* Deferred.make<void>()
          engine.gates.set(key, gate)
          const probe = yield* EngineProbe.get(key)
          const run = yield* probe.Probe({ scenario: "compensate-hold", key })

          yield* eventually(
            Effect.sync(() => (engine.runs.get(`hold:${key}`) ?? 0) >= 1),
            "the activity to start",
          )

          yield* run.interrupt

          const exit = yield* run.result.pipe(
            Effect.exit,
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.die(new Error("The live interrupt waited for recovery")),
            }),
          )

          expect(Exit.isFailure(exit) && Exit.hasInterrupts(exit)).toBe(true)
          expect(engine.runs.get(`compensate:${key}`)).toBe(1)
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const gate = fixture.workflows.engine.gates.get("live-interrupt")

              if (gate !== undefined) yield* Deferred.succeed(gate, undefined)
            }),
          ),
        ),
      ),
  },
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
          yield* suspendedRow(run.executionId)
          const pending = yield* run.poll
          expect(Option.isSome(pending) && pending.value._tag).toBe("Suspended")
          yield* test.advance("11 seconds")
          expect(yield* run.result).toBe("r-sleep:v2")
          expect(fixture.workflows.runs.get("reserve:o3")).toBe(1)
        }),
      ),
  },
  {
    name: "workflows: status is running while a resumed run executes and suspended only while parked",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture.workflows)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const gate = yield* Deferred.make<void>()
          fixture.workflows.gates.set("phases", gate)
          const shipper = yield* Shipper.get("phases")
          const run = yield* shipper.Watch({ mode: "phases", orderId: "phases" })

          const status = () =>
            sql<{ status: string }>`SELECT status FROM durable.workflows
              WHERE execution_id = ${run.executionId}`.pipe(Effect.map((rows) => rows[0]?.status))

          yield* suspendedRow(run.executionId)
          expect(yield* status()).toBe("suspended")

          yield* test.advance("6 seconds")

          yield* eventually(
            Effect.sync(() => fixture.workflows.runs.get("hold:phases") === 1),
            "the resumed run to reach its activity",
          )

          expect(yield* status()).toBe("running")

          yield* Deferred.succeed(gate, undefined)
          yield* suspendedRow(run.executionId)
          expect(yield* status()).toBe("suspended")
          yield* test.advance("6 seconds")
          expect(yield* run.result).toBe("phases")
          expect(yield* status()).toBe("finished")
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.workflows.gates.delete("phases")))),
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
]
