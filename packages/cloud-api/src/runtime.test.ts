import * as Framework from "@rikalabs/akter/client"
import { Effect, Exit, Predicate, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { RuntimeGroup } from "./groups/runtime.ts"
import { CloudApi } from "./contract.ts"
import { OpenApi } from "effect/http-api"
import {
  ActorInspector,
  ActorTypeActivity,
  CommandFailed,
  CommandLogEntry,
  CommandSent,
  ConnectionLimitExceeded,
  OwnedTableRows,
  QuotaExceeded,
  SpendLimitExceeded,
  StorageQuotaExceeded,
  SendCommand,
  TurnLatency,
  Workflow,
} from "./runtime.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Effect.runSync(
    Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
  )

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) =>
  Effect.runSync(Schema.encodeEffect(Schema.toCodecJson(schema))(value))

const rejects = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Exit.isFailure(
    Effect.runSyncExit(
      Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input)),
    ),
  )

const inspector = {
  address: "Counter/room-1",
  state: { count: 3, nested: { tags: ["a", null, 2.5] } },
  turn: 12,
  tables: [
    {
      table: "entries",
      columns: ["id", "body"],
      rows: [
        [1, "hi"],
        [2, null],
      ],
    },
  ],
  receipts: [
    {
      commandId: "cmd_1",
      command: "Increment",
      result: "ok",
      at: "2026-10-03T10:00:00.000Z",
      replayed: false,
    },
  ],
  events: [{ name: "Incremented", cursor: "17", subscribers: 2 }],
  jobs: [{ name: "Notify", id: "job_1", attempts: 1, status: "retrying" }],
  connections: { sockets: 2, feedCursor: null },
  properties: {
    status: "awake",
    type: "Counter",
    generation: 4,
    runner: "run_1",
    region: "us-east-1",
    tenant: "acme",
    mailboxDepth: 0,
  },
  timeline: [{ at: "2026-10-03T10:00:00.000Z", kind: "command", label: "Increment", detail: null }],
}

