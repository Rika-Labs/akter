import { Effect } from "effect"
import { Definition } from "./actor/definition.ts"
import { CurrentCommandId } from "./identity/command.ts"
import { Command } from "./members/command.ts"

export const Actor = {
  make: Definition.make,
  command: Command.make,
  commandId:
    (id: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, CurrentCommandId, id),
}

export { Actors } from "./handles/actors.ts"

export { ActorRef, Anonymous, Caller, CurrentCaller, Tenant, User } from "./identity/caller.ts"

export {
  ActorError,
  ActorUnavailable,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  Unauthorized,
} from "./errors/actor.ts"

export type { CommandContext } from "./contexts/command.ts"

export type { Handle } from "./actor/definition.ts"
