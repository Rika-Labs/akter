import { Schema } from "effect"

export const BUCKET_COUNT = 256
export const AUTHORITATIVE_GROUP = "authoritative"
export const ACTOR_DATA_GROUP = "actor_data"
export const ROUTING_KEY_INDEX = "routing_key_range"

/**
 * The value the `range` shard index routes by: the signed bucket `routing_key >> 56`
 * moved to 0..255. Neki's `range` index orders its value as a signed 64-bit integer and
 * reads each key-range bound as a hexadecimal integer that must fit a signed 64-bit
 * integer, so no bound can be negative. Routed on `routing_key` itself, every negative key
 * would land on the first shard and a bound such as `80` would split the key space at the
 * key 128, not at a bucket.
 */
export const ROUTING_BUCKET = "(routing_key >> 56) + 128"

export type KeyRange = {
  readonly shard_uid: string
  readonly start?: string
  readonly end?: string
}

export type ShardGroup = {
  readonly uid: string
  readonly default_shard_index?: string
  readonly key_ranges: ReadonlyArray<KeyRange>
}

export type SchemaPlacement = {
  readonly default_shard_group: string
  readonly tables: Readonly<Record<string, { readonly shard_group: string }>>
}

export type DataTopology = {
  readonly authoritative_shard_group: string
  readonly default_shard_group: string
  readonly shard_groups: ReadonlyArray<ShardGroup>
  readonly shard_indexes: Readonly<
    Record<string, { readonly type: "range"; readonly columns: ReadonlyArray<string> }>
  >
  readonly databases: Readonly<
    Record<string, { readonly schemas: Readonly<Record<string, SchemaPlacement>> }>
  >
}

export type BucketSpan = { readonly first: number; readonly last: number }

export type TopologyInput = {
  readonly authoritativeShard: string
  readonly dataShards: ReadonlyArray<string>
  readonly database: string
  readonly schema: string
  readonly routedTables: ReadonlyArray<string>
}

export type TopologyScope = { readonly database: string; readonly schema: string }

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0")

const signedBucket = (index: number) => index - 128

const checkRange = (shardCount: number) => {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > BUCKET_COUNT)
    throw new RangeError(`shardCount must be an integer from 1 to ${BUCKET_COUNT}`)
}

/**
 * The tables a data group may hold: the framework's per-actor tables. Each keeps
 * `routing_key` in every unique key, carries no trigger and references only another of
 * them, so no statement, trigger or foreign key on one of its rows reaches a control
 * table. On a data shard that would be the shard's own copy of the control table, which
 * is empty, and Neki reads and writes it without an error. Every other table stays on
 * the authoritative shard, whatever the number of shards.
 */
export const ROUTABLE_TABLES: ReadonlyArray<string> = [
  "actor_blobs",
  "actor_connections",
  "actor_content_refs",
  "actor_dead_letters",
  "actor_events",
  "actor_generations",
  "actor_operator_audit",
  "actor_outbox",
  "actor_receipts",
  "actor_state",
  "actor_subscription_cursors",
  "actor_subscription_tags",
  "actor_subscriptions",
  "actor_workflow_executions",
  "actor_workflow_step",
  "tenant_content_chunks",
  "tenant_content_sweeps",
  "tenant_contents",
]

/** Refuses a routed table that is not one of `ROUTABLE_TABLES`. */
export const checkRoutedTables = (routedTables: ReadonlyArray<string>) => {
  const refused = routedTables.filter((table) => !ROUTABLE_TABLES.includes(table))
  if (refused.length > 0)
    throw new RangeError(
      `routedTables may list only the framework's per-actor tables; ${refused.join(", ")} must stay on the authoritative shard`,
    )
}

/**
 * A topology that routes no table holds every row on the authoritative shard, so
 * further data shards would stay empty, and the first routed tables would then have
 * to move between shards instead of only between groups of one shard.
 */
export const checkShardCount = (input: {
  readonly shardCount: number
  readonly routedTables: ReadonlyArray<string>
}) => {
  const { shardCount, routedTables } = input
  checkRange(shardCount)
  if (shardCount > 1 && routedTables.length === 0)
    throw new RangeError(
      "shardCount above 1 needs routedTables: no table would use the data shards",
    )
}

/**
 * The key-range bound at which a signed bucket starts: the value of `ROUTING_BUCKET`
 * for that bucket, in hexadecimal. Bucket -128 is `00`, bucket -1 is `7f`, bucket 0 is
 * `80` and bucket 127 is `ff`, so the shards hold the buckets in signed order, the order
 * the runtime's bucket ranges use.
 */
export const bucketHex = (bucket: number) => {
  if (!Number.isInteger(bucket) || bucket < -128 || bucket > 127)
    throw new RangeError("bucket must be an integer from -128 to 127")
  return hexByte(bucket + 128)
}

/** The first bucket index, 0..255, owned by each shard when 256 buckets are split into near-equal runs. */
const startBytes = (shardCount: number) => {
  checkRange(shardCount)
  return Array.from({ length: shardCount }, (_, shard) =>
    Math.floor((shard * BUCKET_COUNT) / shardCount),
  )
}

const keyRange = (shard: string, start: string | undefined, end: string | undefined): KeyRange => {
  if (start === undefined && end === undefined) return { shard_uid: shard }
  if (start === undefined) return { shard_uid: shard, end }
  if (end === undefined) return { shard_uid: shard, start }
  return { shard_uid: shard, start, end }
}