describe("runtime models", () => {
  it("carries an actor's JSON state through the wire form unchanged", () => {
    const decoded = decode(ActorInspector, inspector)
    expect(decoded.state).toEqual(inspector.state)
    expect(encode(ActorInspector, decoded)).toEqual(inspector)
  })

  it("rejects an inspector whose address has no key or whose status is not awake or idle", () => {
    expect(rejects(ActorInspector, { ...inspector, address: "Counter" })).toBe(true)
    expect(
      rejects(ActorInspector, {
        ...inspector,
        properties: { ...inspector.properties, status: "parked" },
      }),
    ).toBe(true)
  })

  it("rejects non-JSON cells in owned-table rows", () => {
    const row = { table: "t", columns: ["a"], rows: [[{ deep: [1] }]] }
    expect(decode(OwnedTableRows, row).rows[0]?.[0]).toEqual({ deep: [1] })
    expect(rejects(OwnedTableRows, { ...row, rows: ["x"] })).toBe(true)
  })

  it("distinguishes replayed commands from ok and error ones in the live tail", () => {
    const entry = {
      at: "2026-10-03T10:00:01.000Z",
      durationMs: 3.2,
      address: "Counter/room-1",
      command: "Increment",
      payloadPreview: "{}",
      outcome: "replayed",
      errorTag: null,
    }
    expect(decode(CommandLogEntry, entry).outcome).toBe("replayed")
    expect(rejects(CommandLogEntry, { ...entry, outcome: "retried" })).toBe(true)
    expect(rejects(CommandLogEntry, { ...entry, durationMs: -1 })).toBe(true)
  })

  it("round-trips a live-tail event through the SSE wire form with an ISO timestamp", () => {
    const [stream] = [...RuntimeGroup.endpoints.streamCommands.success]
    if (!Predicate.hasProperty(stream, "events") || !Schema.isSchema(stream.events))
      throw new Error("The commands stream declares no event schema")
    const payload = {
      at: "2026-10-03T10:00:01.000Z",
      durationMs: 3.2,
      address: "Counter/room-1",
      command: "Increment",
      payloadPreview: "{}",
      outcome: "ok",
      errorTag: null,
    }

    const events = stream.events as Schema.Codec<unknown, unknown>

    const decoded = Effect.runSync(
      Schema.decodeEffect(events)({ event: "message", data: JSON.stringify(payload) }),
    )
    const encoded = Effect.runSync(Schema.encodeEffect(events)(decoded))

    if (!Predicate.hasProperty(decoded, "data") || !Predicate.hasProperty(encoded, "data"))
      throw new Error("The event has no data")
    expect(decoded.data).toEqual(
      Effect.runSync(Schema.decodeEffect(Schema.toCodecJson(CommandLogEntry))(payload)),
    )
    expect(JSON.parse(String(encoded.data))).toEqual(payload)
  })

  it("sends a command with a JSON payload and an optional idempotency id", () => {
    const base = {
      address: "Counter/room-1",
      command: "Increment",
      payload: { by: 2, tags: [null] },
    }
    expect(decode(SendCommand, base).payload).toEqual(base.payload)
    expect(decode(SendCommand, { ...base, commandId: "cmd_7" }).commandId).toBe("cmd_7")
    expect(decode(SendCommand, base).commandId).toBeUndefined()
    expect(rejects(SendCommand, { ...base, address: "Counter" })).toBe(true)
    expect(rejects(SendCommand, { ...base, command: "" })).toBe(true)
    expect(rejects(SendCommand, { ...base, commandId: "" })).toBe(true)
    expect(rejects(SendCommand, { address: base.address, command: base.command })).toBe(true)
  })

  it("answers a sent command with its result and replayed flag, or a typed 422 error", () => {
    const sent = { commandId: "cmd_7", result: { count: 3 }, replayed: true }
    expect(encode(CommandSent, decode(CommandSent, sent))).toEqual(sent)
    expect(rejects(CommandSent, { commandId: "cmd_7", result: { count: 3 } })).toBe(true)
    const operation =
      OpenApi.fromApi(CloudApi).paths[
        "/api/projects/{projectId}/environments/{environment}/runtime/commands"
      ]?.post
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "401", "403", "404", "409", "410", "422", "501", "502"]),
    )
    expect(operation?.description).toContain("commandId")
    expect(
      CommandFailed.make({ commandId: "c", errorTag: "OutOfStock", error: null, replayed: false })
        ._tag,
    ).toBe("CommandFailed")
  })

  it("declares the edge's usage refusals on sendCommand with the framework's tags, payloads and statuses", () => {
    const responses =
      OpenApi.fromApi(CloudApi).paths[
        "/api/projects/{projectId}/environments/{environment}/runtime/commands"
      ]?.post?.responses ?? {}
    const declared = <T extends { readonly _tag: string }, E>(
      schema: Schema.Codec<T, E>,
      framework: Schema.Codec<T, E>,
      value: T,
      status: number,
    ) => {
      const wire = encode(framework, value) as { readonly [key: string]: Schema.Json }
      expect(schema.ast.annotations?.["httpApiStatus"]).toBe(status)
      expect(encode(schema, decode(schema, wire))).toEqual(wire)
      expect(rejects(schema, { ...wire, organizationId: null })).toBe(true)
      expect(JSON.stringify(responses[status])).toContain(value._tag)
    }

    declared(
      QuotaExceeded,
      Framework.QuotaExceeded,
      Framework.QuotaExceeded.make({
        organizationId: "org_1",
        period: "2026-10",
        limitUnits: 5_000_000,
        usedUnits: 4_999_999,
        requestedUnits: 5,
        retryAfterMs: 1_000,
      }),
      429,
    )
    declared(
      SpendLimitExceeded,
      Framework.SpendLimitExceeded,
      Framework.SpendLimitExceeded.make({
        organizationId: "org_1",
        period: "2026-10",
        limitCents: 5_000,
        projectedCents: 5_001,
      }),
      402,
    )
    declared(
      ConnectionLimitExceeded,
      Framework.ConnectionLimitExceeded,
      Framework.ConnectionLimitExceeded.make({
        organizationId: "org_1",
        kind: "socket",
        limit: 100,
        open: 100,
      }),
      429,
    )
    declared(
      StorageQuotaExceeded,
      Framework.StorageQuotaExceeded,
      Framework.StorageQuotaExceeded.make({
        organizationId: "org_1",
        deployment: "dep_1",
        tenant: "acme",
        limitBytes: 500_000_000,
        usedBytes: 500_000_000,
      }),
      429,
    )
  })

  it("carries an actor type's commands per second and per-command volume over a window", () => {
    const activity = {
      window: "24h",
      series: [
        { at: "2026-10-03T09:00:00.000Z", value: 12.5 },
        { at: "2026-10-03T10:00:00.000Z", value: 0 },
      ],
      commands: [{ command: "Increment", count: 4500, perSecond: 0.052 }],
    }
    expect(encode(ActorTypeActivity, decode(ActorTypeActivity, activity))).toEqual(activity)
    expect(rejects(ActorTypeActivity, { ...activity, window: "30d" })).toBe(true)
    expect(
      rejects(ActorTypeActivity, {
        ...activity,
        commands: [{ command: "Increment", count: -1, perSecond: 0 }],
      }),
    ).toBe(true)
  })

  it("carries a turn-latency histogram whose last bucket has no upper bound, with p50, p95 and p99", () => {
    const latency = {
      window: "1h",
      buckets: [
        { upToMs: 1, count: 900 },
        { upToMs: 10, count: 90 },
        { upToMs: null, count: 10 },
      ],
      p50Ms: 0.8,
      p95Ms: 7,
      p99Ms: 42,
    }
    expect(encode(TurnLatency, decode(TurnLatency, latency))).toEqual(latency)
    expect(
      rejects(TurnLatency, { window: "1h", buckets: latency.buckets, p50Ms: 1, p99Ms: 2 }),
    ).toBe(true)
    expect(rejects(TurnLatency, { ...latency, buckets: [{ upToMs: -1, count: 1 }] })).toBe(true)
  })

  it("serves the series under the actor type with an optional window", () => {
    const paths = OpenApi.fromApi(CloudApi).paths
    const base =
      "/api/projects/{projectId}/environments/{environment}/runtime/actor-types/{actorType}"
    expect(paths[`${base}/activity`]?.get?.parameters?.map((p) => p.name)).toContain("window")
    expect(paths[`${base}/latency`]?.get?.description).toContain("p99")
  })

  it("counts a workflow's steps from 1 and never lets the index pass the total", () => {
    const workflow = {
      id: "wf_1",
      name: "Checkout",
      actor: "Cart/c_1",
      step: { index: 1, total: 3, name: "reserve" },
      waitingFor: null,
      startedAt: "2026-10-03T10:00:00.000Z",
      status: "running",
    }
    const at = (step: { index: number; total: number; name: string }) => ({ ...workflow, step })

    expect(decode(Workflow, workflow).step.index).toBe(1)
    expect(decode(Workflow, at({ index: 3, total: 3, name: "ship" })).step.index).toBe(3)
    expect(rejects(Workflow, at({ index: 0, total: 3, name: "reserve" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 4, total: 3, name: "ship" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 1, total: 0, name: "reserve" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 1.5, total: 3, name: "reserve" }))).toBe(true)
  })
})
