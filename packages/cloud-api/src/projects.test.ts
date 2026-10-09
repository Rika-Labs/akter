import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import {
  CreateProject,
  EnvVariable,
  EnvVariableName,
  Environment,
  Hostname,
  ProjectRegion,
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
  it("reports customer database reachability, nullable probe measurements and no URL-derived metadata", () => {
    const environment = { name: "dev", projectId: "prj_test", currentDeploymentId: null }
    expect(decode(Environment, environment).database).toBeUndefined()
    const databases = [
      {
        source: "customer",
        state: "missing",
        latency: null,
        latencyWarning: false,
        runnerCap: null,
      },
      {
        source: "customer",
        state: "reachable",
        latency: 7.25,
        latencyWarning: true,
        runnerCap: 13,
      },
      { source: "customer", state: "reachable", latency: 5, latencyWarning: false, runnerCap: 0 },
      { source: "customer", state: "reachable", latency: 0, latencyWarning: false, runnerCap: -1 },
      {
        source: "customer",
        state: "unreachable",
        latency: null,
        latencyWarning: false,
        runnerCap: null,
      },
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

  it("refuses managed and legacy states, incomplete probes and invalid measurements", () => {
    const environment = { name: "dev", projectId: "prj_test", currentDeploymentId: null }
    const database = {
      source: "customer",
      state: "reachable",
      latency: 4.5,
      latencyWarning: false,
      runnerCap: 12,
    }
    for (const bad of [
      { configured: true, engine: "postgres" },
      { configured: false, engine: "neki" },
      { ...database, engine: "postgres" },
      { ...database, source: "managed" },
      { ...database, source: "byo" },
      ...["provisioning", "ready", "read-only", "failed", "migrating"].map((state) => ({
        ...database,
        state,
      })),
      { ...database, latency: -0.1 },
      { ...database, latencyWarning: "false" },
      { ...database, runnerCap: 1.5 },
      { source: "customer", state: "reachable" },
    ]) {
      const strict = Schema.decodeUnknownEffect(Environment, { onExcessProperty: "error" })
      expect(Exit.isFailure(Effect.runSyncExit(strict({ ...environment, database: bad })))).toBe(
        true,
      )
    }
    for (const field of ["source", "state", "latency", "latencyWarning", "runnerCap"] as const) {
      const { [field]: _omitted, ...incomplete } = database
      expect(rejects(Environment, { ...environment, database: incomplete })).toBe(true)
    }
  })

  it("reports a region's Postgres version and size, with no engine, shard group or backup status", () => {
    const region = {
      region: { id: "us-east-1", city: "Ashburn" },
      home: true,
      tenantCount: 2,
      database: { version: "18.6", sizeBytes: 1_000 },
      storage: { usedBytes: 1_000, limitBytes: 500_000_000 },
      cpuPercent: 3,
      connections: { used: 1, limit: 100 },
      runners: 1,
      largestTables: [],
    }
    expect(accepts(ProjectRegion, region)).toBe(true)
    const strict = Schema.decodeUnknownEffect(ProjectRegion, { onExcessProperty: "error" })
    const refused = (patch: Record<string, Schema.Json>) =>
      Exit.isFailure(Effect.runSyncExit(strict({ ...region, ...patch })))
    expect(refused({ shardGroup: "default" })).toBe(true)
    expect(refused({ backups: { pointInTimeRecovery: true, latestBackupAt: null } })).toBe(true)
    expect(refused({ database: { ...region.database, engine: "postgres" } })).toBe(true)
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
