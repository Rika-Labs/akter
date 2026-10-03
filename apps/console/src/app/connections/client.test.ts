import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConnections } from "./client.ts"
import { ConnectionsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("connections client in fixture mode", () => {
  it("serves the fixture connections", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { data: page, sample } = yield* loadConnections
        expect(sample).toBe(true)
        expect(Schema.is(ConnectionsPage)(page)).toBe(true)
        expect(page.byType).toHaveLength(4)
      }),
    ))
})
