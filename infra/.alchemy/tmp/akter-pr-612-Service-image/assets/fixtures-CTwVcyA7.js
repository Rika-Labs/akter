import { t as e } from "./brand-uyjyPyjo.js"
import { o as t } from "./model-CM5Rbmxe.js"
import { actorTypes as n } from "./fixtures-CDgoj1aw.js"
var r = [
    {
      actorType: `Order`,
      key: `ord_8f2c`,
      command: `Charged { chargeId: "ch_3Q9xA2" }`,
      took: `4.1 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Cart`,
      key: `c_19af`,
      command: `Add { sku: "mug", quantity: 1 }`,
      took: `2.2 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `SupportRoom`,
      key: `general`,
      command: `Send { text: "is the mug dishwasher…" }`,
      took: `0.9 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Inventory`,
      key: `sku_mug`,
      command: `Reserve { quantity: 2 }`,
      took: `51.0 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `AgentSession`,
      key: `s_77k`,
      command: `Prompt { text: "summarise ticket #812" }`,
      took: `1.4 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Order`,
      key: `ord_9a01`,
      command: `Place { lines: 2 }`,
      took: `3.0 ms`,
      result: `error`,
      detail: `AlreadyPlaced`,
    },
    {
      actorType: `Cart`,
      key: `c_aa31`,
      command: `Checkout {}`,
      took: `2.6 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Cart`,
      key: `c_19af`,
      command: `Add { sku: "tee" }`,
      took: `—`,
      result: `replayed`,
      detail: `retry of cmd_8Kp1`,
    },
    {
      actorType: `SupportRoom`,
      key: `general`,
      command: `Join { user: "u_42" }`,
      took: `0.7 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Order`,
      key: `ord_9a02`,
      command: `Place { lines: 1 }`,
      took: `5.8 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `AgentSession`,
      key: `s_80c`,
      command: `Approve { step: 3 }`,
      took: `1.1 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Cart`,
      key: `c_19af`,
      command: `Remove { sku: "sticker" }`,
      took: `38.9 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Inventory`,
      key: `sku_tee`,
      command: `Release { quantity: 1 }`,
      took: `2.0 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `SupportRoom`,
      key: `billing`,
      command: `Leave { user: "u_19" }`,
      took: `0.8 ms`,
      result: `ok`,
      detail: `ok`,
    },
    {
      actorType: `Device`,
      key: `dev_0a1`,
      command: `Report { battery: 81 }`,
      took: `1.6 ms`,
      result: `ok`,
      detail: `ok`,
    },
  ],
  i = (t) => {
    let n = 50536998 + t * 37,
      r = Math.floor(n / 36e5),
      i = Math.floor((n % 36e5) / 6e4),
      a = Math.floor((n % 6e4) / 1e3),
      o = n % 1e3
    return e(
      `${String(r).padStart(2, `0`)}:${String(i).padStart(2, `0`)}:${String(a).padStart(2, `0`)}.${String(o).padStart(3, `0`)}`,
      `src/app/commands/fixtures.ts#clock`,
    )
  },
  a = (t) => {
    let n = r[t % r.length] ?? r[0]
    return e(
      {
        sequence: t,
        commandId: `v1.1791099825418.1791186225418.${String(t).padStart(8, `0`)}-5a1e-4c0d-8e2f-0d3a7c9b1e42`,
        time: i(t),
        actorType: n?.actorType ?? `Order`,
        key: n?.key ?? `ord_8f2c`,
        command: n?.command ?? `Place`,
        took: n?.took ?? `—`,
        caller:
          t % 4 == 3
            ? { kind: `system`, subject: null, source: `timer` }
            : { kind: `user`, subject: `user:usr_dallen`, source: null },
        result: n?.result ?? `ok`,
        detail: n?.detail ?? `ok`,
      },
      `src/app/commands/fixtures.ts#tailEntry`,
    )
  },
  o = Array.from({ length: 14 }, (t, n) => e(a(13 - n), `src/app/commands/fixtures.ts#anonymous`)),
  s = t.make({
    types: n.map((t) => e(t.name, `src/app/commands/fixtures.ts#anonymous~2`)),
    recent: o,
  })
export { s as commandsPage }
