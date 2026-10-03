import { NotImplemented } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadDeployment, loadDeployments, rollBackDeployment } from "./client.ts"
import { DeploymentPage, DeploymentsPage } from "./model.ts"

beforeEach(() => {
  vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
})

const fetch = vi.spyOn(globalThis, "fetch")

afterEach(() => {
  vi.unstubAllEnvs()
  fetch.mockReset()
})

describe("deployments client in fixture mode", () => {
  it("requests no context, and a rollback fails with Sample instead of faking success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* loadDeployments
        const error = yield* rollBackDeployment("dep_1").pipe(Effect.flip)
        expect(error).toMatchObject({ kind: "Sample" })
        expect(fetch).not.toHaveBeenCalled()
      }),
    ))

  it("serves the history and one deploy by commit, and nothing for a commit never deployed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const history = yield* loadDeployments
        expect(history.sample).toBe(true)
        expect(Schema.is(DeploymentsPage)(history.data)).toBe(true)
        expect(history.data).toMatchObject({ environment: "production" })
        const live = yield* loadDeployment("a3f9c21")
        expect(live.sample).toBe(true)
        expect(Schema.is(DeploymentPage)(live.data)).toBe(true)
        expect(live.data).toMatchObject({ rollbackTo: "77be010", shift: { moved: 48_210 } })
        expect((yield* loadDeployment("77be010")).data?.rollbackTo).toBeNull()
        expect((yield* loadDeployment("0000000")).data).toBeUndefined()
      }),
    ))
})

const json = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })

const me = {
  user: null,
  identityKind: "api-key",
  activeOrganizationId: "org_1",
  organizations: [
    {
      role: "owner",
      organization: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        plan: "pro",
        createdAt: "2026-01-02T03:04:05Z",
      },
    },
  ],
}

const project = {
  id: "prj_1",
  organizationId: "org_1",
  name: "Storefront",
  slug: "storefront",
  status: "live",
  homeRegion: "us-east-1",
  createdAt: "2026-01-02T03:04:05Z",
}

const serve = (deployments: (request: URL) => Response) =>
  fetch.mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
    if (url.pathname.endsWith("/deployments")) return Promise.resolve(deployments(url))
    return Promise.resolve(json(JSON.stringify([project])))
  })

const deploymentRequests = () =>
  fetch.mock.calls.filter(([input]) =>
    new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/deployments"),
  )

describe("deployments client against the live API", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
  })

  it("marks live data as not sample", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        serve(() => json(JSON.stringify({ items: [], nextCursor: null })))
        const history = yield* loadDeployments
        expect(history.sample).toBe(false)
        expect(history.data).toMatchObject({ environment: "production", deploys: [] })
        expect((yield* loadDeployment("abcdef0")).data).toBeUndefined()
      }),
    ))

  it("fails with InvalidResponse when the history repeats a cursor", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        serve(() => json(JSON.stringify({ items: [], nextCursor: "same" })))
        const error = yield* loadDeployment("abcdef0").pipe(Effect.flip)
        expect(error).toMatchObject({ kind: "InvalidResponse" })
        expect(deploymentRequests()).toHaveLength(2)
      }),
    ))

  it("stops at 100 pages of ever-new cursors with InvalidResponse", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let page = 0
        serve(() => json(JSON.stringify({ items: [], nextCursor: `cursor-${++page}` })))
        const error = yield* loadDeployment("abcdef0").pipe(Effect.flip)
        expect(error).toMatchObject({ kind: "InvalidResponse" })
        expect(deploymentRequests()).toHaveLength(100)
      }),
    ))

  it("fails on a NotImplemented context instead of serving fixtures or reaching the endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(
          NotImplemented.make({ operation: "account.me" }),
        )
        fetch.mockResolvedValue(
          new Response(body, { status: 501, headers: { "content-type": "application/json" } }),
        )
        const error = yield* loadDeployments.pipe(Effect.flip)
        expect(error).toMatchObject({ kind: "NotImplemented" })
        expect(deploymentRequests()).toHaveLength(0)
      }),
    ))
})
