import { DeploymentSummary, Overview } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { deployMarkers, orderedSeries, toOverviewPage } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z")

const reported = <A>(value: A | null): A => {
  if (value === null) throw new Error("Expected a reported value")
  return value
}

const point = (hour: number, value: number) => ({
  at: `2026-10-03T${String(hour).padStart(2, "0")}:00:00.000Z`,
  value,
})

const deployment = (id: string, commitSha: string, createdAt: string) => ({
  id,
  projectId: "prj_1",
  environment: "production",
  commitSha,
  message: `deploy ${id}`,
  author: { name: "maya", image: null },
  regions: ["us-east-1"],
  runnerCount: 3,
  durationMs: 52_000,
  status: "live",
  rolledBackFrom: null,
  createdAt,
})

const overview = {
  commands: {
    perSecond: 1284.4,
    series24h: [point(11, 30), point(9, 10), point(10, 20)],
    p50Ms: 3.2,
    p99Ms: 21,
  },
  actors: { awake: 48_210, total: 2_100_000 },
  jobs: { inFlight: 312, donePerHour: 4000 },
  deadLettersByJobType: [
    { jobName: "Charge", count: 2 },
    { jobName: "SendEmail", count: 1 },
  ],
  throughput: [point(10, 300), point(8, 100), point(9, 200), point(11, 400)],
  p99: [point(9, 18), point(8, 12)],
  health: {
    runners: { healthy: 5, total: 6 },
    databaseCpuPercent: 41.4,
    maxMailbox: { depth: 4, actor: "Cart/c_19af" },
    parkedSockets: 12_904,
    outboxLagP99Ms: 18,
    lastDeployAt: "2026-10-03T10:00:00.000Z",
  },
  recentDeployments: [
    deployment("a", "a3f9c21d", "2026-10-03T10:20:00.000Z"),
    deployment("b", "77be0101", "2026-10-02T10:00:00.000Z"),
  ],
}

describe("overview mapping", () => {
  it("orders every series oldest first before drawing it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, overview)
        const page = toOverviewPage(now)({ project: "storefront", overview: parsed })
        expect(page.project).toBe("storefront")
        expect(page.hours).toEqual(["08:00", "09:00", "10:00", "11:00"])
        expect(page.throughput).toEqual([100, 200, 300, 400])
        expect(page.latency.hours).toEqual(["08:00", "09:00"])
        expect(page.latency.p99Series).toEqual([12, 18])
        expect(page.stats[0]).toMatchObject({
          label: "Commands / s",
          value: "1,284",
          trend: [10, 20, 30],
        })
        expect(orderedSeries(reported(parsed.p99)).map((entry) => entry.value)).toEqual([12, 18])
      }),
    ))

  it("sums dead letters across job types and flags the page when any wait", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, overview)
        const page = toOverviewPage(now)({ project: "storefront", overview: parsed })
        expect(page.stats[3]).toMatchObject({ label: "Dead letters", value: "3", stepped: true })
        expect(page.health).toContainEqual({
          label: "Dead letters",
          value: "3 need a decision",
          healthy: false,
        })
        const quiet = yield* decode(Overview, { ...overview, deadLettersByJobType: [] })
        expect(toOverviewPage(now)({ project: "p", overview: quiet }).health).toContainEqual({
          label: "Dead letters",
          value: "none",
          healthy: true,
        })
      }),
    ))

  it("reports health facts from the measured values, flagging a missing runner and a hot database", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, {
          ...overview,
          health: {
            ...overview.health,
            databaseCpuPercent: 91.2,
            maxMailbox: { depth: 0, actor: null },
          },
        })
        const { health } = toOverviewPage(now)({ project: "p", overview: parsed })
        expect(health).toContainEqual({ label: "Runners", value: "5 of 6 healthy", healthy: false })
        expect(health).toContainEqual({ label: "Database", value: "91% CPU", healthy: false })
        expect(health).toContainEqual({ label: "Mailbox depth", value: "max 0", healthy: true })
        expect(health).toContainEqual({ label: "Parked sockets", value: "12,904", healthy: true })
        expect(health).toContainEqual({ label: "Outbox lag", value: "p99 18 ms", healthy: true })
      }),
    ))

  it("keeps the three newest deploys and has no yesterday series to invent", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, overview)
        const page = toOverviewPage(now)({ project: "p", overview: parsed })
        expect(reported(page.deploys).map((deploy) => [deploy.commit, deploy.when])).toEqual([
          ["a3f9c21", "1h"],
          ["77be010", "1d"],
        ])
        expect(page.previous).toEqual([])
      }),
    ))

  it("addresses each deploy row by its deployment id, which rollbacks never reuse", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, {
          ...overview,
          recentDeployments: [
            deployment("dep_rollback", "77be0101", "2026-10-03T10:20:00.000Z"),
            deployment("dep_original", "77be0101", "2026-10-02T10:00:00.000Z"),
          ],
        })
        const page = toOverviewPage(now)({ project: "p", overview: parsed })
        expect(reported(page.deploys).map((deploy) => deploy.id)).toEqual([
          "dep_rollback",
          "dep_original",
        ])
      }),
    ))
})

