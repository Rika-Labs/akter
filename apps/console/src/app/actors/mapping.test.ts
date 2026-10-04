import { ActorInspector, ActorInstance, ActorTypeActivity } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { cellText, toActorInstance, toActorPage, toTypeActivity } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T14:02:30.000Z")

const inspector = {
  address: "Order/ord/8f2c",
  state: { total: 4200, status: "paid", refunded: null, lines: [1, 2] },
  turn: 31,
  tables: [
    {
      table: "order_lines",
      columns: ["sku", "quantity", "note"],
      rows: [
        ["mug", 2, null],
        ["tee", 1, { gift: true }],
      ],
    },
    { table: "empty", columns: ["id"], rows: [] },
  ],
  receipts: [
    {
      commandId: "cmd_7Hq2",
      command: "Place",
      result: "4200",
      caller: { kind: "user", subject: "user:usr_ada", source: null },
      at: "2026-10-03T14:02:11.000Z",
      expiresAt: "2026-10-04T14:02:11.000Z",
      replayed: true,
    },
  ],
  events: [
    { name: "OrderPlaced", cursor: "1184", emittedAt: "2026-10-03T14:02:12.000Z", subscribers: 3 },
  ],
  jobs: [{ name: "Charge", id: "job_44f", attempts: 2, status: "retrying" }],
  connections: { sockets: 3, feedCursor: null },
  properties: {
    status: "idle",
    type: "Order",
    generation: 14,
    runner: null,
    region: "us-east-1",
    tenant: "acme",
    mailboxDepth: 5,
  },
  timeline: [
    {
      at: "2026-10-03T14:02:11.000Z",
      kind: "command",
      label: "Place",
      detail: "3 rows",
      caller: { kind: "user", subject: "user:usr_ada", source: null },
    },
    {
      at: "2026-10-03T14:02:12.000Z",
      kind: "event",
      label: "OrderPlaced",
      detail: null,
      caller: { kind: "user", subject: "user:usr_ada", source: null },
    },
    {
      at: "2026-10-03T14:02:13.000Z",
      kind: "job",
      label: "Charge",
      detail: "attempt 1",
      caller: null,
    },
  ],
}

describe("actor inspector mapping", () => {
  it("splits the address at its first slash and carries the properties across", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = toActorPage(yield* decode(ActorInspector, inspector))
        expect(page).toMatchObject({
          actorType: "Order",
          key: "ord/8f2c",
          awake: false,
          generation: 14,
          turn: 31,
          runner: "—",
          tenant: "acme",
          mailbox: 5,
          connections: { sockets: 3, feedCursor: null },
        })
        expect(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(page.state)).toEqual(
          inspector.state,
        )
        expect(page.events).toEqual([{ name: "OrderPlaced", cursor: "1184", subscribers: 3 }])
        expect(page.jobs).toEqual([
          { name: "Charge", id: "job_44f", attempts: 2, status: "retrying" },
        ])
      }),
    ))

  it("writes every owned table with cells as text, null and objects as their JSON form", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = toActorPage(yield* decode(ActorInspector, inspector))
        expect(page.tables).toEqual([
          {
            name: "order_lines",
            columns: ["sku", "quantity", "note"],
            rows: [{ cells: ["mug", "2", "null"] }, { cells: ["tee", "1", '{"gift":true}'] }],
          },
          { name: "empty", columns: ["id"], rows: [] },
        ])
        expect(cellText("x")).toBe("x")
        expect(cellText(false)).toBe("false")
      }),
    ))

  it("reads the timeline as an activity feed where only commands are commits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = toActorPage(yield* decode(ActorInspector, inspector))
        expect(page.receipts[0]).toMatchObject({ at: "14:02:11", replayed: true })
        const activity = page.activity ?? []
        expect(
          activity.map((entry) => [
            entry.committed,
            entry.title,
            entry.subject,
            entry.detail,
            entry.time,
          ]),
        ).toEqual([
          [true, "committed", "Place", "3 rows", "14:02:11"],
          [false, "emitted", "OrderPlaced", "", "14:02:12"],
          [false, "ran", "Charge", "attempt 1", "14:02:13"],
        ])
        expect(new Set(activity.map((entry) => entry.key)).size).toBe(3)
      }),
    ))

  it("keeps what the runner does not report unknown instead of zero, empty or asleep", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const page = toActorPage(
          yield* decode(ActorInspector, {
            ...inspector,
            turn: null,
            tables: null,
            receipts: [{ ...inspector.receipts[0], result: null, at: null, replayed: false }],
            events: [{ ...inspector.events[0], subscribers: null }],
            connections: { sockets: null, feedCursor: "1184" },
            properties: { ...inspector.properties, status: null, mailboxDepth: null, region: null },
            timeline: null,
          }),
        )
        expect(page).toMatchObject({
          awake: null,
          turn: null,
          mailbox: null,
          tables: null,
          activity: null,
          connections: { sockets: null, feedCursor: "1184" },
          events: [{ name: "OrderPlaced", cursor: "1184", subscribers: null }],
          receipts: [{ commandId: "cmd_7Hq2", command: "Place", result: "—", at: "—" }],
        })
      }),
    ))
})

describe("actor instance mapping", () => {
  it("shows an instance that never ran a command with dashes and one that did with its age", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const idle = yield* decode(ActorInstance, {
          key: "c_1",
          status: "idle",
          lastCommand: null,
          lastActivityAt: null,
          generation: 0,
        })
        const busy = yield* decode(ActorInstance, {
          key: "c_2",
          status: "awake",
          lastCommand: "Add",
          lastActivityAt: "2026-10-03T14:00:30.000Z",
          generation: 7,
        })
        expect(toActorInstance(now)(idle)).toEqual({
          key: "c_1",
          awake: false,
          generation: 0,
          lastCommand: "—",
          lastTurn: "—",
        })
        expect(toActorInstance(now)(busy)).toEqual({
          key: "c_2",
          awake: true,
          generation: 7,
          lastCommand: "Add",
          lastTurn: "2m",
        })
      }),
    ))
})

describe("actor type activity mapping", () => {
  const activity = {
    window: "7d",
    series: [
      { at: "2026-10-03T14:00:00.000Z", value: 30 },
      { at: "2026-10-02T14:00:00.000Z", value: 10 },
      { at: "2026-10-03T02:00:00.000Z", value: 20 },
    ],
    commands: [
      { command: "Place", count: 604_800, perSecond: 1 },
      { command: "Refund", count: 60_480, perSecond: 0.1 },
    ],
  }

  it("orders the series oldest first and labels each instant in UTC with its date over a week", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mapped = toTypeActivity(yield* decode(ActorTypeActivity, activity))
        expect(mapped.window).toBe("7d")
        expect(mapped.perSecond).toEqual([10, 20, 30])
        expect(mapped.hours).toEqual(["10-02 14:00", "10-03 02:00", "10-03 14:00"])
        const day = toTypeActivity(yield* decode(ActorTypeActivity, { ...activity, window: "24h" }))
        expect(day.hours).toEqual(["14:00", "02:00", "14:00"])
        expect(day.perSecond).toEqual([10, 20, 30])
      }),
    ))

  it("keeps the busiest-first command volumes with their window totals", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const mapped = toTypeActivity(yield* decode(ActorTypeActivity, activity))
        expect(mapped.commands).toEqual([
          { name: "Place", count: 604_800, perSecond: 1 },
          { name: "Refund", count: 60_480, perSecond: 0.1 },
        ])
      }),
    ))
})
