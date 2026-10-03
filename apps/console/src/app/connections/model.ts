import { Schema as S } from "effect"

/** Live connections held by one actor type, and how many are parked while their actors sleep. */
export const ConnectionsByType = S.Struct({
  actorType: S.String,
  sockets: S.Finite,
  parked: S.Finite,
  streams: S.Finite,
})

/** The connections page. */
export const ConnectionsPage = S.TaggedStruct("ConnectionsPage", {
  sockets: S.Finite,
  parked: S.Finite,
  streams: S.Finite,
  subscribers: S.Finite,
  replayGaps: S.Finite,
  hours: S.Array(S.String),
  open: S.Array(S.Finite),
  parkedSeries: S.Array(S.Finite),
  byType: S.Array(ConnectionsByType),
})
export type ConnectionsPage = typeof ConnectionsPage.Type
