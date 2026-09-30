import { Cause, DateTime, Deferred, Effect, Exit } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { InvalidExecutionKey } from "../../../index.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { EngineProbe, Ledger, Shipper } from "./actors.ts"
import { eventually, reset, suspendedRow } from "./harness.ts"

/** Expiry bounds, fencing, deduplication, and body-shape guards of workflows. */
export const workflowGuardConformance: ReadonlyArray<ConformanceCase> = [
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
            expect(engine.runs.get(`compensate:${key}`) ?? 0).toBe(interrupted ? 1 : 0)

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

          yield* sql`UPDATE actor_generations SET generation = generation + 1
            WHERE tenant_id = ${shipper.ref.tenant} AND actor_type = 'Shipper' AND actor_id = 'stale'`

          yield* Deferred.succeed(gate, undefined)
          yield* Effect.sleep("300 millis")

          const pending = () =>
            sql<{ exit: boolean }>`SELECT exit IS NOT NULL AS exit FROM actor_workflow_step
              WHERE execution_id = ${run.executionId} AND step = 'reserve'`

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

          yield* test.invalidate(shipper.ref)
          const sql = yield* SqlClient.SqlClient
          const now = DateTime.toEpochMillis(yield* test.now)
          yield* sql`UPDATE actor_outbox SET due_at_ms = ${now}
            WHERE timer_key = ${`wf:${run.executionId}`}`
          yield* test.advance("1 second")
          expect(yield* run.result).toBe("r-charge-block-1-2:v2")
          expect(fixture.workflows.runs.get("reserve:rc1")).toBe(2)
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
]
