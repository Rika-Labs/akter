import { Context, Effect, Option } from "effect"
import type { SqlClient } from "effect/sql"
import { BUCKETS, bucketOf } from "../turn/outbox.ts"

/** One inclusive bucket range on one database shard, independent of actor compute ownership. */
export interface BucketRange {
  readonly first: number
  readonly last: number
  /** Neki's shard UID; absent on an ordinary single database. */
  readonly shard?: string | undefined
}

/**
 * The data ranges of a database whose map does not change while it runs.
 * Ordinary databases have one range and no shard; tests name shards here.
 */
export const ShardMap = Context.Reference<ReadonlyArray<BucketRange>>("akter/ShardMap", {
  defaultValue: () => [BUCKETS],
})

/** Where a sharded database keeps the tables it does not route. */
export interface Placement {
  readonly authoritative: string | undefined
  readonly routes: (table: string) => boolean
}

/**
 * A data shard map that can move while the runtime runs: a Neki database
 * whose topology routes tables reads it from the router, and rereads it when
 * a turn sees the router at a newer revision than the map.
 */
export class ShardDirectory extends Context.Service<
  ShardDirectory,
  {
    readonly ranges: Effect.Effect<ReadonlyArray<BucketRange>>
    /** The topology revision the current ranges were read at. */
    readonly revision: Effect.Effect<string>
    /**
     * A statement with no table that answers the router's current revision
     * in a `revision` column. A turn sends it on its targeted session, in its
     * admission flight, to learn whether its map is older than the router's.
     */
    readonly revisionStatement: string
    /** Rereads the map; callers queue for one read at a time, and a failed read keeps the map. */
    readonly refresh: Effect.Effect<void>
    /**
     * Where tables outside the routed group live: the authoritative shard,
     * and whether a table of the runtime's schema is routed. A data shard
     * holds only an empty copy of every other table.
     */
    readonly placement: Effect.Effect<Placement>
  }
>()("@rikalabs/akter/runtime/database/shards/ShardDirectory") {}

/**
 * What the current fiber's statements are about: one actor's routing key, or
 * one shard a scan reads. A key is resolved against the current map at each
 * checkout, so work that outlives a map change follows its rows.
 */
export type Target = { readonly routingKey: bigint } | { readonly shard: string }

/**
 * The data the current fiber's statements touch. The runtime's clients open
 * a session targeted at its shard, so no statement on a routed table passes
 * the router's planner. Undefined, or a key whose bucket no range names a
 * shard for, reaches the authoritative group through the router.
 */
export const ShardTarget = Context.Reference<Target | undefined>("akter/ShardTarget", {
  defaultValue: () => undefined,
})

/**
 * Sessions on the authoritative group only, on a client separate from the
 * default one, so a statement on a registry or control table from a fiber
 * that targets a data shard, or from inside a turn's transaction there, never
 * reaches that shard's copy of the table.
 */
export const Authority = Context.Reference<SqlClient.SqlClient | undefined>(
  "@rikalabs/akter/runtime/database/shards/Authority",
  { defaultValue: () => undefined },
)

/** A shard UID becomes a startup option, so it must not need quoting. */
const SHARD_UID = /^[A-Za-z0-9_-]+$/

/** Whether `shard` can be sent as a startup option without quoting. */
export const isShardUid = (shard: string) => SHARD_UID.test(shard)

/** Refuses a map whose ranges overlap, leave the bucket space, or name an unusable shard. */
export const checkRanges = (ranges: ReadonlyArray<BucketRange>) => {
  const sorted = [...ranges].sort((a, b) => a.first - b.first)

  for (const [index, range] of sorted.entries())
    if (
      !Number.isInteger(range.first) ||
      !Number.isInteger(range.last) ||
      range.first < BUCKETS.first ||
      range.last > BUCKETS.last ||
      range.first > range.last ||
      (index > 0 && sorted[index - 1]!.last >= range.first) ||
      (range.shard !== undefined && !SHARD_UID.test(range.shard))
    )
      return false

  return true
}

/** The current ranges: the live directory when the database has one, else `ShardMap`. */
export const currentRanges = Effect.gen(function* () {
  const directory = yield* Effect.serviceOption(ShardDirectory)
  const ranges = Option.isSome(directory) ? yield* directory.value.ranges : yield* ShardMap

  if (!checkRanges(ranges))
    return yield* Effect.die(new Error("Invalid or overlapping shard bucket ranges"))

  return ranges
})

/** The ranges as scans read them, in bucket order. */
export const shardRanges = Effect.map(currentRanges, (ranges) =>
  [...ranges].sort((a, b) => a.first - b.first),
)

/** The range of the current map that holds `bucket`, if any. */
export const rangeOf = (bucket: number) =>
  Effect.map(currentRanges, (ranges) =>
    ranges.find(({ first, last }) => first <= bucket && bucket <= last),
  )

/** The shard the current fiber's statements go to, or undefined for the router. */
export const targetShard = Effect.flatMap(ShardTarget, (target) => {
  if (target === undefined) return Effect.undefined

  if ("shard" in target) return Effect.succeed(target.shard)

  return Effect.map(rangeOf(bucketOf(target.routingKey)), (range) => range?.shard)
})

/**
 * Dies unless the current fiber's statements reach the authoritative shard,
 * for an authority-placed actor named `actor`, whose turns and queries read
 * tables the topology does not route. A database without a live map, or a
 * map that names no shard, has one copy of every table.
 */
export const requireAuthoritative = (actor: string) =>
  Effect.gen(function* () {
    const directory = yield* Effect.serviceOption(ShardDirectory)
    const target = yield* targetShard

    if (Option.isNone(directory) || target === undefined) return

    const { authoritative } = yield* directory.value.placement

    if (authoritative === target) return

    return yield* Effect.die(
      new Error(
        `${actor} is authority-placed, but the topology puts its bucket on shard ${target}, not on the authoritative shard ${authoritative ?? "(none)"}`,
      ),
    )
  })

/** Runs `effect` against `range`'s shard, or untargeted when the range names none. */
export const onRange =
  (range: BucketRange) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      effect,
      ShardTarget,
      range.shard === undefined ? undefined : { shard: range.shard },
    )

/**
 * Runs `effect` against the shard that holds `routingKey`'s rows, as the map
 * places it when each statement checks out a session.
 */
export const onShard =
  (routingKey: bigint) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, ShardTarget, { routingKey })

/**
 * The shard map the current fiber sees, as a function that hands it to
 * another effect. A service that is called from fibers outside the runtime,
 * such as a transport's or a test's, captures it when it is built, so its
 * statements resolve their shard against the runtime's map.
 */
export const locatedHere = Effect.map(
  Effect.all([ShardMap, Effect.serviceOption(ShardDirectory)]),
  ([map, directory]) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const mapped = Effect.provideService(effect, ShardMap, map)

      return Option.isSome(directory)
        ? Effect.provideService(mapped, ShardDirectory, directory.value)
        : mapped
    },
)

/** Runs `effect` with no target, for work that leaves the actor's own rows. */
export const untargeted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, ShardTarget, undefined)

/**
 * Runs `effect` once per range of the current map, against the range's shard,
 * for statements that are not about one actor and must see every shard's
 * rows. The range is passed on so each statement keeps to its buckets with
 * `withinRange`: a shard that still holds rows of a range it handed on, or
 * two ranges of one shard, are then each read once.
 */
export const forEachRange = <A, E, R>(effect: (range: BucketRange) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(shardRanges, (ranges) =>
    Effect.forEach(ranges, (range) => onRange(range)(effect(range))),
  )

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
