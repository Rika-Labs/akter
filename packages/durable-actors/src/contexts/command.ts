import { Context, type DateTime, Effect, Option } from "effect"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"
import type { EventClass } from "../members/event.ts"

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
export interface CommandContext<State, Event extends EventClass = never> {
  readonly id: string
  readonly ref: ActorRef
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  readonly commandId: string
  readonly state: Readonly<State> & {
    readonly set: (patch: Partial<State>) => Effect.Effect<void>
  }
  /** Appends a declared event that is stored, and replayable, only if this turn commits. */
  readonly emit: (event: Event["Type"]) => Effect.Effect<void>
}

/** One committed event and where it sits in its actor's stream. */
export interface EventEntry<E> {
  /** Exclusive resume point: pass it as `after` to read the events that follow. */
  readonly cursor: string
  readonly event: E
  readonly commandId: string
  readonly timestamp: DateTime.Utc
}

/** The read-only context of one query, obtained with `yield* X.Read`. */
export interface QueryContext<State, Event extends EventClass = never> {
  readonly id: string
  readonly ref: ActorRef
  readonly caller: Caller
  readonly principal: Option.Option<Principal>
  /** The last committed state; never uncommitted writes of a running turn. */
  readonly state: Readonly<State>
  /**
   * The last event committed when `state` was read: resume `events` after it
   * to follow on from this state without missing or repeating an event.
   */
  readonly cursor: string
  /**
   * Committed events of one declared class after the exclusive `after` cursor
   * and up to `cursor`, in stream order; omitted, from the start. A cursor this
   * actor never issued fails with `UnknownCursor`, and pruned history after it
   * with `RetentionGap`.
   */
  readonly events: <E extends Event>(
    event: E,
    options?: { readonly after?: string | undefined },
  ) => Effect.Effect<ReadonlyArray<EventEntry<E["Type"]>>, UnknownCursor | RetentionGap>
}
