import { Effect, Option } from "effect"
import {
  Condition,
  type Listed,
  type RetriedBucket,
  retryUnavailable,
  type Versioned,
} from "./bucket.ts"
import type { StoreUnavailable } from "./errors.ts"
import { isLeaseKey, isLeasePrefix } from "./keys.ts"

/**
 * Lease objects under `cluster/` and `gc/`, changed only by create-once or
 * compare-and-swap writes. A write whose response was lost is retried; when the
 * retry finds its condition no longer holds, it reads the key back and counts
 * as applied if the stored bytes are its own, so every body a caller writes
 * must be unique (a counter or nonce in it is enough). Leases are advisory: a
 * lease never authorizes a log write, the log's fence does.
 */
export interface Leases {
  readonly read: (key: string) => Effect.Effect<Option.Option<Versioned>, StoreUnavailable>
  /** Creates the key if absent and returns its etag; none if it exists. */
  readonly create: (
    key: string,
    body: Uint8Array,
  ) => Effect.Effect<Option.Option<string>, StoreUnavailable>
  /** Replaces the key while its etag is `etag` and returns the new etag; none if it changed. */
  readonly replace: (
    key: string,
    body: Uint8Array,
    etag: string,
  ) => Effect.Effect<Option.Option<string>, StoreUnavailable>
  /** Writes the key unconditionally and returns its etag. */
  readonly write: (key: string, body: Uint8Array) => Effect.Effect<string, StoreUnavailable>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<Listed>, StoreUnavailable>
  readonly remove: (key: string) => Effect.Effect<void, StoreUnavailable>
}

const bytesEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/** The lease interface over a bucket, with the store's retry policy. */
export const bucketLeases = ({ bucket, retry }: RetriedBucket): Leases => {
  const retrying = retryUnavailable(retry)
  const checked = <A, E>(key: string, valid: boolean, effect: Effect.Effect<A, E>) =>
    valid ? effect : Effect.die(new RangeError(`${key} is not a lease key under cluster/ or gc/`))

  const conditional = (key: string, body: Uint8Array, condition: Condition) =>
    Effect.suspend(() => {
      let ambiguous = false
      return retrying(
        Effect.gen(function* () {
          const written = yield* bucket.leases.write(key, body, condition).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                ambiguous = true
              }),
            ),
          )
          if (Option.isSome(written) || !ambiguous) return written
          const current = yield* bucket.leases.read(key)
          return Option.map(
            Option.filter(current, (stored) => bytesEqual(stored.body, body)),
            (stored) => stored.etag,
          )
        }),
      )
    })

  return {
    read: (key) => checked(key, isLeaseKey(key), retrying(bucket.leases.read(key))),
    create: (key, body) =>
      checked(key, isLeaseKey(key), conditional(key, body, Condition.Absent())),
    replace: (key, body, etag) =>
      checked(key, isLeaseKey(key), conditional(key, body, Condition.Matches({ etag }))),
    write: (key, body) =>
      checked(
        key,
        isLeaseKey(key),
        retrying(bucket.leases.write(key, body, Condition.Always())).pipe(
          Effect.map(Option.getOrElse(() => "")),
        ),
      ),
    list: (prefix) => checked(prefix, isLeasePrefix(prefix), retrying(bucket.leases.list(prefix))),
    remove: (key) => checked(key, isLeaseKey(key), retrying(bucket.leases.remove(key))),
  }
}
