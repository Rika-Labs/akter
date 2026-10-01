import { DateTime, Deferred, Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Keeper, Shipper, Watch, type WorkflowsFixture } from "./actors.ts"
import { eventually, reset, suspendedRow } from "./harness.ts"

/** Owner-event waits, clocks, and retention pins of workflows. */
export const workflowWaitConformance: ReadonlyArray<ConformanceCase<WorkflowsFixture>> = [
  {
    name: "workflows: resolves an event committed between start and registration",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const gate = yield* Deferred.make<void>()
          fixture.gates.set("w2-between", gate)
          const shipper = yield* Shipper.get("w2-between")
          const run = yield* shipper.Watch({ mode: "gated", orderId: "w2-between" })

          yield* eventually(
            Effect.sync(() => fixture.runs.get("hold:w2-between") === 1),
            "the activity before the wait",
          )

          yield* shipper.Pay({ orderId: "w2-between", amount: 4 })
          yield* Deferred.succeed(gate, undefined)
          expect(yield* run.result).toBe("paid-4")
        }).pipe(Effect.ensuring(Effect.sync(() => fixture.gates.delete("w2-between")))),
      ),
  },
  {
    name: "workflows: resolves an event committed while the run is suspending",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("w2-suspending")
          const pause = yield* test.pauseNext("beforeWorkflowSuspend")
          const run = yield* shipper.Watch({ mode: "plain", orderId: "w2-suspending" })

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
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const gate = yield* Deferred.make<void>()
          fixture.gates.set("w2-live", gate)
          const shipper = yield* Shipper.get("w2-live")
          const run = yield* shipper.Watch({ mode: "race", orderId: "w2-live" })

          yield* eventually(
            Effect.gen(function* () {
              const rows = yield* sql<{ step: string }>`SELECT step FROM actor_workflow_step
                WHERE execution_id = ${run.executionId} AND step = 'first'`

              return rows.length === 1 && fixture.runs.get("slow:w2-live") === 1
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
              const gate = fixture.gates.get("w2-live")

              if (gate !== undefined) yield* Deferred.succeed(gate, undefined)
              fixture.gates.delete("w2-live")
            }),
          ),
        ),
      ),
  },
  {
    name: "workflows: a parked wait resolves by the event its sibling activity emits as that sibling finishes",
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const gate = yield* Deferred.make<void>()
          fixture.gates.set("sibling-gated", gate)
          const ids = ["sibling-gated", "sibling-0", "sibling-1", "sibling-2", "sibling-3"]

          const runs = yield* Effect.forEach(ids, (id) =>
            Shipper.get(id).pipe(
              Effect.flatMap((shipper) => shipper.Watch({ mode: "sibling", orderId: id })),
            ),
          )

          yield* eventually(
            Effect.gen(function* () {
              const rows = yield* sql<{ step: string }>`SELECT step FROM actor_workflow_step
                WHERE execution_id = ${runs[0]!.executionId} AND step = 'first' AND exit IS NULL`

              return rows.length === 1 && fixture.runs.get("emit:sibling-gated") === 1
            }).pipe(Effect.orDie),
            "the wait to park beside the gated sibling",
          )

          yield* Deferred.succeed(gate, undefined)

          const results = yield* Effect.forEach(runs, (run) => run.result, {
            concurrency: "unbounded",
          }).pipe(
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () => Effect.die(new Error("A run never resumed for its sibling's event")),
            }),
          )

          expect(results).toEqual(ids.map(() => "paid-8|emitted"))

          for (const [index, id] of ids.entries()) {
            const [events] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
              FROM actor_events WHERE actor_type = 'Shipper' AND actor_id = ${id} AND event = 'Paid'`

            const [leftover] = yield* sql<{ steps: number; timers: number }>`SELECT
              (SELECT count(*)::int FROM actor_workflow_step
                WHERE execution_id = ${runs[index]!.executionId}) AS steps,
              (SELECT count(*)::int FROM actor_outbox
                WHERE timer_key = ${`wf:${runs[index]!.executionId}`}) AS timers`

            expect({ id, events: events!.count, ...leftover }).toEqual({
              id,
              events: 1,
              steps: 0,
              timers: 0,
            })
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              fixture.gates.delete("sibling-gated")
            }),
          ),
        ),
      ),
  },
  {
    name: "workflows: a workflow command that kicks a running execution commits and answers while the owner call its activity makes waits behind it",
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest
          const id = "kick-behind"
          const gate = yield* Deferred.make<void>()
          fixture.gates.set(id, gate)
          const shipper = yield* Shipper.get(id)
          const run = yield* shipper.Watch({ mode: "sibling", orderId: id })

          yield* eventually(
            Effect.sync(() => fixture.runs.get(`emit:${id}`) === 1),
            "the sibling activity to start",
          )

          const committing = yield* test.pauseNext("beforeCommit")

          const reattach = yield* shipper
            .Watch({ mode: "sibling", orderId: id })
            .pipe(Effect.forkChild({ startImmediately: true }))

          yield* committing.reached
          const arriving = yield* test.pauseNext("queued")
          yield* Deferred.succeed(gate, undefined)
          yield* arriving.reached
          yield* arriving.release
          yield* Effect.sleep("500 millis")
          yield* committing.release

          const reattached = yield* Fiber.join(reattach).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.die(new Error("The kicking turn never answered behind the owner call")),
            }),
          )

          expect(reattached.executionId).toBe(run.executionId)
          expect(yield* run.result).toBe("paid-8|emitted")
          expect(fixture.runs.get(`emit:${id}`)).toBe(1)
          expect(yield* test.receiptsFor(shipper.ref, "Pay")).toBe(1)

          const [leftover] = yield* sql<{ steps: number; timers: number }>`SELECT
            (SELECT count(*)::int FROM actor_workflow_step
              WHERE execution_id = ${run.executionId}) AS steps,
            (SELECT count(*)::int FROM actor_outbox
              WHERE timer_key = ${`wf:${run.executionId}`}) AS timers`

          expect(leftover).toEqual({ steps: 0, timers: 0 })
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              fixture.gates.delete("kick-behind")
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
          yield* reset(fixture)
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
          yield* reset(fixture)
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
          yield* reset(fixture)
          const sql = yield* SqlClient.SqlClient
          const test = yield* ActorTest

          for (let round = 0; round < 6; round++) {
            const orderId = `w2-timeout-${round}`
            const shipper = yield* Shipper.get(orderId)
            const run = yield* shipper.Watch({ mode: "plain", orderId })
            yield* suspendedRow(run.executionId)

            const [wait] = yield* sql<{ due: string }>`SELECT due_at_ms::text AS due
              FROM actor_workflow_step WHERE execution_id = ${run.executionId} AND step = 'first'`

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

            if (Number(event!.at) <= Number(wait!.due)) expect(result).toBe(`paid-${round}`)
            else expect([`paid-${round}`, "unpaid"]).toContain(result)

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
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("clocks")
          const run = yield* shipper.Watch({ mode: "clocks", orderId: "clocks" })
          yield* suspendedRow(run.executionId)

          const marks = () =>
            ["mark-a", "mark-b"].map((label) => fixture.runs.get(`${label}:clocks`) ?? 0)

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
          yield* reset(fixture)
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
          expect(fixture.runs.get("slept:long") ?? 0).toBe(0)
          yield* test.advance("3 seconds")
          expect(yield* run.result).toBe("slept")
          expect(fixture.runs.get("slept:long")).toBe(1)
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

          for (const amount of [4, 5]) yield* keeper.Emit({ orderId: "noise", amount })
          yield* Effect.sleep("200 millis")
          yield* test.advance("2 hours")
          yield* test.cleanup
          expect(yield* sequences()).toEqual([4, 5])

          yield* keeper.Emit({ orderId: "k", amount: 6 })
          expect(yield* run.result).toBe("paid-6")

          yield* test.advance("2 hours")
          yield* test.cleanup
          expect(yield* sequences()).toEqual([])
        }),
      ),
  },
]
