import { BuildLog, DeploymentDetail, DeploymentSummary } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  deployStatusOf,
  rollbackCandidates,
  shortCommit,
  toDeploymentPage,
  toDeploymentsPage,
  toDeployRecord,
  toPhases,
  toRolledBack,
} from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z")

const summary = (fields: Record<string, Schema.Json>) => ({
  id: "dep_1",
  projectId: "prj_1",
  environment: "production",
  commitSha: "a3f9c21d5e8b7a0c4f6d1e2b3a495867c0d1e2f3",
  message: "Add refunds to Order",
  author: { name: "dallen", image: null },
  regions: ["us-east-1", "us-west-2"],
  runnerCount: 6,
  durationMs: 41_000,
  status: "live",
  rolledBackFrom: null,
  createdAt: "2026-10-03T10:00:00.000Z",
  ...fields,
})

describe("deployment history", () => {
  it("maps every contract status to its word and shortens the commit to seven characters", () => {
    expect(deployStatusOf("in-progress")).toBe("Rolling out")
    expect(deployStatusOf("live")).toBe("Live")
    expect(deployStatusOf("drained")).toBe("Drained")
    expect(deployStatusOf("rolled-back")).toBe("Rolled back")
    expect(deployStatusOf("failed")).toBe("Failed")
    expect(shortCommit("a3f9c21d5e8b7a0c")).toBe("a3f9c21")
    expect(shortCommit("abc1234")).toBe("abc1234")
  })

  it("writes a row from a deployment, with a dash for one that has no duration yet", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const finished = yield* decode(DeploymentSummary, summary({}))
        const running = yield* decode(
          DeploymentSummary,
          summary({ durationMs: null, status: "in-progress", id: "dep_2" }),
        )
        expect(toDeployRecord(now)(finished)).toEqual({
          id: "dep_1",
          commit: "a3f9c21",
          message: "Add refunds to Order",
          author: "dallen",
          regions: ["us-east-1", "us-west-2"],
          runners: 6,
          took: "41 s",
          status: "Live",
          when: "2h",
        })
        expect(toDeployRecord(now)(running)).toMatchObject({
          id: "dep_2",
          took: "—",
          status: "Rolling out",
        })
      }),
    ))

  it("lists deployments newest first whatever order the page arrives in", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const older = yield* decode(
          DeploymentSummary,
          summary({ id: "dep_old", commitSha: "1c0d4a8", createdAt: "2026-10-01T10:00:00.000Z" }),
        )
        const newer = yield* decode(DeploymentSummary, summary({ id: "dep_new" }))
        const page = toDeploymentsPage(now)({ environment: "staging", summaries: [older, newer] })
        expect(page.environment).toBe("staging")
        expect(page.deploys.map((deploy) => deploy.id)).toEqual(["dep_new", "dep_old"])
        expect(page.deploys.map((deploy) => deploy.when)).toEqual(["2h", "2d"])
      }),
    ))
})

describe("deployment detail", () => {
  const detail = (extra: Record<string, Schema.Json> = {}) => ({
    ...summary({}),
    steps: [
      { name: "build", status: "succeeded", durationMs: 12_000, detail: "bun install" },
      { name: "migrate", status: "succeeded", durationMs: 3_500, detail: null },
      { name: "start-runners", status: "running", durationMs: null, detail: "4 of 6 ready" },
      { name: "drain-previous", status: "pending", durationMs: null, detail: null },
    ],
    runners: [
      { id: "r1", region: "us-east-1", actorCount: 9_880, cpuPercent: 38.4, health: "healthy" },
      { id: "r2", region: "us-west-2", actorCount: 3, cpuPercent: 99.6, health: "unhealthy" },
    ],
    ...extra,
  })

  it("lays steps end to end and gives an unfinished step no width", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(DeploymentDetail, detail())
        expect(toPhases(parsed.steps)).toEqual([
          {
            id: "build",
            label: "Build",
            detail: "bun install",
            start: 0,
            end: 12,
            status: "succeeded",
          },
          {
            id: "migrate",
            label: "Migrate",
            detail: "",
            start: 12,
            end: 15.5,
            status: "succeeded",
          },
          {
            id: "start-runners",
            label: "Start runners",
            detail: "4 of 6 ready",
            start: 15.5,
            end: 15.5,
            status: "running",
          },
          {
            id: "drain-previous",
            label: "Drain previous",
            detail: "",
            start: 15.5,
            end: 15.5,
            status: "pending",
          },
        ])
      }),
    ))

  it("keeps unmeasured runner telemetry unknown while preserving measured zeroes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(
          DeploymentDetail,
          detail({
            runners: [
              {
                id: "unknown",
                region: "us-east-1",
                actorCount: null,
                cpuPercent: null,
                health: "healthy",
              },
              { id: "zero", region: "us-west-2", actorCount: 0, cpuPercent: 0, health: "healthy" },
            ],
          }),
        )
        const page = toDeploymentPage(now)({
          detail: parsed,
          log: yield* decode(BuildLog, { lines: [], complete: true }),
          history: [],
        })
        expect(page.runners).toEqual([
          { id: "unknown", region: "us-east-1", actors: null, cpu: "—", health: "healthy" },
          { id: "zero", region: "us-west-2", actors: 0, cpu: "0%", health: "healthy" },
        ])
      }),
    ))

  it("draws runners, the build log in order and no measured shift the API does not report", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const parsed = yield* decode(DeploymentDetail, detail())
        const log = {
          lines: [
            { index: 0, at: "2026-10-03T10:00:01.000Z", stream: "stdout", text: "$ bun install" },
            { index: 1, at: "2026-10-03T10:00:02.000Z", stream: "stderr", text: "warn: lockfile" },
          ],
          complete: false,
        }
        const page = toDeploymentPage(now)({
          detail: parsed,
          log: yield* decode(BuildLog, log),
          history: [],
        })
        expect(page.log).toBe("$ bun install\nwarn: lockfile")
        expect(page.runners).toEqual([
          { id: "r1", region: "us-east-1", actors: 9_880, cpu: "38%", health: "healthy" },
          { id: "r2", region: "us-west-2", actors: 3, cpu: "100%", health: "unhealthy" },
        ])
        expect(page.shift).toBeUndefined()
        expect(page.liveAt).toBeUndefined()
        expect(page.rollbackTargets).toEqual([])
        expect(page.rolledBackFrom).toBeNull()
        expect(page.deploy.commit).toBe("a3f9c21")
      }),
    ))
})

