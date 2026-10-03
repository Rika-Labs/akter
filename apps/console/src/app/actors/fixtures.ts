import { hourLabels, seededSeries } from "../workspace/series.ts"
import { type ActorInstance, ActorPage, type ActorTypeSummary } from "./model.ts"

/** Fixture actor types for `storefront`. Illustrative test data. */
export const actorTypes: ReadonlyArray<ActorTypeSummary> = [
  {
    name: "Order",
    commands: ["Place", "Charged", "Refund"],
    instances: 412_903,
    awake: 1_204,
    perSecond: 88,
    p99: "7 ms",
  },
  {
    name: "Cart",
    commands: ["Add", "Remove", "Checkout"],
    instances: 1_388_120,
    awake: 39_877,
    perSecond: 802,
    p99: "38 ms",
  },
  {
    name: "Inventory",
    commands: ["Reserve", "Release", "Restock"],
    instances: 8_412,
    awake: 2_950,
    perSecond: 201,
    p99: "51 ms",
  },
  {
    name: "SupportRoom",
    commands: ["Join", "Send", "Leave"],
    instances: 1_904,
    awake: 611,
    perSecond: 118,
    p99: "12 ms",
  },
  {
    name: "AgentSession",
    commands: ["Prompt", "Approve", "Cancel"],
    instances: 290_551,
    awake: 3_560,
    perSecond: 74,
    p99: "9 ms",
  },
  {
    name: "Customer",
    commands: ["Register", "Update", "Delete"],
    instances: 61_210,
    awake: 402,
    perSecond: 21,
    p99: "6 ms",
  },
  {
    name: "Device",
    commands: ["Report", "Configure"],
    instances: 3_088,
    awake: 3_088,
    perSecond: 330,
    p99: "4 ms",
  },
  {
    name: "NightlyReport",
    commands: ["Run", "Retry"],
    instances: 1,
    awake: 0,
    perSecond: 0,
    p99: "—",
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
const mailboxes = [4, 1, 0, 2, 0, 0, 0, 0]

/** Fixture instances of a type: its hottest instances by recent turns. */
export const instancesOf = (actorType: string): ReadonlyArray<ActorInstance> =>
  (instanceKeys.get(actorType) ?? []).map((key, index) => ({
    key,
    awake: actorType !== "NightlyReport" && index < 6,
    generation: 14 + ((index * 7) % 23),
    lastTurn: actorType === "NightlyReport" ? "9h" : (lastTurns[index] ?? "1h"),
    mailbox: mailboxes[index] ?? 0,
    runner: `${index % 3 === 2 ? "eu-west-1" : "us-east-1"}/r${(index % 3) + 1}`,
  }))

/** Today's volume per command for a type. */
export const commandVolumes = (summary: ActorTypeSummary) =>
  summary.commands.map((name, index) => ({
    name,
    today: Math.round((summary.perSecond * 86_400) / (index + 1.6)),
    p99: index === 0 ? summary.p99 : `${2 + index * 3} ms`,
  }))

/** Commands per second for a type over the last day. */
export const perSecondSeries = (summary: ActorTypeSummary) =>
  seededSeries({
    length: 96,
    base: Math.max(summary.perSecond, 1),
    volatility: Math.max(summary.perSecond, 4) * 0.2,
    seed: summary.name.length * 13,
  })

/** Hour labels for type charts. */
export const typeHours = hourLabels({ points: 96, end: 14 })

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
  table: {
    name: "order_lines",
    columns: ["sku", "quantity", "unit_price"],
    rows: [
      { cells: ["mug", "2", "1200"] },
      { cells: ["tee", "1", "1500"] },
      { cells: ["sticker", "3", "100"] },
    ],
  },
  receipts: [
    { commandId: "cmd_7Hq2", command: "Place", result: "4200", at: "14:02:11", replayed: false },
    { commandId: "cmd_7Hq2", command: "Place", result: "replayed", at: "14:02:12", replayed: true },
    { commandId: "job_44f", command: "Charged", result: "ok", at: "14:02:17", replayed: false },
  ],
  events: [
    { cursor: 1184, name: "OrderPlaced", subscribers: 3, at: "14:02:11" },
    { cursor: 1191, name: "OrderCharged", subscribers: 2, at: "14:02:17" },
  ],
  jobs: [
    { id: "job_44f", name: "Charge", attempts: 2, status: "Done", at: "14:02:17" },
    { id: "job_45a", name: "SendReceipt", attempts: 1, status: "Done", at: "14:02:18" },
  ],
  connections: [
    { id: "ws_19c", kind: "WebSocket", client: "storefront-web", since: "14:01:58", parked: false },
    { id: "ws_1a2", kind: "WebSocket", client: "ops-dashboard", since: "13:40:12", parked: true },
    { id: "sse_88", kind: "Event feed", client: "fulfilment", since: "09:12:40", parked: false },
  ],
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
