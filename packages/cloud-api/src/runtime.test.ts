import * as Framework from "@rikalabs/akter/client"
import { Effect, Exit, Predicate, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { Conflict } from "./errors.ts"
import { RuntimeGroup } from "./groups/runtime.ts"
import { CloudApi } from "./contract.ts"
import { OpenApi } from "effect/http-api"
import {
  ActorInspector,
  ActorTypeActivity,
  CommandFailed,
  CommandLogEntry,
  CommandRefused,
  CommandSent,
  ConnectionLimitExceeded,
  OwnedTableRows,
  QuotaExceeded,
  QuotaUnbound,
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
      caller: { kind: "system", subject: "user:u_1", source: "timer" },
      at: "2026-10-03T10:00:00.000Z",
      expiresAt: "2026-10-04T10:00:00.000Z",
      replayed: false,
    },
  ],
  events: [
    { name: "Incremented", cursor: "17", emittedAt: "2026-10-03T10:00:00.000Z", subscribers: 2 },
  ],
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
  timeline: [
    {
      at: "2026-10-03T10:00:00.000Z",
      kind: "command",
      label: "Increment",
      detail: null,
      caller: null,
    },
  ],
}

describe("runtime models", () => {
  it("carries an actor's JSON state through the wire form unchanged", () => {
    const decoded = decode(ActorInspector, inspector)
    expect(decoded.state).toEqual(inspector.state)
    expect(encode(ActorInspector, decoded)).toEqual(inspector)
  })

  it("carries what a runner does not report as null, and refuses a negative count", () => {
    const unreported = {
      ...inspector,
      turn: null,
      tables: null,
      receipts: [{ ...inspector.receipts[0], result: null, caller: null, at: null }],
      events: [{ ...inspector.events[0], subscribers: null }],
      connections: { sockets: null, feedCursor: "17" },
      properties: {
        ...inspector.properties,
        status: null,
        runner: null,
        region: null,
        mailboxDepth: null,
      },
      timeline: null,
    }
    expect(encode(ActorInspector, decode(ActorInspector, unreported))).toEqual(unreported)
    expect(rejects(ActorInspector, { ...unreported, turn: -1 })).toBe(true)
    expect(
      rejects(ActorInspector, { ...unreported, connections: { sockets: -1, feedCursor: null } }),
    ).toBe(true)
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
      commandId: "v1.1.2.c",
      at: "2026-10-03T10:00:01.000Z",
      durationMs: 3.2,
      address: "Counter/room-1",
      command: "Increment",
      caller: { kind: "user", subject: "user:u_1", source: null },
      payloadPreview: "{}",
      outcome: "replayed",
      errorTag: null,
    }
    expect(decode(CommandLogEntry, entry).outcome).toBe("replayed")
    expect(rejects(CommandLogEntry, { ...entry, outcome: "retried" })).toBe(true)
    expect(rejects(CommandLogEntry, { ...entry, durationMs: -1 })).toBe(true)
    expect(rejects(CommandLogEntry, { ...entry, caller: { kind: "robot" } })).toBe(true)
    for (const kind of ["apiKey", "api-key"])
      expect(
        rejects(CommandLogEntry, {
          ...entry,
          caller: { kind, subject: "api-key:k_1", source: null },
        }),
      ).toBe(true)
    expect(
      decode(CommandLogEntry, {
        ...entry,
        caller: { kind: "user", subject: "api-key:k_1", source: null },
      }).caller,
    ).toEqual({ kind: "user", subject: "api-key:k_1", source: null })
    expect(
      decode(CommandLogEntry, { ...entry, at: null, durationMs: null, payloadPreview: null }),
    ).toMatchObject({ at: null, durationMs: null, payloadPreview: null })
  })

  it("round-trips a live-tail event through the SSE wire form with an ISO timestamp", () => {
    const [stream] = [...RuntimeGroup.endpoints.streamCommands.success]
    if (!Predicate.hasProperty(stream, "events") || !Schema.isSchema(stream.events))
      throw new Error("The commands stream declares no event schema")
    const payload = {
      commandId: "v1.1.2.c",
      at: "2026-10-03T10:00:01.000Z",
      durationMs: 3.2,
      address: "Counter/room-1",
      command: "Increment",
      caller: null,
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
        cap: "storage",
        limit: 0.5,
        used: 0.5,
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

  it("declares the edge's QuotaUnbound on sendCommand as a typed 402 carrying the edge's reason", () => {
    const responses =
      OpenApi.fromApi(CloudApi).paths[
        "/api/projects/{projectId}/environments/{environment}/runtime/commands"
      ]?.post?.responses ?? {}
    const wire = encode(
      QuotaUnbound,
      QuotaUnbound.make({ deployment: "dep_1", tenant: "acme", reason: "account" }),
    ) as { readonly [key: string]: Schema.Json }

    expect(wire["_tag"]).toBe("QuotaUnbound")
    expect(wire).toMatchObject({ deployment: "dep_1", tenant: "acme", reason: "account" })

    expect(QuotaUnbound.ast.annotations?.["httpApiStatus"]).toBe(402)
    expect(encode(QuotaUnbound, decode(QuotaUnbound, wire))).toEqual(wire)
    expect(rejects(QuotaUnbound, { ...wire, reason: "unbound" })).toBe(true)
    expect(JSON.stringify(responses[402])).toContain("QuotaUnbound")
    expect(JSON.stringify(responses[503])).not.toContain("QuotaUnbound")
  })

  it("carries a refused command's framework reason itself, never its ActorError envelope or an unknown reason", () => {
    const reason = Framework.InvalidCommandId.make({ commandId: "v1.bad", code: "window" })
    const wire = encode(
      CommandRefused,
      CommandRefused.make({ commandId: "v1.bad", reasonTag: "InvalidCommandId", reason }),
    ) as { readonly [key: string]: Schema.Json }
    const decoded = decode(CommandRefused, wire)
    const reasonWire = encode(Framework.InvalidCommandId, reason) as {
      readonly [key: string]: Schema.Json
    }

    expect(decoded.reason).toEqual(reason)
    expect(Schema.is(Framework.InvalidCommandId)(decoded.reason)).toBe(true)
    expect(
      rejects(CommandRefused, {
        ...wire,
        reason: encode(Framework.ActorError, Framework.ActorError.make({ reason })),
      }),
    ).toBe(true)
    expect(
      rejects(CommandRefused, {
        ...wire,
        reason: encode(Conflict, Conflict.make({ message: "not a framework reason" })),
      }),
    ).toBe(true)
    expect(rejects(CommandRefused, { ...wire, reason: { ...reasonWire, code: "late" } })).toBe(true)
  })

  it("carries an actor type's commands per second and per-command volume over a window, from when the runner began recording", () => {
    const activity = {
      window: "24h",
      since: "2026-10-03T08:30:00.000Z",
      series: [
        { at: "2026-10-03T09:00:00.000Z", value: 12.5 },
        { at: "2026-10-03T10:00:00.000Z", value: 0 },
      ],
      commands: [{ command: "Increment", count: 4500, perSecond: 0.052 }],
    }
    expect(encode(ActorTypeActivity, decode(ActorTypeActivity, activity))).toEqual(activity)
    expect(rejects(ActorTypeActivity, { ...activity, window: "30d" })).toBe(true)
    expect(rejects(ActorTypeActivity, { ...activity, since: null })).toBe(true)
    expect(
      rejects(ActorTypeActivity, {
        ...activity,
        commands: [{ command: "Increment", count: -1, perSecond: 0 }],
      }),
    ).toBe(true)
  })

  it("carries a turn-latency histogram whose last bucket has no upper bound, with p50, p95 and p99, null when no turn committed", () => {
    const latency = {
      window: "1h",
      since: "2026-10-03T08:30:00.000Z",
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
      rejects(TurnLatency, {
        window: "1h",
        since: latency.since,
        buckets: latency.buckets,
        p50Ms: 1,
        p99Ms: 2,
      }),
    ).toBe(true)
    const empty = {
      ...latency,
      buckets: [
        { upToMs: 1, count: 0 },
        { upToMs: null, count: 0 },
      ],
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    }
    expect(encode(TurnLatency, decode(TurnLatency, empty))).toEqual(empty)
    const { since: _since, ...sinceless } = latency
    expect(rejects(TurnLatency, sinceless)).toBe(true)
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
    const at = (step: { index: number; total: number | null; name: string } | null) => ({
      ...workflow,
      step,
    })

    expect(decode(Workflow, workflow).step?.index).toBe(1)
    expect(decode(Workflow, at({ index: 3, total: 3, name: "ship" })).step?.index).toBe(3)
    expect(decode(Workflow, at({ index: 7, total: null, name: "ship" })).step).toEqual({
      index: 7,
      total: null,
      name: "ship",
    })
    expect(decode(Workflow, at(null)).step).toBe(null)
    expect(rejects(Workflow, at({ index: 0, total: null, name: "reserve" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 0, total: 3, name: "reserve" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 4, total: 3, name: "ship" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 1, total: 0, name: "reserve" }))).toBe(true)
    expect(rejects(Workflow, at({ index: 1.5, total: 3, name: "reserve" }))).toBe(true)
  })
})
