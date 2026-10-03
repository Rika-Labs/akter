import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadCommands } from "./client.ts"
import { CommandsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("commands client in fixture mode", () => {
  it("carries the actor types and the opening tail, newest first", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = yield* loadCommands
        expect(Schema.is(CommandsPage)(page)).toBe(true)
        expect(page.recent).toHaveLength(14)
        expect(page.recent[0]?.sequence).toBe(13)
        expect(page.types).toContain("Order")
      }),
    ))
})
