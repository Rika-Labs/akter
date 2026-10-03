import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadWorkflows } from "./client.ts"
import { WorkflowsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("workflows client in fixture mode", () => {
  it("serves fixture workflows, schedules and the timer history", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = yield* loadWorkflows
        expect(Schema.is(WorkflowsPage)(page)).toBe(true)
        expect(page.runs).toHaveLength(5)
        expect(page.fired?.values).toHaveLength(48)
      }),
    ))
})
