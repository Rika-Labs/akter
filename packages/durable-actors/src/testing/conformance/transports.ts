import type { ConformanceCase } from "../conformance.ts"
import { transportClientConformance } from "./transports/client.ts"
import { transportFeedConformance } from "./transports/feeds.ts"
import { transportStreamConformance } from "./transports/streams.ts"
import { transportWebSocketConformance } from "./transports/websocket.ts"

/** Transport cases: WebSocket handshake, framing, origin and socket limits, and delivery of member frames in both directions. */
export const transportsConformance: ReadonlyArray<ConformanceCase> = [
  ...transportWebSocketConformance,
  ...transportFeedConformance,
  ...transportClientConformance,
  ...transportStreamConformance,
]
