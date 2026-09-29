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

export type { ClientConnection, ConnectionMessage, ConnectOptions } from "./sessions/connection.ts"

export type { FeedEntry, FeedOptions } from "./sessions/feed.ts"

export type { StreamOptions } from "./sessions/stream.ts"

export type { WatchOptions } from "./sessions/watch.ts"

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
  SessionEnded,
  Timeout,
  TransportError,
  Unauthorized,
} from "../errors/actor.ts"

export { RetentionGap, UnknownCursor } from "../errors/events.ts"
