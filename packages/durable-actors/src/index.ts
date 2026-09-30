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
import { WorkflowMember } from "./runtime/workflows/steps.ts"
import { Delivery, SubscriptionMember } from "./members/subscription.ts"
import { make as authMake, none as authNone } from "./serve/auth.ts"
import { jwt } from "./serve/jwt.ts"
import { assertion } from "./serve/assertion/verify.ts"
import { serve } from "./serve/layer.ts"
import { publicAccess } from "./policies/access.ts"

/**
 * The declaration namespace of `@durable-actors/core`: one constructor per
 * kind of member, the actor definition, and the ambient-context combinators.
 * An invalid definition throws when it is built, not when the actor first runs.
 *
 * @example
 * const Increment = Actor.command("Increment", { output: Schema.Int })
 * const Counter = Actor.make("Counter", { key: Schema.String, api: { Increment } })
 */
export const Actor = {
  /** Defines an actor type: its key, state, events, tables, blobs, effects, `api` and `internal` members, subscriptions, and policy. */
  make: Definition.make,
  /** Declares a command member; see `Command.make`. */
  command: Command.make,
  /** Declares a query member; see `Query.make`. */
  query: Query.make,
  /** Declares a connection member: a long-lived session between one client and the actor. */
  connection: Connection.make,
  /** Declares a stream member: a live, read-only feed for one subscriber. */
  stream: StreamMember.make,
  /** Declares a workflow member and its typed step constructors. */
  workflow: WorkflowMember.make,
  /** Declares a durable event class: `class Posted extends Actor.Event<Posted>()("Posted", fields) {}`. */
  Event: Event.make,
  /** Declares a pure state transition the server runs as an ordinary command turn; a commutative one is merged when queued. */
  reducer: Reducer.make,
  /** Declares an effect class: a request for external I/O that a turn records and an executor runs after commit. */
  effect,
  /** The input schema of an effect's `onDeadLetter` command: `Actor.DeadLetter(E)`. */
  DeadLetter,
  /** The input schema of an effect's `onCancelled` command: `Actor.Cancelled(E)`. */
  Cancelled,
  /** Declares an actor's keyed state fields and their migrations. */
  state: ActorStates.make,
  /** Declares an actor-owned Drizzle table whose rows carry the writing actor's identity. */
  table,
  /** Declares named binary storage an actor lists in `blobs`. */
  blob,
  /** Declares shared content: immutable bytes stored once per tenant that actors reference by name. */
  content,
  /** Builds one step of a state, event, or effect migration chain. */
  migration: ActorStates.migration,
  /** The key of an actor with one instance per tenant; its handle is `X.get()`. */
  singleton: Definition.singleton,
  /** Declares a subscription to another actor type's committed events. */
  subscription: SubscriptionMember.make,
  /** The input schema of a subscription handler: one delivery of a source's events. */
  Delivery,
  /** Serves actor definitions over HTTP as routes on the application's `HttpRouter`. */
  serve,
  /** Authentication providers for `Actor.serve`; one per served layer. */
  auth: { none: authNone, make: authMake, jwt, assertion },
  /**
   * Ready-made `access` policies for `Actor.make`. `public` allows every caller
   * and kind, which opens the actor to anyone who can reach the server; use it
   * only for demos and deliberately public actors.
   */
  access: { public: publicAccess },
  /** Provided by the runtime only inside command turns; `X.intents` requires it. */
  InTurn,
  /** Provided by the runtime only inside stream handlers; `read.follow` requires it. */
  InStream,
  /** Runs the piped Effect with `caller` as the ambient caller that handles capture, for trusted code that acts on behalf of a user; without it, in-process code is `System({ source: "process" })`. */
  as:
    (caller: Caller) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCaller, caller),
  /** Runs the piped Effect in `tenant`, for trusted code that acts on behalf of a tenant; the default tenant is `"default"`. */
  tenant:
    (tenant: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Tenant, tenant),
  /** Gives the command call of the piped Effect the explicit command id `id`, so a retry across processes keeps one identity. */
  commandId:
    (id: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCommandId, id),
}

export type {
  Aggregate,
  AggregateKind,
  AnyFleetView,
  DerivedTable,
  FleetFilter,
  FleetOptions,
  FleetPage,
  FleetRow,
  FleetView,
} from "./tables/fleet.ts"

export { Fleet } from "./tables/fleet.ts"

export { Actors } from "./handles/actors.ts"

export { Intent } from "./handles/intents.ts"

export { Content, ContentStore } from "./handles/content.ts"

export type { WorkflowRun } from "./handles/run.ts"

export type {
  ConnectionHandlers,
  Executors,
  Handle,
  Intents,
  StreamHandler,
  WorkflowHandlers,
} from "./actor/definition.ts"

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

export { ContentRef } from "./identity/content.ts"

export type { ContentEntry } from "./identity/content.ts"

export type { Access, AccessRequest } from "./policies/access.ts"

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

export { ContentTooLarge, InvalidContentRef } from "./errors/content.ts"

export {
  ActivityOutcomeUnknown,
  InvalidExecutionId,
  InvalidExecutionKey,
} from "./errors/workflow.ts"

export type { Race, Sleep, Step, Wait, Workflow } from "./members/workflow.ts"

export type { AnyConnection, Connection } from "./members/connection.ts"

export type { AnyStream, Stream as StreamMember } from "./members/stream.ts"

export type { EffectClass, EffectPolicy, ProgressEffect, ProgressOf } from "./members/effect.ts"

export type { PayloadMigrations, PayloadOptions } from "./members/payload.ts"

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

export type { CommandContext, EventEntry, QueryContext, Turn } from "./contexts/command.ts"

export type { WorkflowContext } from "./contexts/workflow.ts"

export type { ExecutorContext, PerformContext, PerformOptions } from "./contexts/effect.ts"

export type {
  BroadcastContext,
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  FrameOf,
  SessionAccess,
} from "./contexts/connection.ts"

export type { BlobRead, BlobWrite, ContentRead, ContentWrite } from "./state/blob.ts"

export type {
  Filter,
  Filtered,
  Group,
  GroupDatabase,
  Insert,
  ListOptions,
  Order,
  AdoptedTable,
  AdoptOptions,
  OwnedTable,
  OwnerColumns,
  ReadAdoptedTable,
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
