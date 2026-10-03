import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadJobs } from "./client.ts"
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
        const page = yield* loadJobs
        expect(Schema.is(JobsPage)(page)).toBe(true)
        expect(page.deadLetters.map((letter) => letter.id)).toEqual([
          "job_31c",
          "job_31f",
          "job_2aa",
        ])
      }),
    ))
})
