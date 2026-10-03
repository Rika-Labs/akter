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
        expect(overview.sample).toBe(true)
        expect(Schema.is(OverviewPage)(overview.data)).toBe(true)
        const deployed = yield* loadProject("storefront")
        expect(deployed.sample).toBe(true)
        expect(Schema.is(OverviewPage)(deployed.data)).toBe(true)
        expect(deployed.data).toMatchObject({ project: "storefront" })
        const fresh = yield* loadProject("support-bot")
        expect(Schema.is(EmptyProjectPage)(fresh.data)).toBe(true)
        expect(fresh.data).toMatchObject({ project: "support-bot", region: "eu-west-1" })
        const unknown = yield* loadProject("unknown")
        expect(Schema.is(EmptyProjectPage)(unknown.data)).toBe(true)
        expect(unknown.data).toMatchObject({ region: "us-east-1" })
      }),
    ))
})
