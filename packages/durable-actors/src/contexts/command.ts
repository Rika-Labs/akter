import { Context, type DateTime, Effect, Option } from "effect"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"
import type { AnyBlob } from "../members/blob.ts"
import type { EventClass } from "../members/event.ts"
import type { BlobRead, BlobWrite } from "../state/blob.ts"
import type { Group, AnyOwnedTable, ScopedRead, ScopedRows } from "../tables/owned.ts"

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
export interface CommandContext<
  State,
  Event extends EventClass = never,
  Tables extends AnyOwnedTable = AnyOwnedTable,
  Blobs extends AnyBlob = AnyBlob,
> {
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
  /** This actor's rows of a declared table, bound to the turn transaction. */
  readonly rows: <T extends Tables>(table: T) => ScopedRows<T>
  /** Read-only joins across the actor's placement group, inside the turn transaction. */
  readonly group: Group
  /** This actor's entries of a declared blob, bound to the turn transaction. */
  readonly blob: (blob: Blobs) => BlobWrite
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
export interface QueryContext<
  State,
  Event extends EventClass = never,
  Tables extends AnyOwnedTable = AnyOwnedTable,
  Blobs extends AnyBlob = AnyBlob,
> {
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
   * with `RetentionGap`. One call returns at most `limit` entries (default
   * 1,000, at most 10,000); a full page continues after its last entry's cursor.
   */
  readonly events: <E extends Event>(
    event: E,
    options?: { readonly after?: string | undefined; readonly limit?: number | undefined },
  ) => Effect.Effect<ReadonlyArray<EventEntry<E["Type"]>>, UnknownCursor | RetentionGap>
  /** This actor's committed rows of a declared table. */
  readonly rows: <T extends Tables>(table: T) => ScopedRead<T>
  /** Read-only joins across the actor's placement group. */
  readonly group: Group
  /** This actor's committed entries of a declared blob. */
  readonly blob: (blob: Blobs) => BlobRead
}
