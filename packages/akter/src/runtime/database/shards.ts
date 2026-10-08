import { Context, Effect } from "effect"
import type { SqlClient } from "effect/sql"
import { BUCKETS } from "../turn/outbox.ts"

/** One inclusive scheduling range, independent of actor compute ownership. */
export interface BucketRange {
  readonly first: number
  readonly last: number
}

/**
 * Bucket ranges on one database. The default covers the whole key space;
 * tests partition it to verify range boundaries and shared claim capacity.
 */
export const ShardMap = Context.Reference<ReadonlyArray<BucketRange>>("akter/ShardMap", {
  defaultValue: () => [BUCKETS],
})

/** Refuses ranges that overlap or leave the bucket space. */
export const checkRanges = (ranges: ReadonlyArray<BucketRange>) => {
  const sorted = [...ranges].sort((a, b) => a.first - b.first)

  for (const [index, range] of sorted.entries())
    if (
      !Number.isInteger(range.first) ||
      !Number.isInteger(range.last) ||
      range.first < BUCKETS.first ||
      range.last > BUCKETS.last ||
      range.first > range.last ||
      (index > 0 && sorted[index - 1]!.last >= range.first)
    )
      return false

  return true
}

/** The runtime's scheduling ranges, checked before any scan runs. */
export const currentRanges = Effect.gen(function* () {
  const ranges = yield* ShardMap

  if (!checkRanges(ranges))
    return yield* Effect.die(new Error("Invalid or overlapping shard bucket ranges"))

  return ranges
})

/** The ranges as scans read them, in bucket order. */
export const shardRanges = Effect.map(currentRanges, (ranges) =>
  [...ranges].sort((a, b) => a.first - b.first),
)

/**
 * Captures the runtime's scheduling ranges for calls from outside fibers,
 * such as a holder transport's, so every scan uses the same range boundaries.
 */
export const locatedHere = Effect.map(
  ShardMap,
  (map) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, ShardMap, map),
)

/**
 * Runs a scan once per scheduling range. `withinRange` keeps each statement
 * within its inclusive buckets so no row is visited twice.
 */
export const forEachRange = <A, E, R>(effect: (range: BucketRange) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(shardRanges, (ranges) => Effect.forEach(ranges, effect))

/**
 * `AND <column> BETWEEN` the routing keys of `range`'s buckets, or nothing for
 * the whole key space, so an unsharded database runs the statement unchanged.
 * `WHERE` starts the predicate for a statement that has none.
 */
export const withinRange = ({
  sql,
  range,
  column,
  keyword = "AND",
}: {
  readonly sql: SqlClient.SqlClient
  readonly range: BucketRange
  readonly column: string
  readonly keyword?: "AND" | "WHERE"
}) =>
  range.first === BUCKETS.first && range.last === BUCKETS.last
    ? sql.literal("")
    : sql`${sql.literal(keyword)} ${sql.literal(column)} BETWEEN ${BigInt(range.first) << 56n} AND ${(BigInt(range.last + 1) << 56n) - 1n}`
