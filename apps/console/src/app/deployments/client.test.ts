import { Conflict, KnownPlan, NotImplemented } from "@akter/cloud-api"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadDeployment,
  loadDeployments,
  redeployDeployment,
  rollBackDeployment,
} from "./client.ts"
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
        const redeploy = yield* redeployDeployment("dep_1").pipe(Effect.flip)
        expect(redeploy).toMatchObject({ kind: "Sample" })
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
        expect(live.data).toMatchObject({ shift: { moved: 48_210 }, rolledBackFrom: null })
        expect(live.data?.rollbackTargets.map((target) => target.commit)).toEqual([
          "77be010",
          "5d2e7c3",
          "1c0d4a8",
          "e91f6b2",
        ])
        expect((yield* loadDeployment("77be010")).data?.rollbackTargets).toEqual([])
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
        plan: KnownPlan.make({ id: "pro" }),
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

const missing = (id: string) =>
  json(`{"_tag":"NotFound","resource":"deployment","id":"${id}"}`, 404)

const serve = (deployments: (request: URL) => Response) =>
  fetch.mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
    if (url.pathname.endsWith("/deployments")) return Promise.resolve(deployments(url))
    const detail = url.pathname.match(/\/deployments\/([^/]+)$/)?.[1]
    if (detail !== undefined) return Promise.resolve(missing(detail))
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

  const deployment = (fields: Record<string, Schema.Json>) => ({
    id: "dep_x",
    projectId: "prj_1",
    environment: "production",
    commitSha: "a3f9c21d5e8b7a0c4f6d1e2b3a495867c0d1e2f3",
    message: "Add refunds",
    author: { name: "dallen", image: null },
    regions: ["us-east-1"],
    runnerCount: 2,
    durationMs: 40_000,
    status: "drained",
    rolledBackFrom: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    ...fields,
  })

  const serveHistory = (pages: ReadonlyArray<ReadonlyArray<Record<string, Schema.Json>>>) =>
    fetch.mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
      if (url.pathname.endsWith("/build-log"))
        return Promise.resolve(json(JSON.stringify({ lines: [], complete: true })))
      const detail = url.pathname.match(/\/deployments\/([^/]+)$/)?.[1]
      if (detail !== undefined) {
        const found = pages.flat().find((item) => item["id"] === detail)
        return Promise.resolve(
          found === undefined
            ? missing(detail)
            : json(JSON.stringify({ ...found, steps: [], runners: [] })),
        )
      }
      if (url.pathname.endsWith("/deployments")) {
        const index = Number(url.searchParams.get("cursor")?.slice(1) ?? "0")
        const nextCursor = index + 1 < pages.length ? `p${String(index + 1)}` : null
        return Promise.resolve(json(JSON.stringify({ items: pages[index], nextCursor })))
      }
      return Promise.resolve(json(JSON.stringify([project])))
    })

  const live = deployment({
    id: "dep_live",
    commitSha: "a3f9c21d5e8b7a0c4f6d1e2b3a495867c0d1e2f3",
    status: "live",
    createdAt: "2026-10-03T10:00:00.000Z",
  })

  it("lists only earlier successful same-environment deployments as rollback targets", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        serveHistory([
          [
            live,
            deployment({ id: "dep_failed", commitSha: "bbbbbbb", status: "failed" }),
            deployment({
              id: "dep_staging",
              commitSha: "ccccccc",
              environment: "staging",
              createdAt: "2026-10-02T10:00:00.000Z",
            }),
            deployment({
              id: "dep_drained",
              commitSha: "ddddddd",
              createdAt: "2026-10-02T09:00:00.000Z",
            }),
            deployment({
              id: "dep_rolled",
              commitSha: "eeeeeee",
              status: "rolled-back",
              createdAt: "2026-10-01T09:00:00.000Z",
              rolledBackFrom: "dep_drained",
            }),
          ],
        ])
        const loaded = yield* loadDeployment("a3f9c21")
        expect(loaded.sample).toBe(false)
        expect(loaded.data?.rollbackTargets.map((target) => target.id)).toEqual([
          "dep_drained",
          "dep_rolled",
        ])
        serveHistory([
          [
            live,
            deployment({
              id: "dep_rolled",
              commitSha: "eeeeeee",
              status: "rolled-back",
              rolledBackFrom: "dep_unseen",
            }),
          ],
        ])
        expect((yield* loadDeployment("eeeeeee")).data).toMatchObject({
          rolledBackFrom: { id: "dep_unseen" },
          rollbackTargets: [],
        })
      }),
    ))

  it("opens an earlier deployment by id when a newer deployment shares its commit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const restored = deployment({
          id: "dep_restored",
          commitSha: "ddddddd",
          status: "live",
          rolledBackFrom: "dep_original",
          createdAt: "2026-10-03T12:00:00.000Z",
        })
        const original = deployment({
          id: "dep_original",
          commitSha: "ddddddd",
          message: "Original release",
          createdAt: "2026-10-02T09:00:00.000Z",
        })
        serveHistory([
          [restored, deployment({ id: "dep_between", commitSha: "bbbbbbb" })],
          [original],
        ])
        expect((yield* loadDeployment("dep_original")).data?.deploy).toMatchObject({
          id: "dep_original",
          message: "Original release",
        })
        expect((yield* loadDeployment("ddddddd")).data?.deploy).toMatchObject({
          id: "dep_restored",
        })
      }),
    ))

  it("prefers an exact id over a commit and never falls back from an unknown id", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const newer = deployment({
          id: "dep_newer",
          commitSha: "ddddddd000000000000000000000000000000000",
          status: "live",
          createdAt: "2026-10-03T12:00:00.000Z",
        })
        const named = deployment({
          id: "ddddddd",
          commitSha: "1234567",
          message: "Deployment whose id looks like a commit",
          createdAt: "2026-10-02T09:00:00.000Z",
        })
        serveHistory([[newer, named]])
        expect((yield* loadDeployment("ddddddd")).data?.deploy).toMatchObject({
          id: "ddddddd",
          message: "Deployment whose id looks like a commit",
        })
        fetch.mockClear()
        expect((yield* loadDeployment("dep_unknown")).data).toBeUndefined()
        expect(deploymentRequests()).toHaveLength(0)
        expect((yield* loadDeployment("ddddddd0")).data?.deploy).toMatchObject({ id: "dep_newer" })
        expect((yield* loadDeployment("DDDDDDD0")).data?.deploy).toMatchObject({ id: "dep_newer" })
      }),
    ))

  it("keeps paging a live deployment until a target appears, and stops at the history end without one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        serveHistory([
          [live, deployment({ id: "dep_failed", commitSha: "bbbbbbb", status: "failed" })],
          [deployment({ id: "dep_drained", commitSha: "ddddddd" })],
          [deployment({ id: "dep_older", commitSha: "fffffff" })],
        ])
        const found = yield* loadDeployment("a3f9c21")
        expect(found.data?.rollbackTargets.map((target) => target.id)).toEqual(["dep_drained"])
        expect(deploymentRequests()).toHaveLength(2)

        fetch.mockClear()
        serveHistory([
          [live],
          [deployment({ id: "dep_failed", commitSha: "bbbbbbb", status: "failed" })],
        ])
        expect((yield* loadDeployment("a3f9c21")).data?.rollbackTargets).toEqual([])
        expect(deploymentRequests()).toHaveLength(2)
      }),
    ))

  it("starts again from the first page when a cursor goes stale, and never reports the API down", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const history = [
          [live, deployment({ id: "dep_failed", commitSha: "bbbbbbb", status: "failed" })],
          [deployment({ id: "dep_drained", commitSha: "ddddddd" })],
        ]
        for (const stale of [
          () => json('{"_tag":"NotFound","resource":"cursor","id":"p1"}', 404),
          () => json('{"_tag":"HttpApiSchemaError","message":"bad cursor"}', 400),
        ]) {
          fetch.mockClear()
          let refusals = 0
          fetch.mockImplementation((input) => {
            const url = new URL(input instanceof Request ? input.url : String(input))
            if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
            if (url.pathname.endsWith("/build-log"))
              return Promise.resolve(json(JSON.stringify({ lines: [], complete: true })))
            const detail = url.pathname.match(/\/deployments\/([^/]+)$/)?.[1]
            if (detail !== undefined)
              return Promise.resolve(json(JSON.stringify({ ...live, steps: [], runners: [] })))
            if (url.pathname.endsWith("/deployments")) {
              const cursor = url.searchParams.get("cursor")
              if (cursor !== null && refusals === 0) {
                refusals += 1
                return Promise.resolve(stale())
              }
              const index = cursor === null ? 0 : 1
              return Promise.resolve(
                json(
                  JSON.stringify({ items: history[index], nextCursor: index === 0 ? "p1" : null }),
                ),
              )
            }
            return Promise.resolve(json(JSON.stringify([project])))
          })
          const found = yield* loadDeployment("a3f9c21")
          expect(found.data?.rollbackTargets.map((target) => target.id)).toEqual(["dep_drained"])
          expect(deploymentRequests()).toHaveLength(4)
        }
      }),
    ))

  it("ends the search with the history read so far when the first page's cursor goes stale twice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        fetch.mockImplementation((input) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
          if (url.pathname.endsWith("/build-log"))
            return Promise.resolve(json(JSON.stringify({ lines: [], complete: true })))
          const detail = url.pathname.match(/\/deployments\/([^/]+)$/)?.[1]
          if (detail !== undefined)
            return Promise.resolve(json(JSON.stringify({ ...live, steps: [], runners: [] })))
          if (url.pathname.endsWith("/deployments"))
            return Promise.resolve(
              url.searchParams.get("cursor") === null
                ? json(JSON.stringify({ items: [live], nextCursor: "p1" }))
                : json('{"_tag":"NotFound","resource":"cursor","id":"p1"}', 404),
            )
          return Promise.resolve(json(JSON.stringify([project])))
        })
        const found = yield* loadDeployment("a3f9c21")
        expect(found.data?.rollbackTargets).toEqual([])
      }),
    ))

  it("rolls back through the chosen target id and returns the new deployment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        fetch.mockImplementation((input, init) => {
          const request = input instanceof Request ? input : new Request(String(input), init)
          const url = new URL(request.url)
          if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
          if (url.pathname.endsWith("/rollback"))
            return Promise.resolve(
              json(
                JSON.stringify({
                  ...deployment({
                    id: "dep_new",
                    commitSha: "ddddddd1234567",
                    status: "in-progress",
                    durationMs: null,
                    rolledBackFrom: "dep_drained",
                    createdAt: "2026-10-03T11:00:00.000Z",
                  }),
                  steps: [],
                  runners: [],
                }),
              ),
            )
          return Promise.resolve(json(JSON.stringify([project])))
        })
        const created = yield* rollBackDeployment("dep_drained")
        expect(created).toMatchObject({
          deploy: { id: "dep_new", commit: "ddddddd", status: "Rolling out" },
          rolledBackFrom: { id: "dep_drained" },
        })
        const posts = fetch.mock.calls
          .map(([input, init]) =>
            input instanceof Request ? input : new Request(String(input), init),
          )
          .filter((request) => request.method === "POST")
        expect(posts.map((request) => new URL(request.url).pathname)).toEqual([
          "/api/projects/prj_1/deployments/dep_drained/rollback",
        ])
      }),
    ))

  it("surfaces a refused rollback instead of faking success", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(NotImplemented))(
          NotImplemented.make({ operation: "deployments.rollback" }),
        )
        fetch.mockImplementation((input) => {
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
          if (url.pathname.endsWith("/rollback"))
            return Promise.resolve(
              new Response(body, { status: 501, headers: { "content-type": "application/json" } }),
            )
          return Promise.resolve(json(JSON.stringify([project])))
        })
        expect(yield* rollBackDeployment("dep_drained").pipe(Effect.flip)).toMatchObject({
          kind: "NotImplemented",
        })
      }),
    ))

  const respond = (path: string, response: () => Response) =>
    fetch.mockImplementation((input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/me")) return Promise.resolve(json(JSON.stringify(me)))
      if (url.pathname.endsWith(path) && request.method === "POST")
        return Promise.resolve(response())
      return Promise.resolve(json(JSON.stringify([project])))
    })

  it("redeploys the viewed deployment and returns the new deployment it started", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        respond("/redeploy", () =>
          json(
            JSON.stringify({
              ...deployment({
                id: "dep_again",
                commitSha: "1234567abcdef",
                status: "in-progress",
                durationMs: null,
                createdAt: "2026-10-03T11:00:00.000Z",
              }),
              steps: [],
              runners: [],
            }),
          ),
        )
        expect(yield* redeployDeployment("dep_live")).toMatchObject({
          id: "dep_again",
          commit: "1234567",
          status: "Rolling out",
        })
        const posts = fetch.mock.calls
          .map(([input, init]) =>
            input instanceof Request ? input : new Request(String(input), init),
          )
          .filter((request) => request.method === "POST")
        expect(posts.map((request) => new URL(request.url).pathname)).toEqual([
          "/api/projects/prj_1/deployments/dep_live/redeploy",
        ])
      }),
    ))

  it("surfaces the server's conflict message when a redeploy is refused", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Conflict))(
          Conflict.make({ message: "A rollout is already in progress" }),
        )
        respond(
          "/redeploy",
          () =>
            new Response(body, { status: 409, headers: { "content-type": "application/json" } }),
        )
        expect(yield* redeployDeployment("dep_live").pipe(Effect.flip)).toEqual(
          expect.objectContaining({
            kind: "Conflict",
            message: "A rollout is already in progress",
          }),
        )
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
