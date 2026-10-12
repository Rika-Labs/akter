import { Effect, Option, Request, RequestResolver, Schema } from "effect"
import { type RetriedBucket, retryUnavailable } from "./bucket.ts"
import { decodePage, encodePage, PageHash, sha256 } from "./codec.ts"
import { PageCorrupt, type StorageUnavailable } from "./errors.ts"
import { pageKey } from "./keys.ts"

/** Requests in one bucket round of page loads. */
const BATCH = 256

/** Page GETs in flight at once within a batch. */
const CONCURRENCY = 32

/** Loads one page; requests issued together are resolved as one batch. */
class LoadPage extends Request.TaggedClass("LoadPage")<
  { readonly hash: string },
  Uint8Array,
  StorageUnavailable
> {}

/** Statuses a provider may answer a plain PUT of an existing content key with: refused or throttled. */
const RESOLVED_BY_HEAD = new Set([412, 429])

/**
 * Content-addressed pages. A page is written with a plain PUT, so writing the
 * same bytes again refreshes the object instead of failing, and the hash of the
 * stored bytes is its key. A refused or throttled write is a success when the
 * key already holds an object of the page's length: the key is the hash of
 * those bytes. A page that is absent or does not match its key is the
 * `PageCorrupt` defect.
 */
export const bucketPages = ({ bucket, retry }: RetriedBucket) => {
  const retrying = retryUnavailable(retry)
  const load = (hash: string) =>
    Effect.gen(function* () {
      const stored = yield* retrying(bucket.get(pageKey(hash)))
      if (Option.isNone(stored))
        return yield* Effect.die(PageCorrupt.make({ hash, reason: "is not in the store" }))
      return yield* decodePage(hash)(stored.value)
    })

  const resolver = RequestResolver.make<LoadPage>((entries) =>
    Effect.forEach(
      entries,
      (entry) =>
        Effect.exit(load(entry.request.hash)).pipe(
          Effect.map((exit) => entry.completeUnsafe(exit)),
        ),
      { concurrency: CONCURRENCY, discard: true },
    ),
  ).pipe(RequestResolver.batchN(BATCH))

  const putPage = (payload: Uint8Array) =>
    Effect.gen(function* () {
      const stored = encodePage(payload)
      const hash = yield* sha256(stored)
      const key = pageKey(hash)
      yield* retrying(
        bucket.put(key, stored).pipe(
          Effect.catchIf(
            (error) => RESOLVED_BY_HEAD.has(error.status ?? 0),
            (error) =>
              Effect.flatMap(bucket.head(key), (size) =>
                Option.contains(size, stored.length) ? Effect.void : Effect.fail(error),
              ),
          ),
        ),
      )
      return hash
    })

  const getPage = (hash: string) =>
    Schema.is(PageHash)(hash)
      ? Effect.request(new LoadPage({ hash }), resolver)
      : Effect.die(new RangeError("A page hash is 64 lowercase hex digits"))

  return { putPage, getPage }
}
