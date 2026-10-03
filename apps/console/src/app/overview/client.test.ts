import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadOverview, loadProject } from "./client.ts"
import { EmptyProjectPage, OverviewPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("overview client in fixture mode", () => {
  it("serves the fixture overview and tells a deployed project from a new one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const overview = yield* loadOverview
        expect(Schema.is(OverviewPage)(overview)).toBe(true)
        const deployed = yield* loadProject("storefront")
        expect(Schema.is(OverviewPage)(deployed)).toBe(true)
        expect(deployed).toMatchObject({ project: "storefront" })
        const fresh = yield* loadProject("support-bot")
        expect(Schema.is(EmptyProjectPage)(fresh)).toBe(true)
        expect(fresh).toMatchObject({ project: "support-bot", region: "eu-west-1" })
        const unknown = yield* loadProject("unknown")
        expect(Schema.is(EmptyProjectPage)(unknown)).toBe(true)
        expect(unknown).toMatchObject({ region: "us-east-1" })
      }),
    ))
})
