import { Effect, Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { ActorInspector, CommandLogEntry, OwnedTableRows } from "./runtime.ts"

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
})
