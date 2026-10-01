import { Context, type DateTime, Effect, Option, type Stream } from "effect"
import type { RetentionGap, UnknownCursor } from "../errors/events.ts"
import type { ActorRef, Caller, Principal } from "../identity/caller.ts"
import type { AnyBlob } from "../members/blob.ts"
import type { AnyJob, ProgressJob, ProgressOf } from "../members/job.ts"
import type { EventClass } from "../members/event.ts"
import type { BlobReadOf, BlobWriteOf } from "../state/blob.ts"
import type { Group, AnyOwnedTable, ScopedRead, TurnRows } from "../tables/owned.ts"

/**
 * The running turn's marker while a command turn executes. Request/reply
 * calls such as a handle's commands and `Content.upload` refuse to run while
 * it is set.
 */
export const InsideTurn = Context.Reference<symbol | undefined>("akter/InsideTurn", {
  defaultValue: () => undefined,
})

/** Dies with a defect when run inside a command turn, where request/reply would wait on a transaction it holds. */
export const outsideTurn = Effect.gen(function* () {
  if ((yield* InsideTurn) !== undefined)
    return yield* Effect.die(new Error("Request/reply inside a turn"))
})

declare const TurnTypeId: unique symbol

/** Type-level identity of one actor's command-turn service, so `X.Turn` names only that actor's turn. */
export interface Turn<Name extends string> {
  readonly [TurnTypeId]: Name
}

declare const MintableTypeId: unique symbol

/** Type-level mark of an unkeyed actor that declares `createdBy`, so turns can mint it. */
export interface Mintable<Id extends string = string> {
  readonly [MintableTypeId]: Id
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
  readonly rows: <T extends Tables>(table: T) => TurnRows<T>
  /** Read-only joins across the actor's placement group, inside the turn transaction. */
  readonly group: Group
  /**
   * This actor's entries of a declared blob, or its references to declared
   * content, bound to the turn transaction. Content bytes are never readable in a turn.
   */
  readonly blob: <B extends Blobs>(blob: B) => BlobWriteOf<B>
  /**
   * Derives the id of a new `child` from this command id and the number of
   * earlier mints in the turn; retries of the command mint the same ids. The
   * turn must stage an intent to the child's `createdBy` command, which alone
   * can create it.
   */
  readonly mint: <Id extends string>(child: Mintable<Id>) => Effect.Effect<Id>
}

/** One committed event and where it sits in its actor's stream. */
export interface EventEntry<E> {
  /** Exclusive resume point: pass it as `after` to read the events that follow. */
  readonly cursor: string
  readonly event: E
  readonly commandId: string
  readonly timestamp: DateTime.Utc
}

/** One executor progress frame of a job this actor enqueued. */
export interface ProgressEntry<J extends ProgressJob> {
  readonly jobId: string
  /** The job as enqueued. */
  readonly job: J["Type"]
  readonly attempt: number
  /** Per attempt, from 1; a gap means frames of the attempt were lost. */
  readonly seq: number
  readonly frame: ProgressOf<J>
}

/** The read-only context of one query, obtained with `yield* X.Read`. */
export interface QueryContext<
  State,
  Event extends EventClass = never,
  Tables extends AnyOwnedTable = AnyOwnedTable,
  Blobs extends AnyBlob = AnyBlob,
  Jobs extends AnyJob = never,
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
  /** This actor's committed entries of a declared blob, or the content it references. */
  readonly blob: <B extends Blobs>(blob: B) => BlobReadOf<B>
  /**
   * Committed events of one declared class after the exclusive `after`
   * cursor, then each one as its turn commits, with no gap or repeat between
   * the two. Only stream handlers provide `InStream`, so a query that follows
   * leaves an unsatisfiable requirement; the stream ends with its activation.
   */
  readonly follow: <E extends Event>(
    event: E,
    options?: { readonly after?: string | undefined },
  ) => Stream.Stream<EventEntry<E["Type"]>, UnknownCursor | RetentionGap, InStream>
  /**
   * Live executor progress of this actor's jobs of class `job`, from the
   * moment of the call; it has no history, may skip or coalesce frames, and
   * ends with the stream. Only stream handlers whose member lists `job` in
   * `progress.jobs` receive any.
   */
  readonly progress: <J extends Extract<Jobs, ProgressJob>>(
    job: J,
    options?: { readonly jobId?: string | undefined },
  ) => Stream.Stream<ProgressEntry<J>, never, InStream>
}

/**
 * Provided only while a stream handler runs. `read.follow` requires it and
 * `X.toLayer` removes it from stream handler requirements.
 */
export class InStream extends Context.Service<InStream, { readonly stream: symbol }>()(
  "@rikalabs/akter/contexts/command/InStream",
) {}
