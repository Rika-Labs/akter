import { Forbidden, KnownPlan, NotImplemented, Unavailable } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { AppRoute } from "../navigation/routes.ts"
import { Action } from "../shell/action.ts"
import { loadSettings, setSpendLimit } from "./client.ts"
import { endpointsSlice, environmentsSlice, keysSlice } from "./fixtures.ts"
import { SettingsSection } from "./model.ts"
import { blockedBySample, isSample } from "./sample.ts"

const fetch = vi.spyOn(globalThis, "fetch")

afterEach(() => {
  fetch.mockReset()
})

afterAll(() => fetch.mockRestore())

const reply = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } })

const json = (body: Schema.Json) => reply(JSON.stringify(body))

const organization = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  plan: KnownPlan.make({ id: "pro" }),
  createdAt: "2026-09-01T00:00:00.000Z",
}

const project = {
  id: "prj_1",
  organizationId: "org_1",
  name: "Storefront",
  slug: "storefront",
  status: "live",
  homeRegion: "us-east-1",
  createdAt: "2026-09-01T00:00:00.000Z",
}

const pathOf = (input: Request | URL | string): string =>
  new URL(input instanceof Request ? input.url : input).pathname

const respond = (routes: Readonly<Record<string, () => Response>>) =>
  fetch.mockImplementation((input) => {
    const path = pathOf(input)
    const handler = routes[path]
    return Promise.resolve(handler === undefined ? reply("{}", 404) : handler())
  })

const requested = () => fetch.mock.calls.map(([input]) => pathOf(input))

const identity = {
  "/api/me": () =>
    json({
      user: null,
      identityKind: "session",
      activeOrganizationId: "org_1",
      organizations: [{ organization, role: "owner" }],
    }),
  "/api/organizations/org_1/projects": () => json([project]),
}

const notImplemented = (operation: string) =>
  Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(NotImplemented.make({ operation }))

const liveEndpoints = {
  "/api/projects/prj_1/environments/production/endpoints": () =>
    json({
      httpBaseUrl: "https://live.akter.cloud",
      webSocketUrl: "wss://live.akter.cloud/ws",
      openApiPath: "/openapi.json",
      mcpPath: "/mcp",
    }),
}

const usageBody = {
  period: "2026-09",
  meters: [],
  commandsPerDay: [],
  byProject: [],
  pricing: { freeCommands: 0, readCommandWeight: 1, storagePerGbCents: 0 },
}

const billingBody = {
  plan: {
    ...KnownPlan.make({ id: "free" }),
    name: "Free",
    basePriceCents: 0,
    currency: "usd",
    renewsAt: null,
    monthToDateEstimateCents: 0,
  },
  paymentMethod: null,
  billingEmail: null,
  spendLimit: { limitCents: null, currentSpendCents: 0 },
}

const tier = (
  id: string,
  name: string,
  basePriceCents: number,
  features: ReadonlyArray<string>,
) => ({
  id,
  name,
  basePriceCents,
  currency: "usd",
  allowances: { commands: 1_000_000, commandCap: null, storageGb: 1, concurrentConnections: 10 },
  overage: { commandCentsPerMillion: 0, storageCentsPerGbMonth: 0 },
  features,
  provisional: basePriceCents > 0,
})

const catalogBody = {
  plans: [tier("free", "Free", 0, []), tier("pro", "Pro", 2_500, ["checkout"])],
  readCommandWeight: 0.2,
  provisional: true,
}

