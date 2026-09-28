import { type Caller, System, User } from "@durable-actors/core"
import { Effect, Schema } from "effect"

const isSystem = Schema.is(System)

/**
 * Users and the application's own System callers run commands and queries,
 * except `Collect` and `Settle`: the account's turns start collections through
 * intents, and a collection's step calls to commands skip this hook, so no
 * external caller needs either. `Actor.serve` authentication never produces a
 * System caller.
 */
export const authorize = ({
  caller,
  command,
  kind,
}: {
  readonly caller: Caller
  readonly command: string
  readonly kind: string
}) =>
  Effect.succeed(
    command !== "Collect" &&
      command !== "Settle" &&
      (kind === "command" || kind === "query") &&
      (Schema.is(User)(caller) || isSystem(caller)),
  )
