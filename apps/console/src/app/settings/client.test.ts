import { Forbidden, NotImplemented } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { AppRoute } from "../navigation/routes.ts"
import { loadSettings } from "./client.ts"
import { keysSlice } from "./fixtures.ts"

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
  plan: "pro",
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

describe("loadSettings", () => {
  it("reads only the endpoints the route renders", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        respond({
          ...identity,
          "/api/organizations/org_1/usage": () =>
            json({
              period: "2026-09",
              meters: [],
              commandsPerDay: [],
              byProject: [],
              pricing: { freeCommands: 0, readCommandWeight: 1, storagePerGbCents: 0 },
            }),
        })
        const page = yield* loadSettings(AppRoute.SettingsUsage())
        expect(page.usage?.period).toBe("2026-09")
        expect(page.billing).toBeNull()
        expect(requested()).toEqual(["/api/me", "/api/organizations/org_1/usage"])
      }),
    ))

  it("falls back to a fixture for the one unimplemented endpoint, not for its neighbours", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unimplemented = yield* Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(
          NotImplemented.make({ operation: "apiKeys.list" }),
        )
        respond({
          ...identity,
          "/api/organizations/org_1/api-keys": () => reply(unimplemented, 501),
          "/api/projects/prj_1/environments/production/endpoints": () =>
            json({
              httpBaseUrl: "https://live.akter.cloud",
              webSocketUrl: "wss://live.akter.cloud/ws",
              openApiPath: "/openapi.json",
              mcpPath: "/mcp",
            }),
        })
        const page = yield* loadSettings(AppRoute.SettingsKeys())
        expect(page.keys).toEqual(keysSlice.keys)
        expect(page.endpoints[0]).toEqual({ label: "HTTP", value: "https://live.akter.cloud" })
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
        })
        const error = yield* Effect.flip(loadSettings(AppRoute.SettingsBilling()))
        expect(error.kind).toBe("Forbidden")
      }),
    ))
})
