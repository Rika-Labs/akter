import { Data, Effect, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { topologyRead } from "./access.ts"
import { NekiRouting } from "./session.ts"
import { BUCKETS } from "../../turn/outbox.ts"
import {
  Authority,
  type BucketRange,
  checkRanges,
  type Placement,
  ShardDirectory,
} from "../shards.ts"

const Topology = Schema.Struct({
  authoritative_shard_group: Schema.optional(Schema.String),
  default_shard_group: Schema.optional(Schema.String),
  shard_indexes: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        type: Schema.String,
        columns: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
  shard_groups: Schema.Array(
    Schema.Struct({
      uid: Schema.String,
      default_shard_index: Schema.optional(Schema.String),
      key_ranges: Schema.Array(
        Schema.Struct({
          shard_uid: Schema.String,
          start: Schema.optional(Schema.NullOr(Schema.String)),
          end: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
  databases: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        default_shard_group: Schema.optional(Schema.String),
        schemas: Schema.optional(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              default_shard_group: Schema.optional(Schema.String),
              tables: Schema.optional(
                Schema.Record(
                  Schema.String,
                  Schema.Struct({ shard_group: Schema.optional(Schema.String) }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
})

const decodeTopology = Schema.decodeUnknownEffect(Schema.fromJsonString(Topology))

/** A Neki topology whose routed group the runtime cannot follow, with the reason. */
export class TopologyRefused extends Data.TaggedError("TopologyRefused")<{
  readonly message: string
  readonly cause: unknown
}> {
  static readonly make = (fields: { readonly message: string; readonly cause: unknown }) =>
    new TopologyRefused(fields)
}

/** The data shard map of one schema of a Neki database, at a topology revision. */
export interface NekiShardMap {
  readonly revision: string
  readonly ranges: ReadonlyArray<BucketRange>
  readonly placement: Placement
}

/** The shard index expressions a map can follow: the key itself, or its bucket shifted to 0..255. */
type Indexed = "key" | "bucket"

const BUCKET_EXPRESSION = /^\(\s*routing_key\s*>>\s*56\s*\)\s*\+\s*128$/

const indexedOf = (
  index:
    | { readonly type: string; readonly columns?: ReadonlyArray<string> | undefined }
    | undefined,
): Indexed | undefined => {
  if (index?.type !== "range" || index.columns?.length !== 1) return undefined

  if (index.columns[0] === "routing_key") return "key"

  return BUCKET_EXPRESSION.test(index.columns[0]!) ? "bucket" : undefined
}

/**
 * The first bucket at or past a key-range bound. Neki reads a bound as the
 * hexadecimal value of the indexed expression and orders keys by their signed
 * value: on a two-shard cluster, `80` on `routing_key` split at key 128 and
 * `4000000000000000` at key 2^62, and `80` on `(routing_key >> 56) + 128` at
 * bucket 0. A bound inside a bucket would put one bucket on two shards, which
 * no range of this map can express.
 */
const boundBucket = (hex: string | null | undefined, indexed: Indexed, open: number) => {
  if (hex === undefined || hex === null || hex === "") return open

  if (!/^[0-9a-f]{1,16}$/i.test(hex))
    throw new Error(`Neki key range bound "${hex}" is not hexadecimal`)

  const value = BigInt(`0x${hex}`)

  if (indexed === "bucket") {
    if (value > 256n) throw new Error(`Neki key range bound "${hex}" is past the last bucket`)

    return Number(value) - 128
  }

  if (value % (1n << 56n) !== 0n || value >= 1n << 63n)
    throw new Error(`Neki key range bound "${hex}" splits a routing_key bucket between shards`)

  return Number(value >> 56n)
}

/**
 * The bucket ranges of a Neki topology for `database`'s `schema`. A schema
 * with no table in a routed group keeps the single untargeted range, so every
 * statement goes through the router as on an unsharded database. Otherwise
 * each key range of that group becomes one bucket range naming its shard. A
 * schema that routes tables through two groups, or through an index on
 * anything but `routing_key` or its bucket, is refused: the runtime computes
 * only `routing_key`.
 */
export const shardMapOf = ({
  topology,
  database,
  schema,
}: {
  readonly topology: string
  readonly database: string
  readonly schema: string
}) =>
  Effect.flatMap(decodeTopology(topology), (decoded) =>
    Effect.try({
      try: () => mapOf({ decoded, database, schema }),
      catch: (cause) => TopologyRefused.make({ message: String(cause), cause }),
    }),
  )

const mapOf = ({
  decoded,
  database,
  schema,
}: {
  readonly decoded: typeof Topology.Type
  readonly database: string
  readonly schema: string
}): Omit<NekiShardMap, "revision"> => {
  const located = decoded.databases?.[database]
  const tables = located?.schemas?.[schema]
  const fallback =
    tables?.default_shard_group ?? located?.default_shard_group ?? decoded.default_shard_group
  const groupOf = (uid: string | undefined) =>
    decoded.shard_groups.find((candidate) => candidate.uid === uid)
  const isRouted = (uid: string | undefined) => groupOf(uid)?.default_shard_index !== undefined
  const authoritative = groupOf(decoded.authoritative_shard_group)?.key_ranges
  const placement: Placement = {
    authoritative: authoritative?.length === 1 ? authoritative[0]!.shard_uid : undefined,
    routes: (table) => isRouted(tables?.tables?.[table]?.shard_group ?? fallback),
  }
  const routed = new Set(
    Object.values(tables?.tables ?? {})
      .map((table) => table.shard_group ?? fallback)
      .concat(fallback === undefined ? [] : [fallback])
      .flatMap((uid) => (isRouted(uid) ? [groupOf(uid)!] : [])),
  )

  if (routed.size === 0) return { ranges: [BUCKETS], placement }

  if (routed.size > 1)
    throw new Error(`Schema ${database}.${schema} routes tables through more than one shard group`)

  const [group] = [...routed]
  const indexed = indexedOf(decoded.shard_indexes?.[group!.default_shard_index!])

  if (indexed === undefined)
    throw new Error(
      `Shard group ${group!.uid} is not routed by a range index on routing_key or its bucket`,
    )

  const ranges = group!.key_ranges.flatMap((range): Array<BucketRange> => {
    const first = boundBucket(range.start, indexed, BUCKETS.first)
    const last = boundBucket(range.end, indexed, BUCKETS.last + 1) - 1

    return first > last ? [] : [{ first, last, shard: range.shard_uid }]
  })

  const covered = ranges.reduce((sum, range) => sum + range.last - range.first + 1, 0)

  if (!checkRanges(ranges) || covered !== BUCKETS.last - BUCKETS.first + 1)
    throw new Error(`Shard group ${group!.uid} does not cover every routing_key bucket once`)

  return { ranges: ranges.sort((a, b) => a.first - b.first), placement }
}

/** Reads the topology and its revision in one statement, so the map and revision agree. */
const readMap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{
    topology: string
    revision: string
    database: string
    schema: string
  }>`SELECT __neki.get_data_topology() AS topology,
      __neki.get_data_topology_revision()::text AS revision,
      current_database() AS database, current_schema() AS schema`

  const found = yield* shardMapOf({
    topology: row!.topology,
    database: row!.database,
    schema: row!.schema,
  })

  return { revision: row!.revision, ...found } satisfies NekiShardMap
})

/** The statement a turn sends to learn the router's topology revision. */
export const REVISION_STATEMENT = "SELECT __neki.get_data_topology_revision()::text AS revision"

/** How often the map is reread when nothing asked for it, so scans follow a moved range. */
const REFRESH_EVERY = "10 seconds"

/**
 * The live shard map of a Neki database, read on the authority sessions
 * before the runtime starts, so a topology the runtime cannot follow stops
 * it; a reread from inside a turn therefore never uses the turn's session.
 * It is reread every `REFRESH_EVERY`, and whenever a turn sees a revision
 * newer than the map's. A failed reread keeps the previous map and is logged.
 * A server without Neki's topology functions, such as Postgres standing in
 * for Neki, routes nothing, so it gets no directory and the static map.
 */
export const nekiDirectory = Layer.unwrap(
  Effect.gen(function* () {
    if ((yield* NekiRouting) === "none") return Layer.empty
    const sql = (yield* Authority) ?? (yield* SqlClient.SqlClient)
    const [found] = yield* sql<{ present: boolean }>`
      SELECT to_regprocedure('__neki.get_data_topology()') IS NOT NULL AS present`.pipe(
      topologyRead,
    )

    if (found?.present !== true) return Layer.empty

    return Layer.effect(
      ShardDirectory,
      Effect.gen(function* () {
        const read = readMap.pipe(Effect.provideService(SqlClient.SqlClient, sql))
        let current = yield* read.pipe(topologyRead)
        const reading = Semaphore.makeUnsafe(1)

        const refresh = reading.withPermit(
          read.pipe(
            Effect.tap((next) =>
              Effect.sync(() => {
                if (BigInt(next.revision) >= BigInt(current.revision)) current = next
              }),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) => Effect.logWarning("Neki shard map refresh failed", cause)),
          ),
        )

        yield* Effect.sleep(REFRESH_EVERY).pipe(
          Effect.andThen(refresh),
          Effect.forever,
          Effect.forkScoped,
        )

        return ShardDirectory.of({
          ranges: Effect.sync(() => current.ranges),
          refresh,
          revision: Effect.sync(() => current.revision),
          revisionStatement: REVISION_STATEMENT,
          placement: Effect.sync(() => current.placement),
        })
      }),
    )
  }),
)

const Bindings = Schema.fromJsonString(
  Schema.Struct({
    default_shard_group: Schema.optional(Schema.String),
    shard_groups: Schema.Array(
      Schema.Struct({
        uid: Schema.String,
        default_shard_index: Schema.optional(Schema.String),
      }),
    ),
    databases: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          schemas: Schema.optional(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                default_shard_group: Schema.optional(Schema.String),
                tables: Schema.optional(
                  Schema.Record(
                    Schema.String,
                    Schema.Struct({ shard_group: Schema.optional(Schema.String) }),
                  ),
                ),
              }),
            ),
          ),
        }),
      ),
    ),
  }),
)

const decodeBindings = Schema.decodeUnknownEffect(Bindings)

/**
 * Which of `tables` the connected Neki database places in a shard group that has a shard index,
 * that is, a group routed by `routing_key`. The router serves only a view over a single table
 * there and refuses one that reads two relations, even of one group. A table's group is its own
 * binding, else the schema's default, else the cluster's. Neither a database without Neki's
 * topology function nor a topology that does not name the database routes anything.
 */
export const routedTables = Effect.fnUntraced(function* (tables: ReadonlyArray<string>) {
  if ((yield* NekiRouting) === "none") return []
  const sql = yield* SqlClient.SqlClient

  const [available] = yield* sql<{
    readonly present: boolean
  }>`SELECT to_regprocedure('__neki.get_data_topology()') IS NOT NULL AS present`

  if (available?.present !== true) return []

  const [live] = yield* sql<{
    readonly database: string
    readonly schema: string
    readonly topology: string
  }>`SELECT current_database() AS database, current_schema() AS schema,
      t.data_topology_json AS topology
    FROM __neki.get_data_topology() t`

  if (live === undefined) return []

  const topology = yield* decodeBindings(live.topology).pipe(Effect.orDie)
  const schema = topology.databases?.[live.database]?.schemas?.[live.schema]

  return tables.filter((table) => {
    const group =
      schema?.tables?.[table]?.shard_group ??
      schema?.default_shard_group ??
      topology.default_shard_group

    return topology.shard_groups.some(
      (candidate) => candidate.uid === group && candidate.default_shard_index !== undefined,
    )
  })
})
