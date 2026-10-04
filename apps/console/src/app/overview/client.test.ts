import { Effect, Schema } from "effect"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadOverview, loadProject } from "./client.ts"
import { EmptyProjectPage, OverviewPage } from "./model.ts"
import { apiResponder, forbidden, type MockedAnswer, notImplemented, signedIn } from "./testing.ts"

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

const fetch = vi.spyOn(globalThis, "fetch")

const base = "/api/projects/prj_1/environments/production/runtime"

const overviewBody = {
  commands: { perSecond: 77.4, series24h: [], p50Ms: 3, p99Ms: 21 },
  actors: { awake: 5, total: 9 },
  jobs: { inFlight: 2, donePerHour: 40 },
  deadLettersByJobType: [],
  throughput: [{ at: "2026-10-03T10:00:00.000Z", value: 70 }],
  p99: [{ at: "2026-10-03T10:00:00.000Z", value: 20 }],
  health: {
    runners: { healthy: 1, total: 1 },
    databaseCpuPercent: 10,
    maxMailbox: { depth: 0, actor: null },
    parkedSockets: 0,
    outboxLagP99Ms: 1,
    lastDeployAt: null,
  },
  recentDeployments: [],
}

const types = ["Order", "Cart"].map((name) => ({
  name,
  commands: ["Place"],
  instances: 1,
  awake: 1,
  commandsPerSecond: 1,
  p99Ms: 1,
  maxMailbox: 0,
}))

const latency = (window: string, counts: ReadonlyArray<number>, bounds = [5, 50, null]) => ({
  body: {
    window,
    buckets: bounds.map((upToMs, index) => ({ upToMs, count: counts[index] ?? 0 })),
    p50Ms: 4,
    p95Ms: 40,
    p99Ms: 90,
  },
})

const live = (
  overrides: Readonly<Record<string, MockedAnswer>> = {},
  project: Parameters<typeof signedIn>[0] = { status: "live" },
) =>
  apiResponder({
    ...signedIn(project),
    [`${base}/overview`]: { body: overviewBody },
    [`${base}/actor-types`]: { body: types },
    [`${base}/actor-types/Order/latency`]: latency("7d", [10, 5, 1]),
    [`${base}/actor-types/Cart/latency`]: latency("7d", [20, 4, 2]),
    ...overrides,
  })

const chooseWindow = (window: string) =>
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => (key === "console-series-window" ? window : null),
  })

const load = (responder: ReturnType<typeof apiResponder>) => {
  fetch.mockImplementation(responder.respond)
  return loadOverview
}

const page = (data: OverviewPage | EmptyProjectPage): OverviewPage => {
  if (!Schema.is(OverviewPage)(data)) throw new Error("expected the overview page")
  return data
}

afterAll(() => fetch.mockRestore())

