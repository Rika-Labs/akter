import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { InTurn } from "./handles/intents.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { CurrentCaller, Tenant, type Caller } from "./identity/caller.ts"
import { Command, Query } from "./members/command.ts"
import { Event } from "./members/event.ts"
import { Reducer } from "./members/reducer.ts"
import { DeadLetter, effect } from "./members/effect.ts"
import { ActorStates } from "./state/migration.ts"
import { table } from "./tables/owned.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  query: Query.make,
  Event: Event.make,
  reducer: Reducer.make,
  effect,
  DeadLetter,
  state: ActorStates.make,
  table,
  migration: ActorStates.migration,
  singleton: Definition.singleton,
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
} from "./errors/actor.ts"

export { RetentionGap, UnknownCursor } from "./errors/events.ts"

export type { CommandContext, EventEntry, QueryContext, Turn } from "./contexts/command.ts"

export type { ExecutorContext, PerformContext } from "./contexts/effect.ts"

export type { EffectClass, EffectPolicy } from "./members/effect.ts"

export type { Executors, Handle, Intents } from "./actor/definition.ts"

export type { Commutative, Reducer } from "./members/reducer.ts"

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
