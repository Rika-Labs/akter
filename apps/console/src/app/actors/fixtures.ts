import type { SeriesWindow } from "@akter/cloud-api"
import { DateTime } from "effect"
import { seriesLabel, windowSeconds } from "../overview/time.ts"
import { seededSeries } from "../workspace/series.ts"
import {
  type ActorInstance,
  ActorPage,
  ActorsPage,
  ActorTypePage,
  type ActorTypeSummary,
  type TypeActivity,
} from "./model.ts"

/** Fixture actor types for `storefront`. Illustrative test data. */
export const actorTypes: ReadonlyArray<ActorTypeSummary> = [
  {
    name: "Order",
    commands: ["Place", "Charged", "Refund"],
    instances: 412_903,
    awake: 1_204,
    commandsPerSecond: 88,
    p99Ms: 7,
    maxMailbox: 0,
  },
  {
    name: "Cart",
    commands: ["Add", "Remove", "Checkout"],
    instances: 1_388_120,
    awake: 39_877,
    commandsPerSecond: 802,
    p99Ms: 38,
    maxMailbox: 0,
  },
  {
    name: "Inventory",
    commands: ["Reserve", "Release", "Restock"],
    instances: 8_412,
    awake: 2_950,
    commandsPerSecond: 201,
    p99Ms: 51,
    maxMailbox: 0,
  },
  {
    name: "SupportRoom",
    commands: ["Join", "Send", "Leave"],
    instances: 1_904,
    awake: 611,
    commandsPerSecond: 118,
    p99Ms: 12,
    maxMailbox: 0,
  },
  {
    name: "AgentSession",
    commands: ["Prompt", "Approve", "Cancel"],
    instances: 290_551,
    awake: 3_560,
    commandsPerSecond: 74,
    p99Ms: 9,
    maxMailbox: 0,
  },
  {
    name: "Customer",
    commands: ["Register", "Update", "Delete"],
    instances: 61_210,
    awake: 402,
    commandsPerSecond: 21,
    p99Ms: 6,
    maxMailbox: 0,
  },
  {
    name: "Device",
    commands: ["Report", "Configure"],
    instances: 3_088,
    awake: 3_088,
    commandsPerSecond: 330,
    p99Ms: 4,
    maxMailbox: 0,
  },
  {
    name: "NightlyReport",
    commands: ["Run", "Retry"],
    instances: 1,
    awake: 0,
    commandsPerSecond: 0,
    p99Ms: 0,
    maxMailbox: 0,
  },
]

const instanceKeys = new Map<string, ReadonlyArray<string>>(
  Object.entries({
    Order: [
      "ord_8f2c",
      "ord_9a01",
      "ord_9a02",
      "ord_7c10",
      "ord_7c55",
      "ord_6b3e",
      "ord_5d81",
      "ord_4f07",
    ],
    Cart: ["c_19af", "c_aa31", "c_51ee", "c_0b7d", "c_e412", "c_93c0", "c_7f28", "c_2d6a"],
    Inventory: [
      "sku_mug",
      "sku_tee",
      "sku_sticker",
      "sku_tote",
      "sku_cap",
      "sku_hoodie",
      "sku_poster",
      "sku_socks",
    ],
    SupportRoom: [
      "general",
      "billing",
      "returns",
      "vip",
      "wholesale",
      "press",
      "careers",
      "status",
    ],
    AgentSession: ["s_77k", "s_80c", "s_81a", "s_7f2", "s_6dd", "s_63b", "s_5e9", "s_4a0"],
    Customer: ["cu_118", "cu_204", "cu_377", "cu_419", "cu_502", "cu_588", "cu_641", "cu_702"],
    Device: [
      "dev_0a1",
      "dev_0b7",
      "dev_1c4",
      "dev_2e9",
      "dev_3f0",
      "dev_47d",
      "dev_5a2",
      "dev_6c8",
    ],
    NightlyReport: ["singleton"],
  }),
)

const lastTurns = ["now", "now", "4s", "12s", "1m", "2m", "14m", "1h"]

/** Fixture instances of a type: its hottest instances by recent turns. */
export const instancesOf = (summary: ActorTypeSummary): ReadonlyArray<ActorInstance> =>
  (instanceKeys.get(summary.name) ?? []).map((key, index) => ({
    key,
    awake: summary.name !== "NightlyReport" && index < 6,
    generation: 14 + ((index * 7) % 23),
    lastCommand: summary.commands[index % summary.commands.length] ?? "—",
    lastTurn: summary.name === "NightlyReport" ? "9h" : (lastTurns[index] ?? "1h"),
  }))

const activityPoints: Readonly<Record<SeriesWindow, number>> = { "1h": 60, "24h": 96, "7d": 84 }

const fixtureNow = DateTime.makeUnsafe("2026-10-03T14:00:00.000Z")

