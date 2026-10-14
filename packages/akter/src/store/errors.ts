import { Schema } from "effect"

/**
 * The lease no longer authorizes writes to its shard: another owner opened the
 * shard after it, the store holds a checkpoint past the lease's head, or an
 * earlier append on the lease ended with an unknown outcome. The holder drops
 * the shard's in-memory state and opens it again.
 */
export class StaleEpoch extends Schema.TaggedError<StaleEpoch>()("StaleEpoch", {
  shard: Schema.Finite,
  open: Schema.BigInt,
}) {
  override get message() {
    return `The lease on shard ${this.shard} opened at offset ${this.open} is no longer the shard's owner`
  }
}

/**
 * The bucket did not answer, answered with a server error, or throttled the
 * request. For a write the outcome is unknown: the object may or may not exist.
 */
export class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  {
    operation: Schema.String,
    key: Schema.String,
    status: Schema.optional(Schema.Finite),
    reason: Schema.String,
  },
) {
  override get message() {
    return `Store ${this.operation} of ${this.key} failed${this.status === undefined ? "" : ` with status ${this.status}`}: ${this.reason}`
  }
}

/**
 * A log operation could not reach the bucket after its retries. An append
 * that ends this way has an unknown outcome and closes its lease; the next
 * open decides from the segment headers.
 */
export class LogUnavailable extends Schema.TaggedError<LogUnavailable>()("LogUnavailable", {
  operation: Schema.String,
  key: Schema.String,
  status: Schema.optional(Schema.Finite),
  reason: Schema.String,
}) {
  override get message() {
    return `Log ${this.operation} of ${this.key} failed${this.status === undefined ? "" : ` with status ${this.status}`}: ${this.reason}`
  }
}

/**
 * A log object's bytes are not what its key promises: a segment, checkpoint
 * manifest or `meta/store` does not decode, carries a format version this
 * release cannot read, or a segment the shard's history needs is absent.
 */
export class CorruptSegment extends Schema.TaggedError<CorruptSegment>()("CorruptSegment", {
  key: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Stored object ${this.key} is unreadable: ${this.reason}`
  }
}

/**
 * A page's stored bytes do not hash to its key or do not decode, or a page a
 * manifest names is not stored. Raised as a defect: a damaged page never
 * yields default or partial state.
 */
export class PageCorrupt extends Schema.TaggedError<PageCorrupt>()("PageCorrupt", {
  hash: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Page ${this.hash} ${this.reason}`
  }
}

/**
 * `meta/store` disagrees with the configuration this process was started
 * with, so it refuses the store rather than adopt or overwrite the record.
 */
export class StoreMismatch extends Schema.TaggedError<StoreMismatch>()("StoreMismatch", {
  setting: Schema.Literal("shards"),
  stored: Schema.Finite,
  configured: Schema.Finite,
}) {
  override get message() {
    return `The store records ${this.setting} ${this.stored}, but this process is configured with ${this.configured}`
  }
}