/**
 * Contiguous key ranges over `ROUTING_BUCKET` that cover every routing key, one per
 * shard, with every boundary on a bucket boundary. The first range has no start and
 * the last has no end, so no 64-bit key falls outside them.
 */
export const keyRanges = (shards: ReadonlyArray<string>): ReadonlyArray<KeyRange> => {
  const starts = startBytes(shards.length)
  return shards.map((shard, index) =>
    keyRange(
      shard,
      index === 0 ? undefined : hexByte(starts[index] ?? 0),
      index === shards.length - 1 ? undefined : hexByte(starts[index + 1] ?? 0),
    ),
  )
}

/** The inclusive run of signed buckets each shard owns, in shard order. */
export const shardBucketSpans = (shardCount: number): ReadonlyArray<BucketSpan> => {
  const starts = startBytes(shardCount)
  return starts.map((start, shard) => ({
    first: signedBucket(start),
    last: signedBucket((starts[shard + 1] ?? BUCKET_COUNT) - 1),
  }))
}

/**
 * The topology Neki is given. The authoritative group is the single control shard
 * and the default for every table, in the schema and elsewhere. Only the routed
 * tables are placed in the data group, routed by a range index on the bucket of
 * `routing_key` across the data shards. One data shard, the authoritative one, is the
 * initial unsharded layout.
 *
 * Routing is opt-in because a table that lacks `routing_key` cannot be written in
 * the data group, and a table whose SQL needs the control tables beside it (a
 * trigger that writes one, a key that references one, a uniqueness or ordering
 * that spans every actor) is only correct while it shares their shard. A table
 * nobody listed therefore stays where it works on any number of data shards.
 */
export const dataTopology = (input: TopologyInput): DataTopology => ({
  authoritative_shard_group: AUTHORITATIVE_GROUP,
  default_shard_group: AUTHORITATIVE_GROUP,
  shard_indexes: { [ROUTING_KEY_INDEX]: { type: "range", columns: [ROUTING_BUCKET] } },
  shard_groups: [
    { uid: AUTHORITATIVE_GROUP, key_ranges: [{ shard_uid: input.authoritativeShard }] },
    {
      uid: ACTOR_DATA_GROUP,
      default_shard_index: ROUTING_KEY_INDEX,
      key_ranges: keyRanges(input.dataShards),
    },
  ],
  databases: {
    [input.database]: {
      schemas: {
        [input.schema]: {
          default_shard_group: AUTHORITATIVE_GROUP,
          tables: Object.fromEntries(
            input.routedTables.map((table) => [table, { shard_group: ACTOR_DATA_GROUP }]),
          ),
        },
      },
    },
  },
})

export const LiveTopology = Schema.Struct({
  authoritative_shard_group: Schema.String,
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

export type LiveTopology = typeof LiveTopology.Type

const LOWEST = -(2n ** 63n)
const BEYOND = 2n ** 63n

/** A `range` index bound is a hexadecimal integer, so `40` and `0040` are one bound. */
const bound = (hex: string | null | undefined, open: bigint) => {
  if (hex === undefined || hex === null || hex === "") return open
  if (!/^[0-9a-f]{1,16}$/i.test(hex)) throw new RangeError(`"${hex}" is not a hexadecimal bound`)
  return BigInt(`0x${hex}`)
}

const dataRanges = (topology: LiveTopology) =>
  (topology.shard_groups.find((group) => group.uid === ACTOR_DATA_GROUP)?.key_ranges ?? [])
    .map((range) => ({
      shard: range.shard_uid,
      from: bound(range.start, LOWEST),
      to: bound(range.end, BEYOND),
    }))
    .sort((left, right) => (left.from < right.from ? -1 : 1))

/** The data shards a topology routes `routing_key` to, in key order. */
export const dataShardsOf = (topology: LiveTopology) =>
  dataRanges(topology).map((range) => range.shard)

/**
 * What a topology places and where, as a string two topologies can be compared by:
 * the authoritative shard, the data ranges as numeric bounds, and the schema's table
 * bindings. Group names and sections this module does not generate do not take part.
 * The active shard index and cluster/schema defaults detect changes in routing semantics.
 */
export const placementOf = (scope: TopologyScope) => (topology: LiveTopology) => {
  const authoritative = topology.shard_groups.find(
    (group) => group.uid === topology.authoritative_shard_group,
  )?.key_ranges
  const schema = topology.databases?.[scope.database]?.schemas?.[scope.schema]
  const group = topology.shard_groups.find((candidate) => candidate.uid === ACTOR_DATA_GROUP)
  const index =
    group?.default_shard_index === undefined
      ? undefined
      : topology.shard_indexes?.[group.default_shard_index]
  return JSON.stringify({
    authoritative: authoritative?.length === 1 ? authoritative[0]?.shard_uid : null,
    data: dataRanges(topology).map((range) => [
      range.shard,
      range.from.toString(),
      range.to.toString(),
    ]),
    schemaDefault: schema?.default_shard_group ?? null,
    clusterDefault: topology.default_shard_group ?? null,
    shardIndex: group?.default_shard_index ?? null,
    indexType: index?.type ?? null,
    indexColumns: index?.columns ?? null,
    tables: Object.entries(schema?.tables ?? {})
      .map(([table, binding]) => `${table}=${binding.shard_group ?? ""}`)
      .sort(),
  })
}
