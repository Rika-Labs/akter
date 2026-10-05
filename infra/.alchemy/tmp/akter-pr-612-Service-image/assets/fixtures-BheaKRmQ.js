import { Es as e } from "./Schema-y_083odB.js"
import { t } from "./brand-uyjyPyjo.js"
import { i as n } from "./geometry-Ci0NuymG.js"
import { c as r, f as i, s as a } from "./index-BFzTgTOA.js"
import { n as o, t as s } from "./series-DTEtLPd3.js"
import { workspace as c } from "./fixtures-C3yEZAJn.js"
var l = [
    {
      id: `dep_a3f9c21`,
      commit: `a3f9c21`,
      message: `Add refunds to Order`,
      status: `Live`,
      when: `2h`,
    },
    {
      id: `dep_77be010`,
      commit: `77be010`,
      message: `Tune Cart idle timeout`,
      status: `Drained`,
      when: `1d`,
    },
    {
      id: `dep_5d2e7c3`,
      commit: `5d2e7c3`,
      message: `Bump Effect`,
      status: `Rolled back`,
      when: `2d`,
    },
    {
      id: `dep_1c0d4a8`,
      commit: `1c0d4a8`,
      message: `SupportRoom presence`,
      status: `Drained`,
      when: `3d`,
    },
  ],
  u = [1, 2, 5, 10, 25, 50, 100, 250, 1e3, null],
  d = [4, 22, 31, 18, 12, 7, 3.6, 1.8, 0.5, 0.1],
  f = (e) => {
    let r = u.map((r, a) =>
      t(
        {
          label: r === null ? `> ${n(u[a - 1] ?? 0)}` : `≤ ${n(r)}`,
          count: Math.round((d[a] ?? 0) * i[e] * 1.2),
          tail: r === null,
        },
        `src/app/overview/fixtures.ts#anonymous`,
      ),
    )
    return t(
      {
        window: e,
        total: r.reduce((e, n) => t(e + n.count, `src/app/overview/fixtures.ts#anonymous~2`), 0),
        bars: r,
      },
      `src/app/overview/fixtures.ts#distribution`,
    )
  },
  p = o({ length: 96, base: 1180, volatility: 210, seed: 21 }),
  m = r.make({
    project: `storefront`,
    stats: [
      {
        label: `Commands / s`,
        value: `1,284`,
        trend: o({ length: 40, base: 50, volatility: 18, seed: 3 }),
        stepped: !1,
      },
      {
        label: `Awake actors`,
        value: `48,210`,
        trend: o({ length: 40, base: 40, volatility: 8, seed: 11 }),
        stepped: !1,
      },
      {
        label: `Jobs in flight`,
        value: `312`,
        trend: o({ length: 40, base: 30, volatility: 10, seed: 5 }),
        stepped: !1,
      },
      {
        label: `Dead letters`,
        value: `3`,
        trend: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3],
        stepped: !0,
      },
    ],
    hours: s({ points: 96, end: 14 }),
    throughput: p,
    previous: o({ length: 96, base: 1020, volatility: 160, seed: 9 }),
    markers: [
      { index: 46, label: `77be010` },
      { index: 88, label: `a3f9c21` },
    ],
    health: [
      { label: `Runners`, value: `6 of 6 healthy`, healthy: !0 },
      { label: `Database`, value: `Neki · 41% CPU`, healthy: !0 },
      { label: `Mailbox depth`, value: `max 4 · Cart/c_19af`, healthy: !0 },
      { label: `Parked sockets`, value: `12,904`, healthy: !0 },
      { label: `Outbox lag`, value: `p99 18 ms`, healthy: !0 },
      { label: `Dead letters`, value: `3 need a decision`, healthy: !1 },
    ],
    latency: {
      p50: 3,
      p99: 21,
      hours: s({ points: 96, end: 14 }),
      p99Series: o({ length: 96, base: 18, volatility: 5, seed: 4 }),
    },
    distribution: f(`24h`),
    distributionSample: !1,
    deploys: l.slice(0, 3),
  }),
  h = (e) => t({ ...m, distribution: f(e) }, `src/app/overview/fixtures.ts#overviewFor`),
  g = e(2, (e, n) => {
    let r = c.projects.find((n) => t(n.slug === e, `src/app/overview/fixtures.ts#anonymous~4`))
    return r?.deployed === !0
      ? t({ ...h(n), project: r.slug }, `src/app/overview/fixtures.ts#anonymous~3`)
      : t(
          a.make({ project: r?.slug ?? e, region: r?.region ?? `us-east-1` }),
          `src/app/overview/fixtures.ts#anonymous~3`,
        )
  })
export { f as distribution, h as overviewFor, g as projectPage }
