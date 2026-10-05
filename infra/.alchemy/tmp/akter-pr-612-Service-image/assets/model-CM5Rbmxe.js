import {
  D as e,
  S as t,
  b as n,
  c as r,
  m as i,
  n as a,
  o,
  t as s,
  u as c,
  y as l,
} from "./Schema-y_083odB.js"
import { B as u, G as d, s as f } from "./src-BegpNXfi.js"
var p = n({ projectId: d, environment: u }),
  m = c([`ok`, `error`, `replayed`]),
  h = n({
    sequence: o,
    commandId: l,
    time: l,
    took: l,
    actorType: l,
    key: l,
    command: l,
    caller: i(f),
    result: m,
    detail: l,
  }),
  g = n({ entries: s(h), paused: a, filter: l, next: o }),
  _ = t(`CommandsPage`, { types: s(l), recent: s(h) }),
  v = t(`CommandSucceeded`, { commandId: l, result: r, replayed: a }),
  y = t(`CommandRejected`, { commandId: l, errorTag: l, error: r, replayed: a }),
  b = e([v, y]),
  x = n({ id: l, command: l, payload: l, generated: a })
export { v as a, x as i, y as n, _ as o, p as r, g as s, b as t }
