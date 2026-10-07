import { Effect, Exit, Schema } from "effect"
import { OpenApi } from "effect/http-api"
import { describe, expect, it } from "vitest"

import { CloudApi } from "./contract.ts"
import {
  CreateDeployment,
  DeploymentRunner,
  DeploymentSummary,
  RecordBuild,
  SOURCE_ENTRY,
} from "./deployments.ts"

const summary = {
  id: "dep_3",
  projectId: "prj_1",
  environment: "production",
  commitSha: "a1b2c3d",
  message: "Roll back",
  author: { name: "Ada", image: null },
  regions: ["us-east-1"],
  runnerCount: 2,
  durationMs: 1500,
  status: "in-progress",
  rolledBackFrom: "dep_1",
  createdAt: "2026-10-03T10:00:00.000Z",
}

const decode = (input: Schema.Json) =>
  Effect.runSyncExit(
    Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(DeploymentSummary)))(
      JSON.stringify(input),
    ),
  )

describe("deployment rollback", () => {
  it("accepts immutable build identities and refuses mutable tags or malformed snapshots", () => {
    const input = {
      image: `registry.example/app@sha256:${"a".repeat(64)}`,
      commitSha: "abcdef1234",
      environmentSnapshot: { APP_SETTING: "asymmetric value" },
    }
    const valid = (value: Schema.Json) =>
      Exit.isSuccess(Effect.runSyncExit(Schema.decodeUnknownEffect(RecordBuild)(value)))
    expect(valid(input)).toBe(true)
    expect(valid({ ...input, image: `sha256:${"b".repeat(64)}` })).toBe(true)
    for (const image of [
      "registry.example/app:latest",
      `registry.example/app@sha256:${"a".repeat(63)}`,
      `registry.example/app@sha256:${"A".repeat(64)}`,
    ])
      expect(valid({ ...input, image })).toBe(false)
    expect(valid({ ...input, environmentSnapshot: { "BAD NAME": "lost" } })).toBe(false)
    expect(valid({ ...input, environmentSnapshot: { APP_SETTING: 17 } })).toBe(false)
    expect(valid({ ...input, commitSha: "not-a-commit" })).toBe(false)
  })

  it("names a source by its archive digest alone and refuses a Dockerfile path", () => {
    const input = {
      environment: "production",
      commitSha: "abcdef1234",
      source: { digest: `sha256:${"c".repeat(64)}` },
    }
    const decoded = (value: Schema.Json) =>
      Effect.runSyncExit(Schema.decodeUnknownEffect(CreateDeployment)(value))
    const valid = (value: Schema.Json) => Exit.isSuccess(decoded(value))
    expect(valid(input)).toBe(true)
    for (const dockerfile of ["Dockerfile", "infra/runner/Dockerfile", ""]) {
      const refused = decoded({ ...input, source: { ...input.source, dockerfile } })

      expect(Exit.isFailure(refused), dockerfile).toBe(true)
      expect(String(refused)).toContain(
        `source.dockerfile is not accepted: the platform builds every source from ${SOURCE_ENTRY}`,
      )
    }
    for (const digest of [`sha256:${"c".repeat(63)}`, `sha256:${"C".repeat(64)}`, "c".repeat(64)])
      expect(valid({ ...input, source: { ...input.source, digest } })).toBe(false)
  })

  it("keeps unmeasured runner metrics unknown instead of substituting zero", () => {
    const runner = Effect.runSync(
      Schema.decodeEffect(DeploymentRunner)({
        id: "runner-one",
        region: "us-east-1",
        actorCount: null,
        cpuPercent: null,
        health: "healthy",
      }),
    )
    expect(runner.actorCount).toBeNull()
    expect(runner.cpuPercent).toBeNull()
    expect(
      Exit.isFailure(
        Effect.runSyncExit(Schema.decodeEffect(DeploymentRunner)({ ...runner, cpuPercent: -0.25 })),
      ),
    ).toBe(true)
  })
  it("records the deployment a rollback redeploys, and null for an ordinary deployment", () => {
    const rolledBack = decode(summary)
    const ordinary = decode({ ...summary, rolledBackFrom: null })

    expect(Exit.isSuccess(rolledBack) && rolledBack.value.rolledBackFrom).toBe("dep_1")
    expect(Exit.isSuccess(ordinary) && ordinary.value.rolledBackFrom).toBeNull()
    expect(Exit.isFailure(decode({ ...summary, rolledBackFrom: "" }))).toBe(true)
    const { rolledBackFrom: _omitted, ...withoutField } = summary
    expect(Exit.isFailure(decode(withoutField))).toBe(true)
  })

  it("describes the rollback target and status transitions on the endpoint", () => {
    const operation =
      OpenApi.fromApi(CloudApi).paths[
        "/api/projects/{projectId}/deployments/{deploymentId}/rollback"
      ]?.post

    expect(operation?.description).toContain("rolledBackFrom")
    expect(operation?.description).toContain("rolled-back")
    expect(operation?.responses["409"]).toBeDefined()
  })
})
