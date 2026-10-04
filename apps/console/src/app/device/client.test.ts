import { KnownPlan } from "@akter/cloud-api"
import { Effect } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiResponder } from "../overview/testing.ts"
import { lookUpDevice } from "./client.ts"
import { DevicePage, DeviceReview } from "./model.ts"

const fetch = vi.spyOn(globalThis, "fetch")

const membership = (id: string, name: string) => ({
  organization: {
    id,
    name,
    slug: name.toLowerCase(),
    plan: KnownPlan.make({ id: "free" }),
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  role: "owner",
})

const me = (organizations: ReadonlyArray<ReturnType<typeof membership>>, active: string) => ({
  body: {
    user: {
      id: "u_ada",
      name: "Ada Lovelace",
      email: "ada@acme.dev",
      emailVerified: true,
      image: null,
    },
    identityKind: "session",
    activeOrganizationId: active,
    organizations,
  },
})

const pending = { body: { user_code: "WDJBMJHT", status: "pending", client_id: "akter-cli" } }

const review = (access: string) =>
  DevicePage.make({
    step: DeviceReview.make({
      code: "WDJBMJHT",
      client: "Akter CLI",
      clientDetail: "The Akter command line on your computer",
      name: "Ada Lovelace",
      email: "ada@acme.dev",
      access,
    }),
  })

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
  vi.stubGlobal("location", { origin: "http://localhost", pathname: "/device", search: "" })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

afterAll(() => fetch.mockRestore())

describe("device review over the live API", () => {
  it("names every organization an approved session can act in, not the browser's active one", () => {
    const responder = apiResponder({
      "/auth/device": pending,
      "/api/me": me(
        [membership("org_first", "First"), membership("org_second", "Second")],
        "org_second",
      ),
    })
    fetch.mockImplementation(responder.respond)
    return Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* lookUpDevice("WDJBMJHT")).toEqual(review("All your organizations (2)"))
        expect(responder.seen).toEqual(["/auth/device?user_code=WDJBMJHT", "/api/me"])
      }),
    )
  })

  it("names the one organization of a single membership", () => {
    fetch.mockImplementation(
      apiResponder({
        "/auth/device": pending,
        "/api/me": me([membership("org_acme", "Acme")], "org_acme"),
      }).respond,
    )
    return Effect.runPromise(
      lookUpDevice("WDJBMJHT").pipe(Effect.map((page) => expect(page).toEqual(review("Acme")))),
    )
  })
})
