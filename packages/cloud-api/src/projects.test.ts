import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CreateProject,
  EnvVariable,
  EnvVariableName,
  Environment,
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
  it("exposes only the database's source and state, rejecting URL-derived metadata", () => {
    const environment = { name: "dev", projectId: "prj_test", currentDeploymentId: null }
    expect(decode(Environment, environment).database).toBeUndefined()
    const databases = [
      { source: "managed", state: "provisioning" },
      { source: "managed", state: "ready" },
      { source: "managed", state: "read-only" },
      { source: "managed", state: "failed" },
      { source: "customer", state: "ready" },
    ]
    for (const database of databases) {
      expect(decode(Environment, { ...environment, database }).database).toEqual(database)
      for (const field of ["url", "host", "user", "password", "databaseName"]) {
        const input = { ...environment, database: { ...database, [field]: "private" } }
        expect(decode(Environment, input).database).toEqual(database)
        expect(
          Exit.isFailure(
            Effect.runSyncExit(
              Schema.decodeUnknownEffect(Environment, { onExcessProperty: "error" })(input),
            ),
          ),
        ).toBe(true)
      }
    }
  })

  it("refuses the removed engine status and any unknown source or state", () => {
    const environment = { name: "dev", projectId: "prj_test", currentDeploymentId: null }
    const database = { source: "managed", state: "ready" }
    for (const bad of [
      { configured: true, engine: "postgres" },
      { configured: false, engine: "neki" },
      { ...database, engine: "postgres" },
      { source: "byo", state: "ready" },
      { source: "managed", state: "migrating" },
      { source: "managed" },
      { state: "ready" },
    ]) {
      const strict = Schema.decodeUnknownEffect(Environment, { onExcessProperty: "error" })
      expect(Exit.isFailure(Effect.runSyncExit(strict({ ...environment, database: bad })))).toBe(
        true,
      )
    }
  })

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