/** The overview as the runners' durable views answer it: every unmeasured field null. */
const unmeasured = {
  commands: null,
  actors: { awake: null, total: 7 },
  jobs: { inFlight: 2, donePerHour: null },
  deadLettersByJobType: [{ jobName: "Charge", count: 1 }],
  throughput: null,
  p99: null,
  health: {
    runners: null,
    databaseCpuPercent: null,
    maxMailbox: null,
    parkedSockets: null,
    outboxLagP99Ms: null,
    lastDeployAt: null,
  },
  recentDeployments: null,
}

describe("overview mapping with unmeasured fields", () => {
  it("reads every unmeasured number as a dash and keeps measured ones", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, unmeasured)
        const page = toOverviewPage(now)({ project: "p", overview: parsed })
        expect(page.stats.map((stat) => [stat.label, stat.value, stat.trend])).toEqual([
          ["Commands / s", "—", []],
          ["Awake actors", "—", []],
          ["Jobs in flight", "2", []],
          ["Dead letters", "1", []],
        ])
        expect(page.health).toEqual([
          { label: "Runners", value: "—", healthy: null },
          { label: "Database", value: "—", healthy: null },
          { label: "Mailbox depth", value: "—", healthy: null },
          { label: "Parked sockets", value: "—", healthy: null },
          { label: "Outbox lag", value: "—", healthy: null },
          { label: "Dead letters", value: "1 need a decision", healthy: false },
        ])
        const text = [...page.stats, ...page.health].map((fact) => fact.value).join(" ")
        expect(text).not.toMatch(/null|NaN|\b0\b/)
      }),
    ))

  it("leaves unreported charts null rather than empty or zero", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = toOverviewPage(now)({
          project: "p",
          overview: yield* decode(Overview, unmeasured),
        })
        expect(page.throughput).toBeNull()
        expect(page.hours).toEqual([])
        expect(page.markers).toEqual([])
        expect(page.latency).toEqual({ p50: null, p99: null, hours: [], p99Series: null })
        expect(page.deploys).toBeNull()
      }),
    ))

  it("keeps a latency summary without its series, and a series without its summary", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const summaryOnly = yield* decode(Overview, {
          ...unmeasured,
          commands: { perSecond: 4, series24h: [], p50Ms: 1.5, p99Ms: 9 },
        })
        expect(toOverviewPage(now)({ project: "p", overview: summaryOnly }).latency).toEqual({
          p50: 1.5,
          p99: 9,
          hours: [],
          p99Series: null,
        })
        const seriesOnly = yield* decode(Overview, { ...unmeasured, p99: [point(9, 18)] })
        expect(toOverviewPage(now)({ project: "p", overview: seriesOnly }).latency).toEqual({
          p50: null,
          p99: null,
          hours: ["09:00"],
          p99Series: [18],
        })
      }),
    ))

  it("takes recent deploys from the deployments list only when the overview reports none", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const listed = yield* decode(Schema.Array(DeploymentSummary), [
          deployment("dep_listed", "c0ffee12", "2026-10-03T09:00:00.000Z"),
        ])
        const page = toOverviewPage(now)({
          project: "p",
          overview: yield* decode(Overview, unmeasured),
          deployments: listed,
        })
        expect(reported(page.deploys).map((deploy) => deploy.id)).toEqual(["dep_listed"])
        expect(page.markers).toEqual([])
        const own = toOverviewPage(now)({
          project: "p",
          overview: yield* decode(Overview, overview),
          deployments: listed,
        })
        expect(reported(own.deploys).map((deploy) => deploy.id)).toEqual(["a", "b"])
      }),
    ))
})

describe("deploy markers", () => {
  it("marks the nearest point of a deployment inside the window and skips ones outside it", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(Overview, overview)
        const series = orderedSeries(reported(parsed.throughput))
        const deployments = reported(parsed.recentDeployments)
        expect(deployMarkers(deployments)(series)).toEqual([{ index: 2, label: "a3f9c21" }])
        expect(deployMarkers(deployments)([])).toEqual([])
      }),
    ))
})
