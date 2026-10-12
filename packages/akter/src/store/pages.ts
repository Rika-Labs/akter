import { Effect, Option, Request, RequestResolver, Schema } from "effect"
import { type RetriedBucket, retryUnavailable } from "./bucket.ts"
import { decodePage, encodePage, PageHash, sha256 } from "./codec.ts"
import { type CorruptSegment, MissingPage, type StoreUnavailable } from "./errors.ts"
import { pageKey } from "./keys.ts"

/** Requests in one bucket round of page loads. */
const BATCH = 256

/** Page GETs in flight at once within a batch. */
const CONCURRENCY = 32

/** Loads one page; requests issued together are resolved as one batch. */
class LoadPage extends Request.TaggedClass("LoadPage")<
  { readonly hash: string },
  Uint8Array,
  MissingPage | CorruptSegment | StoreUnavailable
> {}

/** HTTP status a bucket returns when one key is written faster than it allows. */
const THROTTLED = 429

/**
 * Content-addressed pages. A page is written with a plain PUT, so writing the
 * same bytes again refreshes the object instead of failing, and the hash of the
 * stored bytes is its key. A throttled write of a page that already exists is a
 * success: the bytes under that key are the same bytes.
 */
export const bucketPages = ({ bucket, retry }: RetriedBucket) => {
  const retrying = retryUnavailable(retry)
  const load = (hash: string) =>
    Effect.gen(function* () {
      const key = pageKey(hash)
      const stored = yield* retrying(bucket.get(key))
      if (Option.isNone(stored)) return yield* MissingPage.make({ hash })
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
            (error) => error.status === THROTTLED,
            (error) =>
              Effect.flatMap(bucket.exists(key), (exists) =>
                exists ? Effect.void : Effect.fail(error),
              ),
          ),
        ),
      )
      return hash
    })

  const getPage = (hash: string) =>
    Schema.is(PageHash)(hash)
      ? Effect.request(new LoadPage({ hash }), resolver)
      : Effect.fail(MissingPage.make({ hash }))

  return { putPage, getPage }
}
