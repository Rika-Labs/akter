import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CreateProject,
  EnvVariable,
  EnvVariableName,
  Hostname,
  SetEnvVariable,
} from "./projects.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Effect.runSync(
    Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
  )

const rejects = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Exit.isFailure(
    Effect.runSyncExit(
      Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
    ),
  )

const accepts = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  rejects(schema, input) === false

describe("project models", () => {
  it("drops a value or masked tail if a server leaks one into an environment variable read", () => {
    const read = decode(EnvVariable, {
      name: "DATABASE_URL",
      usedBy: ["Billing"],
      updatedAt: "2026-10-03T00:00:00.000Z",
      updatedBy: null,
      value: "postgres://secret",
      maskedTail: "cret",
    })
    expect(Object.keys(read).toSorted()).toEqual(["name", "updatedAt", "updatedBy", "usedBy"])
    expect(Object.keys(EnvVariable.fields)).not.toContain("value")
  })

  it("accepts shell-style variable names only", () => {
    expect(["API_KEY", "_x", "a1"].map((v) => accepts(EnvVariableName, v))).toEqual([
      true,
      true,
      true,
    ])
    expect(
      ["1A", "A-B", "A B", "", "A".repeat(257)].map((v) => accepts(EnvVariableName, v)),
    ).toEqual([false, false, false, false, false])
  })

  it("caps a written value at 64 KiB and allows the empty value", () => {
    expect(accepts(SetEnvVariable, { value: "" })).toBe(true)
    expect(accepts(SetEnvVariable, { value: "x".repeat(65536) })).toBe(true)
    expect(accepts(SetEnvVariable, { value: "x".repeat(65537) })).toBe(false)
  })

  it("accepts lowercase fully-qualified hostnames and rejects schemes, paths and bare labels", () => {
    expect(["app.acme.dev", "a-b.c.example.com"].map((v) => accepts(Hostname, v))).toEqual([
      true,
      true,
    ])
    expect(
      ["https://app.acme.dev", "app.acme.dev/x", "localhost", "App.Acme.dev", "-a.dev", "a.d"].map(
        (v) => accepts(Hostname, v),
      ),
    ).toEqual([false, false, false, false, false, false])
  })

  it("creates a project only in a launch region with a valid slug", () => {
    const project = { name: "API", slug: "api", homeRegion: "us-east-1" }
    expect(decode(CreateProject, project).homeRegion).toBe("us-east-1")
    expect(rejects(CreateProject, { ...project, homeRegion: "eu-west-1" })).toBe(true)
    expect(rejects(CreateProject, { ...project, slug: "Api" })).toBe(true)
  })
})
