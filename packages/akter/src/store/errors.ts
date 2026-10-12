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
export class StoreUnavailable extends Schema.TaggedError<StoreUnavailable>()("StoreUnavailable", {
  operation: Schema.String,
  key: Schema.String,
  status: Schema.optional(Schema.Finite),
  reason: Schema.String,
}) {
  override get message() {
    return `Store ${this.operation} of ${this.key} failed${this.status === undefined ? "" : ` with status ${this.status}`}: ${this.reason}`
  }
}

/**
 * An object's bytes are not what its key promises: they do not decode, carry a
 * format version this release cannot read, do not hash to a page's key, or a
 * log segment the shard's history needs is absent.
 */
export class CorruptSegment extends Schema.TaggedError<CorruptSegment>()("CorruptSegment", {
  key: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Stored object ${this.key} is unreadable: ${this.reason}`
  }
}

/** No page is stored under the hash a manifest or caller named. */
export class MissingPage extends Schema.TaggedError<MissingPage>()("MissingPage", {
  hash: Schema.String,
}) {
  override get message() {
    return `Page ${this.hash} is not in the store`
  }
}
