import { Data, Effect, type Option, type Schedule, Schema } from "effect"
import { StorageUnavailable } from "./errors.ts"

/** Bounds on a listing: keys strictly after `startAfter`, at most `limit` of them. */
export interface ListOptions {
  readonly startAfter?: string
  readonly limit?: number
}

/** A lease object's bytes and the etag a conditional write must match. */
export interface Versioned {
  readonly body: Uint8Array
  readonly etag: string
}

/** A listed lease object. */
export interface Listed {
  readonly key: string
  readonly etag: string
}

/**
 * When a lease write applies: `Absent` creates the key only if it does not
 * exist (`If-None-Match: *`), `Matches` replaces it only while its etag is
 * unchanged (`If-Match`), `Always` writes unconditionally.
 */
export type Condition = Data.TaggedEnum<{
  Absent: {}
  Matches: { readonly etag: string }
  Always: {}
}>

/** Constructors and matching for {@link Condition}. */
export const Condition = Data.taggedEnum<Condition>()

/**
 * Mutable lease objects. Every successful write returns a fresh etag; a
 * conditional write that does not apply returns none and changes nothing.
 */
export interface LeaseObjects {
  readonly read: (key: string) => Effect.Effect<Option.Option<Versioned>, StorageUnavailable>
  readonly write: (
    key: string,
    body: Uint8Array,
    condition: Condition,
  ) => Effect.Effect<Option.Option<string>, StorageUnavailable>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<Listed>, StorageUnavailable>
  readonly remove: (key: string) => Effect.Effect<void, StorageUnavailable>
}

/**
 * The object primitives a store backend provides. Log segments, checkpoint
 * manifests, pages and `meta/store` are immutable objects; lease objects change
 * only through {@link LeaseObjects}. No method retries: the protocol decides
 * which failures are safe to repeat. A failed write has an unknown outcome.
 */
export interface Bucket {
  readonly get: (
    key: string,
  ) => Effect.Effect<Option.Option<Uint8Array<ArrayBuffer>>, StorageUnavailable>
  /** The stored object's length in bytes; none when the key is absent. */
  readonly head: (key: string) => Effect.Effect<Option.Option<number>, StorageUnavailable>
  /** When the object was last written, in milliseconds since the epoch, at the provider's resolution (one second on S3); none when the key is absent. */
  readonly modified: (key: string) => Effect.Effect<Option.Option<number>, StorageUnavailable>
  /** Creates `key` only if it does not exist; false when it already does. */
  readonly create: (key: string, body: Uint8Array) => Effect.Effect<boolean, StorageUnavailable>
  /** Writes `key` whether or not it exists. */
  readonly put: (key: string, body: Uint8Array) => Effect.Effect<void, StorageUnavailable>
  /** Keys under `prefix` in ascending byte order; the listing reflects every completed write. */
  readonly list: (
    prefix: string,
    options?: ListOptions,
  ) => Effect.Effect<ReadonlyArray<string>, StorageUnavailable>
  /** Deletes every key; deleting a missing key succeeds. */
  readonly delete: (keys: ReadonlyArray<string>) => Effect.Effect<void, StorageUnavailable>
  readonly leases: LeaseObjects
}

/** A bucket and the schedule on which its callers repeat `StorageUnavailable` failures. */
export interface RetriedBucket {
  readonly bucket: Bucket
  readonly retry: Schedule.Schedule<unknown, unknown>
}

/** Repeats an operation that ended `StorageUnavailable`, on the given schedule. */
export const retryUnavailable =
  (schedule: Schedule.Schedule<unknown, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.retry(effect, { schedule, while: Schema.is(StorageUnavailable) })
