import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadDeployment, loadDeployments } from "./client.ts"
import { DeploymentPage, DeploymentsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("deployments client in fixture mode", () => {
  it("serves the history and one deploy by commit, and nothing for a commit never deployed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const history = yield* loadDeployments
        expect(Schema.is(DeploymentsPage)(history)).toBe(true)
        expect(history).toMatchObject({ environment: "production" })
        const live = yield* loadDeployment("a3f9c21")
        expect(Schema.is(DeploymentPage)(live)).toBe(true)
        expect(live).toMatchObject({ rollbackTo: "77be010", shift: { moved: 48_210 } })
        expect((yield* loadDeployment("77be010"))?.rollbackTo).toBeNull()
        expect(yield* loadDeployment("0000000")).toBeUndefined()
      }),
    ))
})
