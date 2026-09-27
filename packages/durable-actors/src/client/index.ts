// Client entry: Promise client and async iterators for browsers and other languages. No Bun/Node ambient globals.
export type {
  ActorClient,
  ClientHandle,
  ClientOptions,
  CommandOptions,
  HeadersProvider,
  QueryOptions,
} from "./make.ts"

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
  Timeout,
  TransportError,
  Unauthorized,
} from "../errors/actor.ts"
