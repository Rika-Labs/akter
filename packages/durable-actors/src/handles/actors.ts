import { Context, type Effect } from "effect"
import type { ActorError } from "../errors/actor.ts"

/**
 * The runtime's public service. Provide it with `Actors.layer` from
 * `@durable-actors/core/runtime`; handles reach the runtime through it.
 */
export class Actors extends Context.Service<
  Actors,
  {
    /**
     * Mints a command id for `Actor.commandId`, so a caller can retry one
     * operation across processes. It reads the database clock, so it fails
     * `ActorUnavailable` while the database is unreachable.
     */
    readonly mintCommandId: Effect.Effect<string, ActorError>
  }
>()("@durable-actors/core/handles/actors") {}
