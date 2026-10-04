import type { ConnectionsSummary } from "@akter/cloud-api"
import { DateTime } from "effect"
import { hourLabel } from "../overview/time.ts"
import { ConnectionsPage } from "./model.ts"

/**
 * The connections the runtime reports as the console's page. `open` counts every open socket,
 * parked ones included: hibernation leaves sockets open, so parked is the share of open held while
 * their actors sleep.
 */
export const toConnectionsPage = (summary: ConnectionsSummary): ConnectionsPage => {
  const history = [...(summary.openVersusParked ?? [])].sort(
    (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at),
  )
  return ConnectionsPage.make({
    sockets: summary.open,
    parked: summary.parked,
    streams: summary.sseStreams,
    subscribers: summary.feedSubscribers,
    replayGaps: summary.replayGaps,
    hours: history.map((point) => hourLabel(point.at)),
    open: history.map((point) => point.open),
    parkedSeries: history.map((point) => point.parked),
    byType: summary.byActorType.map((row) => ({
      actorType: row.actorType,
      sockets: row.open,
      parked: row.parked,
      streams: row.sse,
    })),
  })
}
