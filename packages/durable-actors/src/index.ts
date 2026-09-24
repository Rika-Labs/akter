import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { CurrentCaller, Tenant, type Caller } from "./identity/caller.ts"
import { Command, Query } from "./members/command.ts"
import { ActorStates } from "./state/migration.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  query: Query.make,
  state: ActorStates.make,
  migration: ActorStates.migration,
  singleton: Definition.singleton,
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
} from "./errors/actor.ts"

export type { CommandContext, QueryContext, Turn } from "./contexts/command.ts"

export type { Handle } from "./actor/definition.ts"
