import { Effect, Exit, Schema } from "effect"
import { OpenApi } from "effect/http-api"
import { describe, expect, it } from "vitest"

import { CloudApi } from "./contract.ts"
import { LogLimit, LogWait, RunnerLogPage } from "./logs.ts"

const valid = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: Schema.Json,
) => Exit.isSuccess(Effect.runSyncExit(Schema.decodeEffect(schema)(input)))

describe("customer runner logs contract", () => {
  it("rejects unbounded requests and responses, including UTF-8 bytes rather than characters", () => {
    expect(valid(LogLimit, 1)).toBe(true)
    expect(valid(LogLimit, 200)).toBe(true)
    for (const limit of [0, 201, 1.5]) expect(valid(LogLimit, limit)).toBe(false)
    expect(valid(LogWait, 0)).toBe(true)
    expect(valid(LogWait, 20)).toBe(true)
    for (const wait of [-1, 21, 0.5]) expect(valid(LogWait, wait)).toBe(false)
    const line = {
      id: "line-1",
      deploymentId: "deployment-a",
      runnerId: "runner-a",
      at: "2026-10-07T01:02:03.000Z",
      stream: "stderr",
      text: "é".repeat(2048),
    }
    const codec = Schema.toCodecJson(RunnerLogPage)
    expect(valid(codec, { lines: [line], cursor: "position-a", truncated: false })).toBe(true)
    expect(
      valid(codec, { lines: [{ ...line, text: `${line.text}x` }], cursor: "a", truncated: false }),
    ).toBe(false)
    expect(
      valid(codec, {
        lines: Array.from({ length: 201 }, () => line),
        cursor: "a",
        truncated: false,
      }),
    ).toBe(false)
    expect(valid(codec, { lines: [], cursor: "", truncated: false })).toBe(false)
  })

  it("addresses environments and deployments under their project, with resumable bounded polls", () => {
    const spec = OpenApi.fromApi(CloudApi)
    for (const path of [
      "/api/projects/{projectId}/environments/{environment}/logs",
      "/api/projects/{projectId}/deployments/{deploymentId}/logs",
    ]) {
      const endpoint = spec.paths[path]?.get
      expect(endpoint?.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining(["projectId", "since", "limit", "cursor", "wait"]),
      )
      expect(endpoint?.responses["403"]).toBeDefined()
      expect(endpoint?.responses["404"]).toBeDefined()
      expect(endpoint?.responses["200"]).toBeDefined()
    }
  })
})
