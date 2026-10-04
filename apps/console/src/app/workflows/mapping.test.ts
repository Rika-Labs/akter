import { Schedule, TimersSummary, Workflow } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toSchedule, toWorkflowRun, toWorkflowsPage } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z")

const workflow = (fields: Record<string, Schema.Json>) => ({
  id: "wf_01",
  name: "Fulfil",
  actor: "Order/ord_8f2c",
  step: { index: 3, total: 5, name: "ship" },
  waitingFor: { kind: "event", name: "Shipped" },
  startedAt: "2026-10-03T10:00:00.000Z",
  status: "waiting",
  ...fields,
})

describe("workflow mapping", () => {
  it("tells a wait on an event from a wait on a timer and a finished run from a failed one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parse = (fields: Record<string, Schema.Json>) =>
          decode(Workflow, workflow(fields)).pipe(Effect.map((value) => toWorkflowRun(now)(value)))
        expect(yield* parse({})).toEqual({
          id: "wf_01",
          workflow: "Fulfil",
          actorType: "Order",
          key: "ord_8f2c",
          step: "ship · 3 of 5",
          waitingFor: "event Shipped",
          started: "2h",
          status: "Waiting",
        })
        const timer = yield* parse({ waitingFor: { kind: "timer", name: "23:00" } })
        expect(timer).toMatchObject({ status: "Sleeping", waitingFor: "timer 23:00" })
        expect(yield* parse({ status: "running", waitingFor: null })).toMatchObject({
          status: "Running",
          waitingFor: "—",
        })
        expect((yield* parse({ status: "completed", waitingFor: null })).status).toBe("Done")
        expect((yield* parse({ status: "failed", waitingFor: null })).status).toBe("Failed")
      }),
    ))

  it("writes the contract's 1-based step index unchanged at the first and final step", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* decode(Workflow, workflow({}))
        const at = (index: number, total: number) =>
          toWorkflowRun(now)({ ...base, step: { index, total, name: "ship" } }).step
        expect(at(1, 5)).toBe("ship · 1 of 5")
        expect(at(5, 5)).toBe("ship · 5 of 5")
        expect(at(1, 1)).toBe("ship · 1 of 1")
      }),
    ))

  it("writes a schedule's last run and a never-run schedule differently", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* decode(Schedule, {
          name: "nightly",
          actorPattern: "NightlyReport/singleton",
          cron: "0 2 * * *",
          lastRun: { at: "2026-10-03T02:00:00.000Z", outcome: "ok", durationMs: 252_000 },
          nextRunAt: "2026-10-03T21:00:00.000Z",
        })
        const fresh = yield* decode(Schedule, {
          name: "health",
          actorPattern: "Device/*",
          cron: "* * * * *",
          lastRun: null,
          nextRunAt: "2026-10-03T12:00:21.000Z",
        })
        expect(toSchedule(now)(ran)).toEqual({
          name: "nightly",
          target: "NightlyReport/singleton",
          cron: "0 2 * * *",
          lastRun: "ok · 4 m 12 s",
          nextRun: "in 9 h",
        })
        expect(toSchedule(now)(fresh)).toMatchObject({ lastRun: "—", nextRun: "in 21 s" })
      }),
    ))

  it("counts runs by state, marks a truncated page and finds the soonest schedule", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const workflows = yield* Effect.forEach(
          [
            workflow({ id: "a" }),
            workflow({ id: "b", status: "running", waitingFor: null }),
            workflow({ id: "c", status: "running", waitingFor: null }),
            workflow({ id: "d", status: "completed", waitingFor: null }),
          ],
          (fields) => decode(Workflow, fields),
        )
        const schedules = yield* Effect.forEach(
          [
            { name: "late", nextRunAt: "2026-10-03T20:00:00.000Z" },
            { name: "soon", nextRunAt: "2026-10-03T12:06:00.000Z" },
          ],
          (fields) =>
            decode(Schedule, { actorPattern: "A/*", cron: "* * * * *", lastRun: null, ...fields }),
        )
        const timers = yield* decode(TimersSummary, {
          pending: 26_040,
          nextFireAt: "2026-10-03T12:00:00.400Z",
        })
        const page = toWorkflowsPage(now)({ workflows, truncated: true, timers, schedules })
        expect(page).toMatchObject({
          running: 2,
          waitingOnEvents: 1,
          truncated: true,
          timers: 26_040,
          nextTimer: "400 ms",
          nextSchedule: "soon in 6 min",
        })
        expect(page.fired).toBeUndefined()
        const idle = toWorkflowsPage(now)({
          workflows: [],
          truncated: false,
          timers: yield* decode(TimersSummary, { pending: 0, nextFireAt: null }),
          schedules: [],
        })
        expect(idle).toMatchObject({ nextTimer: null, nextSchedule: null, running: 0 })
      }),
    ))

  it("writes a step without a known total by its index and a finished run without a step as a dash", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const counted = yield* decode(
          Workflow,
          workflow({
            status: "running",
            waitingFor: null,
            step: { index: 2, total: null, name: "pay" },
          }),
        )
        expect(toWorkflowRun(now)(counted).step).toBe("pay · step 2")
        const finished = yield* decode(
          Workflow,
          workflow({ status: "completed", waitingFor: null, step: null }),
        )
        const row = toWorkflowRun(now)(finished)
        expect(row).toMatchObject({ step: "—", status: "Done", waitingFor: "—" })
        expect(Object.values(row).join(" ")).not.toMatch(/null|NaN|undefined/)
      }),
    ))

  it("shows sample schedules on a live page without naming a next schedule from them", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const timers = yield* decode(TimersSummary, { pending: 0, nextFireAt: null })
        const page = toWorkflowsPage(now)({
          workflows: [],
          truncated: false,
          timers,
          schedules: [],
          sampleSchedules: [
            {
              name: "nightly",
              target: "Report/*",
              cron: "0 2 * * *",
              lastRun: "—",
              nextRun: "in 9 h",
            },
          ],
        })
        expect(page).toMatchObject({ schedulesSample: true, nextSchedule: null, nextTimer: null })
        expect(page.schedules.map((schedule) => schedule.name)).toEqual(["nightly"])
        const live = toWorkflowsPage(now)({
          workflows: [],
          truncated: false,
          timers,
          schedules: [],
        })
        expect(live).toMatchObject({ schedulesSample: false, schedules: [] })
      }),
    ))
})
