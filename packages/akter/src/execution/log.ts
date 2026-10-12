import { Context, Schema } from "effect"
import type { Effect } from "effect"
import type { StoredSegment } from "../snapshots/recovery.ts"

/** Another owner opened the shard since this lease: the segment was not written by us. */
export class StaleEpoch extends Schema.TaggedError<StaleEpoch>()("StaleEpoch", {
  shard: Schema.Int,
  epoch: Schema.Int,
}) {}

/**
 * The log did not answer. `ambiguous` is true when the write may have happened, so the owner must
 * retry the identical bytes and never acknowledge before it knows.
 */
export class LogUnavailable extends Schema.TaggedError<LogUnavailable>()("LogUnavailable", {
  shard: Schema.Int,
  ambiguous: Schema.Boolean,
}) {}

/**
 * The owner died around this append: before it was written, or after it was written and before the
 * owner could act on the answer. Only the simulator's fault injection produces it.
 */
export class OwnerCrashed extends Schema.TaggedError<OwnerCrashed>()("OwnerCrashed", {
  shard: Schema.Int,
  written: Schema.Boolean,
}) {}

/** Ownership of one shard: `epoch` is the offset of the open segment that established it. */
export interface Lease {
  readonly shard: number
  readonly epoch: number
}

/** What opening a shard returns: the lease, the newest checkpoint and the segments after it. */
export interface Opened {
  readonly lease: Lease
  readonly checkpoint: Uint8Array | undefined
  readonly tail: ReadonlyArray<StoredSegment>
}

/**
 * The log boundary the engine appends and recovers through. `open` creates the shard's next
 * segment once, which fences every earlier owner; `append` creates segment `offset` once and fails
 * with `StaleEpoch` when another owner holds it; an append whose answer was lost is retried with
 * the identical bytes, and finding our own bytes there is success.
 */
export interface LogService {
  readonly open: (shard: number) => Effect.Effect<Opened, LogUnavailable>
  readonly append: (
    lease: Lease,
    offset: number,
    bytes: Uint8Array,
  ) => Effect.Effect<void, StaleEpoch | LogUnavailable | OwnerCrashed>
  readonly checkpoint: (
    lease: Lease,
    offset: number,
    bytes: Uint8Array,
  ) => Effect.Effect<void, StaleEpoch | LogUnavailable>
  readonly read: (shard: number) => Effect.Effect<{
    readonly checkpoints: ReadonlyArray<StoredSegment>
    readonly segments: ReadonlyArray<StoredSegment>
  }>
}

/** The log an engine writes through. */
export class Log extends Context.Service<Log, LogService>()("@rikalabs/akter/execution/log") {}