/** A type's commands per second and the volume of each command over a window. Illustrative test data. */
export const typeActivity =
  (window: SeriesWindow) =>
  (summary: ActorTypeSummary): TypeActivity => {
    const length = activityPoints[window]
    const step = (windowSeconds[window] * 1000) / (length - 1)
    const labelOf = seriesLabel(window)
    return {
      window,
      hours: Array.from({ length }, (_, index) =>
        labelOf(
          DateTime.add(fixtureNow, { milliseconds: -Math.round(step * (length - 1 - index)) }),
        ),
      ),
      perSecond: seededSeries({
        length,
        base: Math.max(summary.commandsPerSecond, 1),
        volatility: Math.max(summary.commandsPerSecond, 4) * 0.2,
        seed: summary.name.length * 13,
      }),
      commands: summary.commands.map((name, index) => {
        const count = Math.round(
          (summary.commandsPerSecond * windowSeconds[window]) / (index + 1.6),
        )
        return { name, count, perSecond: count / windowSeconds[window] }
      }),
    }
  }

/** The inspected order from the product mocks. Fixture data. */
export const order: ActorPage = ActorPage.make({
  actorType: "Order",
  key: "ord_8f2c",
  awake: true,
  generation: 14,
  turn: 31,
  runner: "us-east-1/r3",
  tenant: "acme",
  mailbox: 0,
  state: '{\n  "total": 4200,\n  "chargeId": "ch_3Q9xA2",\n  "status": "paid",\n  "refunded": 0\n}',
  tables: [
    {
      name: "order_lines",
      columns: ["sku", "quantity", "unit_price"],
      rows: [
        { cells: ["mug", "2", "1200"] },
        { cells: ["tee", "1", "1500"] },
        { cells: ["sticker", "3", "100"] },
      ],
    },
  ],
  receipts: [
    { commandId: "cmd_7Hq2", command: "Place", result: "4200", at: "14:02:11", replayed: false },
    { commandId: "cmd_7Hq2", command: "Place", result: "replayed", at: "14:02:12", replayed: true },
    { commandId: "job_44f", command: "Charged", result: "ok", at: "14:02:17", replayed: false },
  ],
  events: [
    { cursor: "1184", name: "OrderPlaced", subscribers: 3 },
    { cursor: "1191", name: "OrderCharged", subscribers: 2 },
  ],
  jobs: [
    { id: "job_44f", name: "Charge", attempts: 2, status: "done" },
    { id: "job_45a", name: "SendReceipt", attempts: 1, status: "done" },
  ],
  connections: { sockets: 3, feedCursor: "1191" },
  activity: [
    {
      key: "a1",
      committed: true,
      title: "committed",
      subject: "Place",
      detail: "receipt rc_91a · 3 rows · 6.2 ms",
      time: "14:02:11",
    },
    {
      key: "a2",
      committed: false,
      title: "emitted",
      subject: "OrderPlaced",
      detail: "cursor 1184 · 3 subscribers",
      time: "14:02:11",
    },
    {
      key: "a3",
      committed: false,
      title: "enqueued",
      subject: "Charge",
      detail: "job_44f · idempotency key is the job id",
      time: "14:02:11",
    },
    {
      key: "a4",
      committed: false,
      title: "timed out, retrying",
      subject: "Charge attempt 1",
      detail: "provider 504 · retry in 2 s",
      time: "14:02:14",
    },
    {
      key: "a5",
      committed: true,
      title: "committed",
      subject: "Charged",
      detail: "chargeId ch_3Q9xA2 · 4.1 ms",
      time: "14:02:17",
    },
  ],
})

/** The fixture actor types page. */
export const actorsPage: ActorsPage = ActorsPage.make({ types: actorTypes })

/** The fixture page for one actor type, or nothing when the fixture project has no such type. */
export const actorTypePage =
  (window: SeriesWindow) =>
  (name: string): ActorTypePage | undefined => {
    const summary = actorTypes.find((candidate) => candidate.name === name)
    return summary === undefined
      ? undefined
      : ActorTypePage.make({
          summary,
          instances: instancesOf(summary),
          activity: typeActivity(window)(summary),
        })
  }

/**
 * The fixture inspector. It inspects `Order/ord_8f2c` in detail and answers other known instances
 * with the same shape of data under their own address.
 */
export const actorPage = (
  input: Readonly<{ actorType: string; key: string }>,
): ActorPage | undefined => {
  const summary = actorTypes.find((candidate) => candidate.name === input.actorType)
  if (summary === undefined) return undefined
  const instance = instancesOf(summary).find((candidate) => candidate.key === input.key)
  return {
    ...order,
    actorType: input.actorType,
    key: input.key,
    awake: instance?.awake ?? order.awake,
    generation: instance?.generation ?? order.generation,
  }
}
