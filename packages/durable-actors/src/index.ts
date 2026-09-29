import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { InTurn } from "./handles/intents.ts"
import { InStream } from "./contexts/command.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { CurrentCaller, Tenant, type Caller } from "./identity/caller.ts"
import { Command, Query } from "./members/command.ts"
import { Connection } from "./members/connection.ts"
import { StreamMember } from "./members/stream.ts"
import { Event } from "./members/event.ts"
import { Reducer } from "./members/reducer.ts"
import { Cancelled, DeadLetter, effect } from "./members/effect.ts"
import { ActorStates } from "./state/migration.ts"
import { blob, content } from "./members/blob.ts"
import { table } from "./tables/owned.ts"
import { WorkflowMember } from "./members/workflow.ts"
import { Delivery, SubscriptionMember } from "./members/subscription.ts"
import { make as authMake, none as authNone } from "./serve/auth.ts"
import { jwt } from "./serve/jwt.ts"
import { assertion } from "./serve/assertion/verify.ts"
import { serve } from "./serve/layer.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  query: Query.make,
  connection: Connection.make,
  stream: StreamMember.make,
  workflow: WorkflowMember.make,
  Event: Event.make,
  reducer: Reducer.make,
  effect,
  DeadLetter,
  Cancelled,
  state: ActorStates.make,
  table,
  blob,
  /** Declares shared content: immutable bytes stored once per tenant that actors reference by name. */
  content,
  migration: ActorStates.migration,
  singleton: Definition.singleton,
  /** Declares a subscription to another actor type's committed events. */
  subscription: SubscriptionMember.make,
  /** The input schema of a subscription handler: one delivery of a source's events. */
  Delivery,
  /** Serves actor definitions over HTTP as routes on the application's `HttpRouter`. */
  serve,
  /** Authentication providers for `Actor.serve`; one per served layer. */
  auth: { none: authNone, make: authMake, jwt, assertion },
  /** Provided by the runtime only inside command turns; `X.intents` requires it. */
  InTurn,
  /** Provided by the runtime only inside stream handlers; `read.follow` requires it. */
  InStream,
  as:
    (caller: Caller) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCaller, caller),
  tenant:
    (tenant: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Tenant, tenant),
  commandId:
    (id: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCommandId, id),
}

export { Actors } from "./handles/actors.ts"

export { Intent } from "./handles/intents.ts"

export { Content, ContentStore } from "./handles/content.ts"

export { ContentRef } from "./identity/content.ts"

export type { ContentEntry } from "./identity/content.ts"

export { ContentTooLarge, InvalidContentRef } from "./errors/content.ts"

export {
  ActorRef,
  Anonymous,
  Caller,
  CurrentCaller,
  Tenant,
  User,
  System,
  Principal,
} from "./identity/caller.ts"

export type { Policy } from "./policies/command.ts"

export {
  ActorError,
  ActorUnavailable,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  Unauthorized,
  Timeout,
  NotCreated,
  MailboxFull,
  RunnerAtCapacity,
  SessionEnded,
} from "./errors/actor.ts"

export { RetentionGap, UnknownCursor } from "./errors/events.ts"

export {
  ActivityOutcomeUnknown,
  InvalidExecutionId,
  InvalidExecutionKey,
} from "./errors/workflow.ts"

export type { WorkflowContext } from "./contexts/workflow.ts"

export type { WorkflowRun } from "./handles/workflow.ts"

export type { Race, Sleep, Step, Wait, Workflow } from "./members/workflow.ts"

export type { CommandContext, EventEntry, QueryContext, Turn } from "./contexts/command.ts"

export type { ExecutorContext, PerformContext, PerformOptions } from "./contexts/effect.ts"

export type {
  BroadcastContext,
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  FrameOf,
  SessionAccess,
} from "./contexts/connection.ts"

export type { AnyConnection, Connection } from "./members/connection.ts"

export type { AnyStream, Stream as StreamMember } from "./members/stream.ts"

export type { ConnectionHandlers, StreamHandler } from "./actor/definition.ts"

export type { EffectClass, EffectPolicy, ProgressEffect, ProgressOf } from "./members/effect.ts"

export type { PayloadMigrations, PayloadOptions } from "./members/payload.ts"

export type { Executors, Handle, Intents, WorkflowHandlers } from "./actor/definition.ts"

export type { Commutative, Reducer } from "./members/reducer.ts"

export type { AnyBlob, AnyContent, Blob, ContentBlob } from "./members/blob.ts"

export type {
  AnySubscription,
  DeliveredEvent,
  DeliveredGap,
  DeliveredRejection,
  Delivery,
  Route,
  SubscribeContext,
  SubscribeFrom,
  Subscription,
} from "./members/subscription.ts"

export type { BlobRead, BlobWrite, ContentRead, ContentWrite } from "./state/blob.ts"

export type {
  Filter,
  Filtered,
  Group,
  GroupDatabase,
  Insert,
  ListOptions,
  Order,
  OwnedTable,
  ReadOptions,
  Row,
  ScopedRead,
  ScopedRows,
} from "./tables/owned.ts"

export type { AuthProvider, AuthRequest, Authenticated, Binding } from "./serve/auth.ts"

export {
  ASSERTION_SKEW_MS,
  AssertionClaims,
  AssertionKey,
  AssertionKeySet,
  KeyRefreshClaims,
  MAX_ASSERTION_SECONDS,
} from "./serve/assertion/verify.ts"

export type { AssertionOptions } from "./serve/assertion/verify.ts"

export {
  ASSERTION_HEADER,
  ASSERTION_TYPE,
  canonicalRequest,
  KEY_REFRESH_PATH,
  KEY_REFRESH_TYPE,
  reauthenticationDigest,
  requestDigest,
} from "./serve/assertion/binding.ts"

export type { BoundRequest } from "./serve/assertion/binding.ts"

export { actorErrorBody, closeCodeOf, statusOf } from "./serve/wire.ts"

export { ClientWireMessage, ServerWireMessage, SUBPROTOCOL } from "./serve/frames.ts"
