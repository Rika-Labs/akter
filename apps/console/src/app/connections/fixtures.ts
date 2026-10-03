import { hourLabels, seededSeries } from "../workspace/series.ts"
import { ConnectionsPage } from "./model.ts"

const open = seededSeries({ length: 96, base: 17_400, volatility: 900, seed: 41 }).map(Math.round)

/** Fixture connections for `storefront`. Illustrative test data. */
export const connections: ConnectionsPage = ConnectionsPage.make({
  sockets: 18_233,
  parked: 12_904,
  streams: 1_140,
  subscribers: 3_402,
  replayGaps: 0,
  hours: hourLabels({ points: 96, end: 14 }),
  open,
  parkedSeries: open.map((value, index) => Math.round(value * (0.62 + 0.08 * Math.sin(index / 9)))),
  byType: [
    { actorType: "SupportRoom", sockets: 9_880, parked: 7_412, streams: 0 },
    { actorType: "Cart", sockets: 5_102, parked: 4_991, streams: 0 },
    { actorType: "AgentSession", sockets: 2_410, parked: 301, streams: 1_140 },
    { actorType: "Order", sockets: 841, parked: 200, streams: 0 },
  ],
})
