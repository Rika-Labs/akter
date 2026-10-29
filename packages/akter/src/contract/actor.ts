import { Contract } from "./make.ts"
import type { Actor as ActorContract, Def } from "./make.ts"
import { JobFailure, Members } from "./members.ts"

/**
 * Declares actors: `Actor.make(name, { state, commands, ... })` for the contract and the member
 * constructors, schema first and options second.
 */
export const Actor = {
  make: Contract.make,
  command: Members.command,
  view: Members.view,
  broadcast: Members.broadcast,
  job: Members.job,
  list: Members.list,
  JobFailure,
}

/** An actor contract: shared with clients; `toLayer` binds its handlers on the server. */
export type Actor<Name extends string, D extends Def> = ActorContract<Name, D>
