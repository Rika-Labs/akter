import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { CurrentCaller, type Caller } from "./identity/caller.ts"
import { Command } from "./members/command.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  as:
    (caller: Caller) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCaller, caller),
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

export {
  Policy,
  Commands,
  Delivery,
  State,
  Hibernate,
  Mailbox,
  Lifecycle,
} from "./policies/command.ts"

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

export type { CommandContext, WakeContext } from "./contexts/command.ts"

export type { Handle } from "./actor/definition.ts"
