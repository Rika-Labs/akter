import { Effect, Option } from "effect"
import type { Bucket } from "./bucket.ts"
import { CorruptSegment } from "./errors.ts"
import { checkpointOffset, checkpointPrefix, logPrefix, segmentOffset } from "./keys.ts"

interface Stored {
  readonly key: string
  readonly offset: bigint
  readonly modified: number
}

/** A checkpoint covers a whole segment, so the first retained entry needs a preceding image. */
export const historyWindow = Effect.fnUntraced(function* (
  bucket: Bucket,
  shard: number,
  cutoff: number,
) {
  const segments: Array<Stored> = []
  for (const key of yield* bucket.list(logPrefix(shard))) {
    const offset = segmentOffset(shard, key)
    if (Option.isNone(offset)) continue
    const modified = yield* bucket.modified(key)
    if (Option.isNone(modified))
      return yield* CorruptSegment.make({ key, reason: "listed segment has no last-modified time" })
    segments.push({ key, offset: offset.value, modified: modified.value })
  }
  const checkpoints: Array<Stored> = []
  for (const key of yield* bucket.list(checkpointPrefix(shard))) {
    const offset = checkpointOffset(shard, key)
    if (Option.isNone(offset)) continue
    const modified = yield* bucket.modified(key)
    if (Option.isNone(modified))
      return yield* CorruptSegment.make({
        key,
        reason: "listed checkpoint has no last-modified time",
      })
    checkpoints.push({ key, offset: offset.value, modified: modified.value })
  }
  const first = segments.find((segment) => segment.modified >= cutoff)?.offset
  const anchor =
    first === undefined ? undefined : checkpoints.find((checkpoint) => checkpoint.offset < first)
  return { segments, checkpoints, first, anchor }
})
