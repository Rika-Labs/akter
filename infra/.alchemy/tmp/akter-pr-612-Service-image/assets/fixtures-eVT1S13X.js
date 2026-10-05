import { t as e } from "./brand-uyjyPyjo.js"
import { a as t } from "./index-BFzTgTOA.js"
import { n, t as r } from "./series-DTEtLPd3.js"
var i = n({ length: 96, base: 17400, volatility: 900, seed: 41 }).map(Math.round),
  a = t.make({
    sockets: 18233,
    parked: 12904,
    streams: 1140,
    subscribers: 3402,
    replayGaps: 0,
    hours: r({ points: 96, end: 14 }),
    open: i,
    parkedSeries: i.map((t, n) =>
      e(
        Math.round(t * (0.62 + 0.08 * Math.sin(n / 9))),
        `src/app/connections/fixtures.ts#anonymous`,
      ),
    ),
    byType: [
      { actorType: `SupportRoom`, sockets: 9880, parked: 7412, streams: 0 },
      { actorType: `Cart`, sockets: 5102, parked: 4991, streams: 0 },
      { actorType: `AgentSession`, sockets: 2410, parked: 301, streams: 1140 },
      { actorType: `Order`, sockets: 841, parked: 200, streams: 0 },
    ],
  })
export { a as connections }
