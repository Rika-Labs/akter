import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadRegions } from "./client.ts"
import { RegionsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("regions client in fixture mode", () => {
  it("serves the fixture regions and tables", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { data: page, sample } = yield* loadRegions
        expect(sample).toBe(true)
        expect(Schema.is(RegionsPage)(page)).toBe(true)
        expect(page.regions.map((region) => region.id)).toEqual(["us-east-1", "eu-west-1"])
      }),
    ))
})
