import { DeadLetter, JobsSummary } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { toDeadLetter, toJobsPage } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z")

const letter = {
  id: "dl_9",
  jobName: "Charge",
  jobId: "job_31c",
  actor: "Order/ord_7c10",
  attempts: 8,
  lastError: "card_declined (provider 402)",
  since: "2026-10-03T11:19:00.000Z",
}

describe("jobs mapping", () => {
  it("keeps the dead letter's own id apart from the job id so retry and discard address the right row", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(toDeadLetter(now)(yield* decode(DeadLetter, letter))).toEqual({
          id: "dl_9",
          jobId: "job_31c",
          job: "Charge",
          actorType: "Order",
          key: "ord_7c10",
          attempts: 8,
          error: "card_declined (provider 402)",
          since: "41m",
        })
      }),
    ))

  it("maps the queue, per-type totals with readable p99, and an oldest-first throughput line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const summary = yield* decode(JobsSummary, {
          queued: 88,
          running: 312,
          retrying: 17,
          dead: 3,
          byType: [{ jobName: "Charge", done: 18_204, retried: 311, dead: 2, p99Ms: 1800 }],
          throughput: [
            { at: "2026-10-03T11:59:00.000Z", value: 55 },
            { at: "2026-10-03T11:58:00.000Z", value: 41 },
          ],
        })
        const page = toJobsPage(now)({
          summary,
          deadLetters: [yield* decode(DeadLetter, letter)],
          resolvable: true,
        })
        expect(page).toMatchObject({
          queued: 88,
          running: 312,
          retrying: 17,
          labels: ["11:58", "11:59"],
          throughput: [41, 55],
          types: [{ name: "Charge", done: 18_204, retried: 311, dead: 2, p99: "1.8 s" }],
        })
        expect(page.deadLetters.map((row) => row.id)).toEqual(["dl_9"])
      }),
    ))

  it("keeps unreported running jobs, jobs done, p99 and throughput unknown instead of zero", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const summary = yield* decode(JobsSummary, {
          queued: 0,
          running: null,
          retrying: 1,
          dead: 1,
          byType: [{ jobName: "Charge", done: null, retried: 1, dead: 1, p99Ms: null }],
          throughput: null,
        })
        const page = toJobsPage(now)({ summary, deadLetters: [], resolvable: false })
        expect(page).toMatchObject({
          queued: 0,
          running: null,
          retrying: 1,
          resolvable: false,
          labels: [],
          throughput: null,
          types: [{ name: "Charge", done: null, retried: 1, dead: 1, p99: "—" }],
        })
      }),
    ))
})
