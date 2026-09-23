import { Context, Effect, Option } from "effect"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"

export const InsideTurn = Context.Reference<symbol | undefined>("durable-actors/InsideTurn", {
  defaultValue: () => undefined,
})

export const outsideTurn = Effect.gen(function* () {
  if ((yield* InsideTurn) !== undefined)
    return yield* Effect.die(new Error("Request/reply inside a turn"))
})

export interface CommandContext<State> {
  readonly ref: ActorRef
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  readonly commandId: string
  readonly state: Readonly<State> & {
    readonly set: (patch: Partial<State>) => Effect.Effect<void>
  }
}

export interface WakeContext<State> {
  readonly ref: ActorRef
  /** Reads committed state; decoding a corrupt snapshot may itself die. */
  readonly state: Effect.Effect<Readonly<State>>
}
