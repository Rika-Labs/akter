import * as Inspection from "../protocol/inspection.ts"

export type {
  ActorClient,
  ClientHandle,
  ClientOptions,
  ClientState,
  CommandOptions,
  ConnectionClient,
  StreamCall,
  WatchCall,
  HeadersProvider,
  QueryOptions,
} from "./make.ts"

export type { PendingInput } from "./optimistic.ts"

export type { OfflineQueue, PendingCommand } from "./offline/queue.ts"

export { Offline, OfflineStoreError } from "./offline/store.ts"

export type { OfflineStore, QueuedCommand } from "./offline/store.ts"

export type {
  ClientConnection,
  ConnectionMessage,
  ConnectOptions,
  ProgressMessage,
  ProgressOfConnection,
  ProgressUpdate,
} from "./sessions/connection.ts"

export type { FeedEntry, FeedOptions } from "./sessions/feed.ts"

export type { StreamOptions } from "./sessions/stream.ts"

export type { WatchOptions } from "./sessions/watch.ts"

export { fleetClient } from "./fleet.ts"

export type { FleetClient, FleetSubscribeOptions, FleetViewClient } from "./fleet.ts"

export type { FleetFilter, FleetPage, FleetRow } from "../tables/fleet.ts"

export type { Failure } from "./transport.ts"

export {
  ActorError,
  ActorUnavailable,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  MailboxFull,
  NotCreated,
  RunnerAtCapacity,
  QuotaExceeded,
  SpendLimitExceeded,
  ConnectionLimitExceeded,
  SessionEnded,
  Timeout,
  TransportError,
  Unauthorized,
} from "../errors/actor.ts"

export { RetentionGap, UnknownCursor } from "../errors/events.ts"

export { Inspection }
