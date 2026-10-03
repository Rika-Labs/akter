import { Effect, Exit, Schema } from "effect"
import { OpenApi } from "effect/http-api"
import { describe, expect, it } from "vitest"

import { CloudApi } from "./contract.ts"
import { DeploymentSummary } from "./deployments.ts"

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
