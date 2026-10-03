import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discardDeadLetter, loadJobs, retryDeadLetter } from "./client.ts"
import { JobsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("jobs client in fixture mode", () => {
  it("serves the fixture jobs with the dead letter ids retry addresses", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { data: page, sample } = yield* loadJobs
        expect(sample).toBe(true)
        expect(Schema.is(JobsPage)(page)).toBe(true)
        expect(page.deadLetters.map((letter) => letter.id)).toEqual([
          "job_31c",
          "job_31f",
          "job_2aa",
        ])
      }),
    ))
})

describe("jobs mutations in fixture mode", () => {
  it("fail with Sample and never reach the API instead of faking success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fetch = vi.spyOn(globalThis, "fetch")
        for (const action of [retryDeadLetter("job_31c"), discardDeadLetter("job_31c")]) {
          const error = yield* action.pipe(Effect.flip)
          expect(error).toMatchObject({ kind: "Sample" })
        }
        expect(fetch).not.toHaveBeenCalled()
        fetch.mockRestore()
      }),
    ))
})