describe("overview over the live API", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CONSOLE_FIXTURES", "0")
    chooseWindow("7d")
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetch.mockReset()
  })

  it("asks every actor type for the selected window and adds their buckets, reading the tail as slower", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live()
        const loaded = yield* load(responder)
        expect(loaded.sample).toBe(false)
        expect(responder.seen).toContain(`${base}/actor-types/Order/latency?window=7d`)
        expect(responder.seen).toContain(`${base}/actor-types/Cart/latency?window=7d`)
        expect(page(loaded.data).stats[0]).toMatchObject({ label: "Commands / s", value: "77" })
        expect(page(loaded.data).distribution).toEqual({
          window: "7d",
          total: 42,
          bars: [
            { label: "≤ 5.0 ms", count: 30, tail: false },
            { label: "5–50 ms", count: 9, tail: false },
            { label: "> 50 ms", count: 3, tail: true },
          ],
        })
      }),
    ))

  it("keeps the page live and marks only the distribution sample when only the histogram is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const missing of [
          `${base}/actor-types/Order/latency`,
          `${base}/actor-types/Cart/latency`,
          `${base}/actor-types`,
        ]) {
          const loaded = yield* load(live({ [missing]: notImplemented("runtime.latency") }))
          const { distribution, distributionSample, stats } = page(loaded.data)
          expect(loaded.sample).toBe(false)
          expect(distributionSample).toBe(true)
          expect(stats[0]).toMatchObject({ value: "77" })
          expect(distribution?.window).toBe("7d")
          expect(distribution?.bars.at(-1)).toMatchObject({ tail: true })
          expect(distribution?.total).not.toBe(42)
        }
      }),
    ))

  it("reads recent deploys from the deployments list when the overview reports none", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live({
          [`${base}/overview`]: { body: { ...overviewBody, recentDeployments: null } },
          "/api/projects/prj_1/deployments": {
            body: {
              items: [
                {
                  id: "dep_listed",
                  projectId: "prj_1",
                  environment: "production",
                  commitSha: "c0ffee12",
                  message: "listed",
                  author: { name: "maya", image: null },
                  regions: ["us-east-1"],
                  runnerCount: 1,
                  durationMs: 1000,
                  status: "live",
                  rolledBackFrom: null,
                  createdAt: "2026-10-03T09:00:00.000Z",
                },
              ],
              nextCursor: null,
            },
          },
        })
        const loaded = yield* load(responder)
        expect(responder.seen).toContain(
          "/api/projects/prj_1/deployments?limit=3&environment=production",
        )
        expect(page(loaded.data).deploys?.map((deploy) => deploy.id)).toEqual(["dep_listed"])
        const own = live()
        yield* load(own)
        expect(own.seen.some((path) => path.startsWith("/api/projects/prj_1/deployments"))).toBe(
          false,
        )
      }),
    ))

  it("keeps the overview live and its deploys unreported when the deployments list can't be read", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const refusal of [notImplemented("deployments.list"), forbidden]) {
          const loaded = yield* load(
            live({
              [`${base}/overview`]: { body: { ...overviewBody, recentDeployments: null } },
              "/api/projects/prj_1/deployments": refusal,
            }),
          )
          expect(loaded.sample).toBe(false)
          expect(page(loaded.data).deploys).toBeNull()
          expect(page(loaded.data).stats[0]).toMatchObject({ value: "77" })
        }
      }),
    ))

  it("uses the whole sample page when the overview itself is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* load(
          live({ [`${base}/overview`]: notImplemented("runtime.getOverview") }),
        )
        expect(loaded.sample).toBe(true)
        expect(page(loaded.data).stats[0]).not.toMatchObject({ value: "77" })
      }),
    ))

  it("fails instead of sampling when the histogram is denied", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          load(live({ [`${base}/actor-types/Cart/latency`]: forbidden })),
        )
        expect(error).toMatchObject({ kind: "Forbidden" })
      }),
    ))

  it("never samples when the project context itself is not implemented", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live({
          "/api/organizations/org_1/projects": notImplemented("projects.list"),
        })
        const error = yield* Effect.flip(load(responder))
        expect(error).toMatchObject({ kind: "NotImplemented" })
        expect(responder.seen.some((path) => path.includes("/runtime/"))).toBe(false)
      }),
    ))

  it("draws no distribution when the actor types count into different bounds", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const loaded = yield* load(
          live({
            [`${base}/actor-types/Cart/latency`]: latency("7d", [20, 4, 2], [5, 100, null]),
          }),
        )
        expect(loaded.sample).toBe(false)
        expect(page(loaded.data).distribution).toBeUndefined()
      }),
    ))

  it("asks for no latency of a project that was never deployed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const responder = live({}, { status: "empty" })
        const loaded = yield* load(responder)
        expect(loaded.sample).toBe(false)
        expect(Schema.is(EmptyProjectPage)(loaded.data)).toBe(true)
        expect(responder.seen.some((path) => path.includes("/runtime/"))).toBe(false)
      }),
    ))

  it("serves the fixture histogram for the selected window in sample mode", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.stubEnv("VITE_CONSOLE_FIXTURES", "1")
        chooseWindow("1h")
        const loaded = yield* loadOverview
        expect(loaded.sample).toBe(true)
        expect(page(loaded.data).distribution?.window).toBe("1h")
        expect(fetch).not.toHaveBeenCalled()
      }),
    ))
})
