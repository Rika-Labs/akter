import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { InTurn } from "./handles/intents.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { CurrentCaller, Tenant, type Caller } from "./identity/caller.ts"
import { Command, Query } from "./members/command.ts"
import { Connection } from "./members/connection.ts"
import { Event } from "./members/event.ts"
import { Reducer } from "./members/reducer.ts"
import { DeadLetter, effect } from "./members/effect.ts"
import { ActorStates } from "./state/migration.ts"
import { blob } from "./members/blob.ts"
import { table } from "./tables/owned.ts"
import { WorkflowMember } from "./members/workflow.ts"
import { make as authMake, none as authNone } from "./serve/auth.ts"
import { jwt } from "./serve/jwt.ts"
import { serve } from "./serve/layer.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  query: Query.make,
  connection: Connection.make,
  workflow: WorkflowMember.make,
  Event: Event.make,
  reducer: Reducer.make,
  effect,
  DeadLetter,
  state: ActorStates.make,
  table,
  blob,
  migration: ActorStates.migration,
  singleton: Definition.singleton,
  /** Serves actor definitions over HTTP as routes on the application's `HttpRouter`. */
  serve,
  /** Authentication providers for `Actor.serve`; one per served layer. */
  auth: { none: authNone, make: authMake, jwt },
  /** Provided by the runtime only inside command turns; `X.intents` requires it. */
  InTurn,
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

export type { ExecutorContext, PerformContext } from "./contexts/effect.ts"

export type {
  BroadcastContext,
  BroadcastOptions,
  ConnectionContext,
  ConnectionInfo,
  FrameOf,
  SessionAccess,
} from "./contexts/connection.ts"

export type { AnyConnection, Connection } from "./members/connection.ts"

export type { ConnectionHandlers } from "./actor/definition.ts"

export type { EffectClass, EffectPolicy, ProgressEffect, ProgressOf } from "./members/effect.ts"

export type { Executors, Handle, Intents, WorkflowHandlers } from "./actor/definition.ts"

export type { Commutative, Reducer } from "./members/reducer.ts"

export type { AnyBlob, Blob } from "./members/blob.ts"

export type { BlobRead, BlobWrite } from "./state/blob.ts"

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
