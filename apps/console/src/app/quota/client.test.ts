import { Unavailable } from "@akter/cloud-api"
import { Effect, Option } from "effect"
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest"
import { apiResponder, type MockedAnswer, signedIn } from "../overview/testing.ts"
import { organizationCap } from "./client.ts"
import { CapNotice } from "./model.ts"

const fetch = vi.spyOn(globalThis, "fetch")

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
  vi.stubGlobal("sessionStorage", { getItem: () => null })
})

afterEach(() => {
  fetch.mockReset()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(() => fetch.mockRestore())

const capWhenUsage = (usage: MockedAnswer) => {
  fetch.mockImplementation(
    apiResponder({ ...signedIn({ status: "live" }), "/api/organizations/org_1/usage": usage })
      .respond,
  )
  return organizationCap
}

it("refuses new commands for a plan the pricing doesn't know, and stays quiet in an outage", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* capWhenUsage({
          status: 503,
          body: Unavailable.make({
            message: "The organization's plan legacy is not in the pricing configuration",
            retryAfterSeconds: 60,
            reason: "unknownPlan",
          }),
        }),
      ).toEqual(Option.some(CapNotice.UnknownPlan()))
      expect(
        yield* capWhenUsage({
          status: 503,
          body: Unavailable.make({ message: "Down", retryAfterSeconds: 60 }),
        }),
      ).toEqual(Option.none())
    }),
  ))
