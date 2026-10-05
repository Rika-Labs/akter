import { It as e, Pt as t } from "./Schema-y_083odB.js"
import { t as n } from "./brand-uyjyPyjo.js"
import { d as r, f as i, h as a, m as o, p as s } from "./index-BFzTgTOA.js"
import { n as c } from "./series-DTEtLPd3.js"
var l = [
    {
      name: `Order`,
      commands: [`Place`, `Charged`, `Refund`],
      instances: 412903,
      awake: 1204,
      commandsPerSecond: 88,
      p99Ms: 7,
      maxMailbox: 0,
    },
    {
      name: `Cart`,
      commands: [`Add`, `Remove`, `Checkout`],
      instances: 1388120,
      awake: 39877,
      commandsPerSecond: 802,
      p99Ms: 38,
      maxMailbox: 0,
    },
    {
      name: `Inventory`,
      commands: [`Reserve`, `Release`, `Restock`],
      instances: 8412,
      awake: 2950,
      commandsPerSecond: 201,
      p99Ms: 51,
      maxMailbox: 0,
    },
    {
      name: `SupportRoom`,
      commands: [`Join`, `Send`, `Leave`],
      instances: 1904,
      awake: 611,
      commandsPerSecond: 118,
      p99Ms: 12,
      maxMailbox: 0,
    },
    {
      name: `AgentSession`,
      commands: [`Prompt`, `Approve`, `Cancel`],
      instances: 290551,
      awake: 3560,
      commandsPerSecond: 74,
      p99Ms: 9,
      maxMailbox: 0,
    },
    {
      name: `Customer`,
      commands: [`Register`, `Update`, `Delete`],
      instances: 61210,
      awake: 402,
      commandsPerSecond: 21,
      p99Ms: 6,
      maxMailbox: 0,
    },
    {
      name: `Device`,
      commands: [`Report`, `Configure`],
      instances: 3088,
      awake: 3088,
      commandsPerSecond: 330,
      p99Ms: 4,
      maxMailbox: 0,
    },
    {
      name: `NightlyReport`,
      commands: [`Run`, `Retry`],
      instances: 1,
      awake: 0,
      commandsPerSecond: 0,
      p99Ms: 0,
      maxMailbox: 0,
    },
  ],
  u = new Map(
    Object.entries({
      Order: [
        `ord_8f2c`,
        `ord_9a01`,
        `ord_9a02`,
        `ord_7c10`,
        `ord_7c55`,
        `ord_6b3e`,
        `ord_5d81`,
        `ord_4f07`,
      ],
      Cart: [`c_19af`, `c_aa31`, `c_51ee`, `c_0b7d`, `c_e412`, `c_93c0`, `c_7f28`, `c_2d6a`],
      Inventory: [
        `sku_mug`,
        `sku_tee`,
        `sku_sticker`,
        `sku_tote`,
        `sku_cap`,
        `sku_hoodie`,
        `sku_poster`,
        `sku_socks`,
      ],
      SupportRoom: [
        `general`,
        `billing`,
        `returns`,
        `vip`,
        `wholesale`,
        `press`,
        `careers`,
        `status`,
      ],
      AgentSession: [`s_77k`, `s_80c`, `s_81a`, `s_7f2`, `s_6dd`, `s_63b`, `s_5e9`, `s_4a0`],
      Customer: [`cu_118`, `cu_204`, `cu_377`, `cu_419`, `cu_502`, `cu_588`, `cu_641`, `cu_702`],
      Device: [
        `dev_0a1`,
        `dev_0b7`,
        `dev_1c4`,
        `dev_2e9`,
        `dev_3f0`,
        `dev_47d`,
        `dev_5a2`,
        `dev_6c8`,
      ],
      NightlyReport: [`singleton`],
    }),
  ),
  d = [`now`, `now`, `4s`, `12s`, `1m`, `2m`, `14m`, `1h`],
  f = (e) =>
    n(
      (u.get(e.name) ?? []).map((t, r) =>
        n(
          {
            key: t,
            awake: e.name !== `NightlyReport` && r < 6,
            generation: 14 + ((r * 7) % 23),
            lastCommand: e.commands?.[r % e.commands.length] ?? `—`,
            lastTurn: e.name === `NightlyReport` ? `9h` : (d[r] ?? `1h`),
          },
          `src/app/actors/fixtures.ts#anonymous`,
        ),
      ),
      `src/app/actors/fixtures.ts#instancesOf`,
    ),
  p = { "1h": 60, "24h": 96, "7d": 84 },
  m = e(`2026-10-03T14:00:00.000Z`),
  h = (e) =>
    n(
      (a) => {
        let o = a.commandsPerSecond ?? 0,
          s = p[e],
          l = (i[e] * 1e3) / (s - 1),
          u = r(e)
        return n(
          {
            window: e,
            hours: Array.from({ length: s }, (e, r) =>
              n(
                u(t(m, { milliseconds: -Math.round(l * (s - 1 - r)) })),
                `src/app/actors/fixtures.ts#anonymous~3`,
              ),
            ),
            perSecond: c({
              length: s,
              base: Math.max(o, 1),
              volatility: Math.max(o, 4) * 0.2,
              seed: a.name.length * 13,
            }),
            commands: (a.commands ?? []).map((t, r) => {
              let a = Math.round((o * i[e]) / (r + 1.6))
              return n(
                { name: t, count: a, perSecond: a / i[e] },
                `src/app/actors/fixtures.ts#anonymous~4`,
              )
            }),
          },
          `src/app/actors/fixtures.ts#anonymous~2`,
        )
      },
      `src/app/actors/fixtures.ts#typeActivity`,
    ),
  g = s.make({
    actorType: `Order`,
    key: `ord_8f2c`,
    awake: !0,
    generation: 14,
    turn: 31,
    runner: `us-east-1/r3`,
    region: `us-east-1`,
    tenant: `acme`,
    mailbox: 0,
    state: `{
  "total": 4200,
  "chargeId": "ch_3Q9xA2",
  "status": "paid",
  "refunded": 0
}`,
    tables: [
      {
        name: `order_lines`,
        columns: [`sku`, `quantity`, `unit_price`],
        rows: [
          { cells: [`mug`, `2`, `1200`] },
          { cells: [`tee`, `1`, `1500`] },
          { cells: [`sticker`, `3`, `100`] },
        ],
      },
    ],
    receipts: [
      {
        commandId: `cmd_7Hq2`,
        command: `Place`,
        result: `4200`,
        caller: { kind: `user`, subject: `user:usr_dallen`, source: null },
        at: `14:02:11`,
        expires: `10-05 14:02`,
        replayed: !1,
      },
      {
        commandId: `cmd_7Hq2`,
        command: `Place`,
        result: `replayed`,
        caller: { kind: `user`, subject: `user:usr_dallen`, source: null },
        at: `14:02:12`,
        expires: `10-05 14:02`,
        replayed: !0,
      },
      {
        commandId: `job_44f`,
        command: `Charged`,
        result: `ok`,
        caller: { kind: `system`, subject: `user:usr_dallen`, source: `job` },
        at: `14:02:17`,
        expires: `10-05 14:02`,
        replayed: !1,
      },
    ],
    events: [
      { cursor: `1184`, name: `OrderPlaced`, emitted: `10-04 14:02`, subscribers: 3 },
      { cursor: `1191`, name: `OrderCharged`, emitted: `10-04 14:02`, subscribers: 2 },
    ],
    jobs: [
      { id: `job_44f`, name: `Charge`, attempts: 2, status: `done` },
      { id: `job_45a`, name: `SendReceipt`, attempts: 1, status: `done` },
    ],
    connections: { sockets: 3, feedCursor: `1191` },
    activity: [
      {
        key: `a1`,
        committed: !0,
        title: `committed`,
        subject: `Place`,
        detail: `receipt rc_91a · 3 rows · 6.2 ms`,
        caller: null,
        time: `14:02:11`,
      },
      {
        key: `a2`,
        committed: !1,
        title: `emitted`,
        subject: `OrderPlaced`,
        detail: `cursor 1184 · 3 subscribers`,
        caller: null,
        time: `14:02:11`,
      },
      {
        key: `a3`,
        committed: !1,
        title: `enqueued`,
        subject: `Charge`,
        detail: `job_44f · idempotency key is the job id`,
        caller: null,
        time: `14:02:11`,
      },
      {
        key: `a4`,
        committed: !1,
        title: `timed out, retrying`,
        subject: `Charge attempt 1`,
        detail: `provider 504 · retry in 2 s`,
        caller: null,
        time: `14:02:14`,
      },
      {
        key: `a5`,
        committed: !0,
        title: `committed`,
        subject: `Charged`,
        detail: `chargeId ch_3Q9xA2 · 4.1 ms`,
        caller: null,
        time: `14:02:17`,
      },
    ],
  }),
  _ = a.make({ types: l }),
  v = (e) =>
    n(
      (t) => {
        let r = l.find((e) => n(e.name === t, `src/app/actors/fixtures.ts#anonymous~6`))
        return n(
          r === void 0
            ? void 0
            : o.make({ summary: r, instances: f(r), activity: h(e)(r), activitySample: !1 }),
          `src/app/actors/fixtures.ts#anonymous~5`,
        )
      },
      `src/app/actors/fixtures.ts#actorTypePage`,
    ),
  y = (e) =>
    n({ ...g, actorType: e.actorType, key: e.key }, `src/app/actors/fixtures.ts#sampleActor`),
  b = (e) => {
    let t = l.find((t) => n(t.name === e.actorType, `src/app/actors/fixtures.ts#anonymous~7`))
    if (t === void 0) return n(void 0, `src/app/actors/fixtures.ts#actorPage`)
    let r = f(t).find((t) => n(t.key === e.key, `src/app/actors/fixtures.ts#anonymous~8`))
    return n(
      { ...y(e), awake: r?.awake ?? g.awake, generation: r?.generation ?? g.generation },
      `src/app/actors/fixtures.ts#actorPage`,
    )
  }
export {
  b as actorPage,
  v as actorTypePage,
  l as actorTypes,
  _ as actorsPage,
  f as instancesOf,
  g as order,
  y as sampleActor,
  h as typeActivity,
}
