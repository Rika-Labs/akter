import { Redacted } from "effect"
import { describe, expect, it } from "vitest"
import {
  assertOperation,
  assertStripeMode,
  layoutOf,
  relativeName,
  runnerFlyConfig,
} from "./config.ts"

const application = (stage: string) => {
  const layout = layoutOf(stage)
  if (layout.kind === "shared") throw new Error(`${stage} runs no application`)
  return layout
}

describe("stage layout", () => {
  it("places every stage at its own hostnames, customer domain and Fly organization", () => {
    expect(layoutOf("prod")).toMatchObject({
      kind: "prod",
      flyOrganization: "rika-labs-prod",
      sleeps: false,
      hosts: {
        site: "akter.dev",
        console: "app.akter.dev",
        api: "api.akter.dev",
        edge: "edge.akter.dev",
      },
      customerDomain: "akter.run",
      emailFrom: "Akter <auth@akter.dev>",
      apps: { api: "akter-prod-api", edge: "akter-prod-edge" },
      runnerPrefix: "akter-prod-run-",
      stripeMode: "live",
      edgeMachines: 2,
    })
    expect(layoutOf("pr-42")).toMatchObject({
      kind: "pr",
      pullRequest: 42,
      flyOrganization: "rika-labs-dev",
      sleeps: true,
      hosts: {
        site: "pr-42.preview.akter.dev",
        console: "app-pr-42.preview.akter.dev",
        api: "api-pr-42.preview.akter.dev",
        edge: "edge-pr-42.preview.akter.dev",
      },
      customerDomain: "pr-42.preview.akter.run",
      emailFrom: "Akter Preview <auth-preview@akter.dev>",
      apps: { api: "akter-pr-42-api", site: "akter-pr-42-site" },
      runnerPrefix: "akter-pr42-run-",
      stripeMode: "test",
      edgeMachines: 1,
    })
  })

  it("gives the preview stage no services, hostnames or customer domain to hold", () => {
    expect(layoutOf("preview")).toEqual({ kind: "shared", stage: "preview" })
  })

  it("gives two previews no app name or hostname in common", () => {
    const first = application("pr-7")
    const second = application("pr-77")
    const names = (layout: ReturnType<typeof application>) => [
      ...Object.values(layout.apps),
      ...Object.values(layout.hosts),
      layout.customerDomain,
    ]
    expect(names(first).filter((name) => names(second).includes(name))).toEqual([])
  })

  it.each([
    "dev",
    "staging",
    "production",
    "main",
    "Preview",
    "preview-1",
    "pr-",
    "pr-0",
    "pr-007",
    "pr-12a",
    "pr-1234567",
    "PR-1",
    "dev-2",
    "prod ",
    "",
  ])("refuses the stage %j before any provider is reached", (stage) => {
    expect(() => layoutOf(stage)).toThrow("Unsupported stage")
  })

  it("keeps every name a Fly app and a Vercel record can hold", () => {
    for (const stage of ["prod", "pr-999999"]) {
      const layout = application(stage)
      for (const name of Object.values(layout.apps)) expect(name).toMatch(/^[a-z][a-z0-9-]{0,29}$/)
      expect(layout.runnerPrefix.length).toBeLessThanOrEqual(22)
    }
  })
})

describe("operations", () => {
  it("never destroys production or the preview stage from CI, but lets an operator", () => {
    for (const stage of ["prod", "preview"]) {
      expect(() => assertOperation({ operation: "destroy", stage, ci: true })).toThrow(
        `Stage ${stage} is never destroyed from CI`,
      )
      expect(assertOperation({ operation: "destroy", stage, ci: false }).stage).toBe(stage)
      expect(assertOperation({ operation: "deploy", stage, ci: true }).stage).toBe(stage)
    }
    expect(assertOperation({ operation: "destroy", stage: "pr-3", ci: true }).kind).toBe("pr")
  })

  it("refuses an unknown stage for every operation", () => {
    for (const operation of ["deploy", "destroy"] as const)
      expect(() => assertOperation({ operation, stage: "staging", ci: false })).toThrow(
        "Unsupported stage",
      )
  })
})

describe("billing mode", () => {
  it("keeps live keys on production and test keys on every preview", () => {
    const live = Redacted.make("sk_live_abc")
    const test = Redacted.make("sk_test_abc")
    expect(() => assertStripeMode({ layout: application("prod"), key: live })).not.toThrow()
    expect(() => assertStripeMode({ layout: application("prod"), key: test })).toThrow("live mode")
    expect(() => assertStripeMode({ layout: application("pr-5"), key: test })).not.toThrow()
    expect(() => assertStripeMode({ layout: application("pr-5"), key: live })).toThrow("test mode")
    expect(() =>
      assertStripeMode({ layout: application("pr-5"), key: Redacted.make("rk_test_abc") }),
    ).not.toThrow()
    expect(() =>
      assertStripeMode({ layout: application("pr-5"), key: Redacted.make("pk_test_abc") }),
    ).toThrow()
  })
})

describe("runner configuration", () => {
  it("names the stage's own Fly organization and runner app prefix", () => {
    expect(JSON.parse(runnerFlyConfig(application("pr-9")))).toEqual({
      organization: "rika-labs-dev",
      regions: { "us-east-1": { region: "iad" } },
      port: 8080,
      appPrefix: "akter-pr9-run-",
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
    })
    expect(JSON.parse(runnerFlyConfig(application("prod"))).organization).toBe("rika-labs-prod")
  })
})

describe("record names", () => {
  it("is empty for the apex and relative inside the zone", () => {
    expect(relativeName({ zone: "akter.dev", host: "akter.dev" })).toBe("")
    expect(relativeName({ zone: "akter.dev", host: "api-pr-4.preview.akter.dev" })).toBe(
      "api-pr-4.preview",
    )
    expect(relativeName({ zone: "akter.run", host: "*.pr-4.preview.akter.run" })).toBe(
      "*.pr-4.preview",
    )
  })

  it("refuses a host outside the zone, including one that only shares a suffix", () => {
    expect(() => relativeName({ zone: "akter.dev", host: "api.akter.run" })).toThrow("not inside")
    expect(() => relativeName({ zone: "akter.dev", host: "notakter.dev" })).toThrow("not inside")
  })
})
