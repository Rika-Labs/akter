// Client entry: Promise client and async iterators for browsers and other languages. No Bun/Node ambient globals.
export type {
  ActorClient,
  ClientHandle,
  ClientOptions,
  ClientState,
  CommandOptions,
  ConnectionClient,
  StreamCall,
  HeadersProvider,
  QueryOptions,
} from "./make.ts"

export type { PendingInput } from "./optimistic.ts"

export type { ClientConnection, ConnectionMessage, ConnectOptions } from "./connection.ts"

export type { FeedEntry, FeedOptions } from "./feed.ts"

export type { StreamOptions } from "./stream.ts"

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
