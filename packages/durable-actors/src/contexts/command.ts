import { Context, Effect, Option } from "effect"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"

export const InsideTurn = Context.Reference<symbol | undefined>("durable-actors/InsideTurn", {
  defaultValue: () => undefined,
})

export const outsideTurn = Effect.gen(function* () {
  if ((yield* InsideTurn) !== undefined)
    return yield* Effect.die(new Error("Request/reply inside a turn"))
})

/** Type-level identity of one actor's command-turn service. */
export declare const TurnTypeId: unique symbol

export interface Turn<Name extends string> {
  readonly [TurnTypeId]: Name
}

/** The writable context of one command turn, obtained with `yield* X.Turn`. */
export interface CommandContext<State> {
  readonly id: string
  readonly ref: ActorRef
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  readonly commandId: string
  readonly state: Readonly<State> & {
    readonly set: (patch: Partial<State>) => Effect.Effect<void>
  }
}

/** The read-only context of one query, obtained with `yield* X.Read`. */
export interface QueryContext<State> {
  readonly id: string
  readonly ref: ActorRef
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  /** The last committed state; never uncommitted writes of a running turn. */
  readonly state: Readonly<State>
}