describe("loadSettings", () => {
  it("reads only the endpoints the route renders", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        respond({
          ...identity,
          "/api/organizations/org_1/usage": () => json(usageBody),
          "/api/organizations/org_1/billing": () => json(billingBody),
          "/api/organizations/org_1/billing/invoices": () => json([]),
          "/api/billing/plans": () => json(catalogBody),
        })
        const { data: page, sample } = yield* loadSettings(AppRoute.SettingsUsage())
        expect(page.usage?.period).toBe("2026-09")
        expect(page.billing).toBe(null)
        expect(page.members).toEqual([])
        expect(sample).toBe(false)
        expect(page.sampleSections).toEqual([])
        expect(requested().toSorted()).toEqual(["/api/me", "/api/organizations/org_1/usage"])
        fetch.mockClear()
        const { data: billing } = yield* loadSettings(AppRoute.SettingsBilling())
        expect(billing.plans?.plans.map((plan) => [plan.name, plan.checkout])).toEqual([
          ["Free", null],
          ["Pro", "pro"],
        ])
        expect(billing.billing?.plan).toMatchObject({ id: "free", name: "Free" })
        expect(requested().toSorted()).toEqual([
          "/api/billing/plans",
          "/api/me",
          "/api/organizations/org_1/billing",
          "/api/organizations/org_1/billing/invoices",
          "/api/organizations/org_1/usage",
        ])
      }),
    ))

  it("words a 503 from billing calmly instead of as a lost connection", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unavailable = yield* Schema.encodeEffect(Schema.fromJsonString(Unavailable))(
          Unavailable.make({
            message: "The organization's plan legacy is not in the pricing configuration",
            retryAfterSeconds: 60,
          }),
        )
        respond({
          ...identity,
          "/api/organizations/org_1/usage": () => reply(unavailable, 503),
          "/api/organizations/org_1/billing": () => reply(unavailable, 503),
          "/api/organizations/org_1/billing/invoices": () => json([]),
          "/api/billing/plans": () => json(catalogBody),
        })
        for (const route of [AppRoute.SettingsUsage(), AppRoute.SettingsBilling()]) {
          const error = yield* Effect.flip(loadSettings(route))
          expect(error).toMatchObject({
            kind: "Unavailable",
            message:
              "Billing can’t be read right now, so plan and usage figures aren’t shown. Try again in a minute.",
          })
        }
      }),
    ))

  it("loads Billing and Usage for a plan the pricing doesn't know instead of failing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unknownPlan = yield* Schema.encodeEffect(Schema.fromJsonString(Unavailable))(
          Unavailable.make({
            message: "The organization's plan legacy is not in the pricing configuration",
            retryAfterSeconds: 60,
            reason: "unknownPlan",
          }),
        )
        respond({
          ...identity,
          "/api/organizations/org_1/usage": () => reply(unknownPlan, 503),
          "/api/organizations/org_1/billing": () => reply(unknownPlan, 503),
          "/api/organizations/org_1/billing/invoices": () => json([]),
          "/api/billing/plans": () => json(catalogBody),
        })
        for (const route of [AppRoute.SettingsUsage(), AppRoute.SettingsBilling()]) {
          const { data: page, sample } = yield* loadSettings(route)
          expect(page.unknownPlan).toBe(true)
          expect(page.billing).toBe(null)
          expect(page.usage).toBe(null)
          expect(sample).toBe(false)
        }
      }),
    ))

  it("says a spend limit wasn't saved for an unknown plan, and is unconfirmed in an outage", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const encode = Schema.encodeEffect(Schema.fromJsonString(Unavailable))
        const unknownPlan = yield* encode(
          Unavailable.make({
            message: "Unknown plan",
            retryAfterSeconds: 60,
            reason: "unknownPlan",
          }),
        )
        const outage = yield* encode(Unavailable.make({ message: "Down", retryAfterSeconds: 60 }))
        let body = unknownPlan
        respond({
          ...identity,
          "/api/organizations/org_1/billing/spend-limit": () => reply(body, 503),
        })
        expect(yield* Effect.flip(setSpendLimit(50_000))).toMatchObject({
          kind: "Unavailable",
          message:
            "This organization’s plan isn’t recognised, so the spend limit wasn’t saved. Contact support.",
        })
        body = outage
        expect(yield* Effect.flip(setSpendLimit(50_000))).toMatchObject({
          kind: "Unavailable",
          message:
            "Billing couldn’t confirm the spend limit right now. Reload in a minute to see whether it was saved.",
        })
      }),
    ))

  it("falls back to a fixture for the one unimplemented endpoint, not for its neighbours", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("apiKeys.list")
        respond({
          ...identity,
          "/api/organizations/org_1/api-keys": () => reply(unimplemented, 501),
          ...liveEndpoints,
        })
        const { data: page, sample } = yield* loadSettings(AppRoute.SettingsKeys())
        expect(page.keys).toEqual(keysSlice.keys)
        expect(page.endpoints[0]).toEqual({ label: "HTTP", value: "https://live.akter.cloud" })
        expect(sample).toBe(true)
        expect(page.sampleSections).toEqual(["keys"])
        expect(isSample(page, "keys")).toBe(true)
        expect(isSample(page, "endpoints")).toBe(false)
      }),
    ))

  it("keeps live keys actionable when only the endpoints are sample", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("projects.getEndpoints")
        respond({
          ...identity,
          "/api/organizations/org_1/api-keys": () =>
            json([
              {
                id: "key_1",
                organizationId: "org_1",
                name: "deploy",
                prefix: "ak_live",
                lastFour: "9d2c",
                permission: "write",
                projectId: null,
                createdAt: "2026-09-01T00:00:00.000Z",
                createdBy: { kind: "user", id: "usr_1", name: "Maya" },
                lastUsedAt: null,
                expiresAt: null,
                revokedAt: null,
              },
            ]),
          "/api/projects/prj_1/environments/production/endpoints": () => reply(unimplemented, 501),
        })
        const { data: page, sample } = yield* loadSettings(AppRoute.SettingsKeys())
        expect(sample).toBe(true)
        expect(page.sampleSections).toEqual(["endpoints"])
        expect(page.endpoints).toEqual(endpointsSlice.endpoints)
        expect(page.keys.map((key) => key.name)).toEqual(["deploy"])
        expect(isSample(page, "keys")).toBe(false)
        const create = Action.CreateKey({ name: "ci", permission: "read", projectScoped: false })
        expect(blockedBySample(page, create)).toBe(false)
        expect(blockedBySample(page, Action.RevokeKey({ id: "key_1", name: "deploy" }))).toBe(false)
      }),
    ))

  it("keeps the live environment list when one variables endpoint is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("environmentVariables.list")
        respond({
          ...identity,
          "/api/projects/prj_1/environments": () =>
            json([{ name: "staging", projectId: "prj_1", currentDeploymentId: null }]),
          "/api/projects/prj_1/environments/staging/variables": () => reply(unimplemented, 501),
        })
        const { data: page, sample } = yield* loadSettings(AppRoute.SettingsEnvironment())
        expect(page.environments.map((entry) => entry.environment)).toEqual(["staging"])
        expect(page.environments[0]?.variables).toEqual(
          environmentsSlice.environments?.find((entry) => entry.environment === "staging")
            ?.variables,
        )
        expect(sample).toBe(true)
        expect(page.sampleSections).toEqual(["environments"])
      }),
    ))

  it("keeps live variables beside the one environment whose variables are sample", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("environmentVariables.list")
        respond({
          ...identity,
          "/api/projects/prj_1/environments": () =>
            json([
              { name: "production", projectId: "prj_1", currentDeploymentId: null },
              { name: "staging", projectId: "prj_1", currentDeploymentId: null },
            ]),
          "/api/projects/prj_1/environments/production/variables": () =>
            json([
              {
                name: "LIVE_ONLY",
                usedBy: [],
                updatedAt: "2026-10-01T00:00:00.000Z",
                updatedBy: null,
              },
            ]),
          "/api/projects/prj_1/environments/staging/variables": () => reply(unimplemented, 501),
        })
        const { data: page } = yield* loadSettings(AppRoute.SettingsEnvironment())
        expect(page.environments.map((entry) => entry.environment)).toEqual([
          "production",
          "staging",
        ])
        expect(page.environments[0]?.variables.map((entry) => entry.name)).toEqual(["LIVE_ONLY"])
        expect(page.sampleSections).toEqual(["environments"])
      }),
    ))

  it("keeps the live region catalog when only the running regions are not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("regions.list")
        respond({
          ...identity,
          "/api/regions": () =>
            json([
              { id: "us-east-1", city: "Ashburn" },
              { id: "us-west-2", city: "Portland" },
            ]),
          "/api/projects/prj_1/environments/production/regions": () => reply(unimplemented, 501),
        })
        const { data: page, sample } = yield* loadSettings(AppRoute.SettingsRegions())
        expect(page.regions).toEqual([
          { id: "us-east-1", city: "Ashburn", role: "Home" },
          { id: "us-west-2", city: "Portland", role: "Available" },
        ])
        expect(sample).toBe(true)
        expect(page.sampleSections).toEqual(["regions"])
      }),
    ))

  it("keeps the live running regions when only the catalog is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("regions.catalog")
        respond({
          ...identity,
          "/api/regions": () => reply(unimplemented, 501),
          "/api/projects/prj_1/environments/production/regions": () =>
            json([
              {
                region: { id: "us-west-2", city: "Boise" },
                home: true,
                tenantCount: 0,
                database: { engine: "postgres", version: "17", sizeBytes: 0 },
                storage: { usedBytes: 0, limitBytes: 0 },
                cpuPercent: 0,
                connections: { used: 0, limit: 0 },
                runners: 0,
                shardGroup: "g1",
                backups: { pointInTimeRecovery: false, latestBackupAt: null },
                largestTables: [],
              },
            ]),
        })
        const { data: page } = yield* loadSettings(AppRoute.SettingsRegions())
        expect(page.regions).toEqual([
          { id: "us-west-2", city: "Boise", role: "Home" },
          { id: "us-east-1", city: "Virginia", role: "Available" },
        ])
        expect(page.sampleSections).toEqual(["regions"])
      }),
    ))

  it("never takes its organization or project from a fixture", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("account.me")
        respond({ "/api/me": () => reply(unimplemented, 501) })
        const organization = yield* Effect.flip(loadSettings(AppRoute.SettingsOrganization()))
        expect(organization.kind).toBe("NotImplemented")
        const keys = yield* Effect.flip(loadSettings(AppRoute.SettingsKeys()))
        expect(keys.kind).toBe("NotImplemented")
      }),
    ))

  it("never takes its project from a fixture when the project list is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* notImplemented("projects.list")
        respond({
          "/api/me": identity["/api/me"],
          "/api/organizations/org_1/projects": () => reply(unimplemented, 501),
        })
        const error = yield* Effect.flip(loadSettings(AppRoute.SettingsDomains()))
        expect(error.kind).toBe("NotImplemented")
        expect(requested()).not.toContain("/api/projects/prj_storefront/domains")
      }),
    ))

  it("marks every section sample and reads nothing when fixtures are forced", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
        const [keys, appearance] = yield* Effect.all([
          loadSettings(AppRoute.SettingsKeys()),
          loadSettings(AppRoute.SettingsAppearance()),
        ]).pipe(Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())))
        expect(keys.sample).toBe(true)
        expect(keys.data.sampleSections).toEqual(SettingsSection.literals)
        expect(keys.data.keys).toEqual(keysSlice.keys)
        expect(appearance.sample).toBe(true)
        expect(requested()).toEqual([])
      }),
    ))

  it("fails instead of faking data when an endpoint answers with an error", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const forbidden = yield* Schema.encodeEffect(Schema.fromJsonString(Forbidden))(
          Forbidden.make({ message: "Owners only." }),
        )
        respond({
          ...identity,
          "/api/organizations/org_1/billing": () => reply(forbidden, 403),
          "/api/organizations/org_1/billing/invoices": () => json([]),
          "/api/billing/plans": () => json(catalogBody),
          "/api/organizations/org_1/usage": () => json(usageBody),
        })
        const error = yield* Effect.flip(loadSettings(AppRoute.SettingsBilling()))
        expect(error.kind).toBe("Forbidden")
      }),
    ))
})