describe("rollback targets", () => {
  const current = {
    id: "dep_now",
    commitSha: "a3f9c21d5e8b7a0c4f6d1e2b3a495867c0d1e2f3",
    status: "live",
    createdAt: "2026-10-03T10:00:00.000Z",
  }
  const history = (...entries: ReadonlyArray<Record<string, Schema.Json>>) =>
    Effect.forEach(entries, (fields) => decode(DeploymentSummary, summary(fields)))
  const candidateIds = (
    viewed: Record<string, Schema.Json>,
    others: ReadonlyArray<Record<string, Schema.Json>>,
  ) =>
    Effect.gen(function* () {
      const [target] = yield* history(viewed)
      const rest = yield* history(...others)
      return target === undefined
        ? []
        : rollbackCandidates(target)([...rest, target]).map((deployment) => deployment.id)
    })

  it("offers earlier drained, rolled-back and earlier live deployments newest first, never the current one", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* candidateIds(current, [
            { id: "dep_older", status: "drained", createdAt: "2026-09-01T10:00:00.000Z" },
            { id: "dep_live", status: "live", createdAt: "2026-10-01T10:00:00.000Z" },
            { id: "dep_drained", status: "drained", createdAt: "2026-10-02T10:00:00.000Z" },
            { id: "dep_rolled", status: "rolled-back", createdAt: "2026-10-03T09:00:00.000Z" },
          ]),
        ).toEqual(["dep_rolled", "dep_drained", "dep_live", "dep_older"])
      }),
    ))

  it("skips failed, rolling out, cross-environment, later and equal-time deployments", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* candidateIds(current, [
            { id: "dep_failed", status: "failed", createdAt: "2026-10-02T10:00:00.000Z" },
            { id: "dep_rolling", status: "in-progress", createdAt: "2026-10-02T11:00:00.000Z" },
            {
              id: "dep_staging",
              status: "drained",
              environment: "staging",
              createdAt: "2026-10-02T12:00:00.000Z",
            },
            { id: "dep_later", status: "drained", createdAt: "2026-10-03T11:00:00.000Z" },
            { id: "dep_same", status: "drained", createdAt: current.createdAt },
            { id: "dep_ok", status: "drained", createdAt: "2026-10-02T13:00:00.000Z" },
          ]),
        ).toEqual(["dep_ok"])
      }),
    ))

  it("offers nothing from a deployment that is not live", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* candidateIds({ ...current, status: "drained" }, [
            { id: "dep_earlier", status: "drained", createdAt: "2026-10-01T10:00:00.000Z" },
          ]),
        ).toEqual([])
      }),
    ))

  it("puts targets and the resolved rolledBackFrom commit on the page", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const detail = (fields: Record<string, Schema.Json>) =>
          decode(DeploymentDetail, {
            ...summary({ ...current, ...fields }),
            steps: [],
            runners: [],
          })
        const log = yield* decode(BuildLog, { lines: [], complete: true })
        const earlier = yield* history({
          id: "dep_earlier",
          commitSha: "77be0101234567890123456789012345678901ab",
          status: "drained",
          createdAt: "2026-10-01T10:00:00.000Z",
        })
        const resolved = toDeploymentPage(now)({
          detail: yield* detail({ rolledBackFrom: "dep_earlier" }),
          log,
          history: earlier,
        })
        expect(resolved.rollbackTargets).toMatchObject([
          { id: "dep_earlier", commit: "77be010", status: "Drained" },
        ])
        expect(resolved.rolledBackFrom).toEqual({ id: "dep_earlier", commit: "77be010" })
        const unknown = toDeploymentPage(now)({
          detail: yield* detail({ rolledBackFrom: "dep_unseen" }),
          log,
          history: earlier,
        })
        expect(unknown.rolledBackFrom).toEqual({ id: "dep_unseen" })
      }),
    ))

  it("maps a rollback's new deployment with the id it redeploys", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const created = yield* decode(DeploymentDetail, {
          ...summary({
            id: "dep_new",
            commitSha: "77be0101234567890123456789012345678901ab",
            status: "in-progress",
            durationMs: null,
            rolledBackFrom: "dep_target",
          }),
          steps: [],
          runners: [],
        })
        expect(toRolledBack(now)(created)).toMatchObject({
          deploy: { id: "dep_new", commit: "77be010", status: "Rolling out" },
          rolledBackFrom: { id: "dep_target" },
        })
      }),
    ))
})
