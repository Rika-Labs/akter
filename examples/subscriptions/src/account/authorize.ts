import { type ActorRef, type Caller, System, User } from "@durable-actors/core"
import { Effect, Schema } from "effect"

const isSystem = Schema.is(System)

/**
 * Users run commands and queries. `Collect` and `Settle` are reserved for the
 * account itself: its turns start collections, and a collection's step calls
 * carry a System caller that names the account. `Actor.serve` authentication
 * never produces a System caller.
 */
export const authorize = ({
  caller,
  ref,
  command,
  kind,
}: {
  readonly caller: Caller
  readonly ref: ActorRef
  readonly command: string
  readonly kind: string
}) =>
  Effect.succeed(
    command === "Collect" || command === "Settle"
      ? isSystem(caller) &&
          caller.source === "workflow" &&
          caller.ref?.actor === ref.actor &&
          caller.ref.id === ref.id &&
          caller.ref.tenant === ref.tenant
      : (kind === "command" || kind === "query") && (Schema.is(User)(caller) || isSystem(caller)),
  )
