import { Schema } from "effect"

export const BUCKET_COUNT = 256
export const AUTHORITATIVE_GROUP = "authoritative"
export const ACTOR_DATA_GROUP = "actor_data"
export const ROUTING_KEY_INDEX = "routing_key_range"

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
  readonly unshardedTables: ReadonlyArray<string>
}

export type TopologyScope = { readonly database: string; readonly schema: string }

const hexByte = (byte: number) => byte.toString(16).padStart(2, "0")

const signedBucket = (byte: number) => (byte < 128 ? byte : byte - BUCKET_COUNT)

export const checkShardCount = (shardCount: number) => {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > BUCKET_COUNT)
    throw new RangeError(`shardCount must be an integer from 1 to ${BUCKET_COUNT}`)
}

/**
 * The unsigned top byte that `routing_key >> 56` selects once the signed bigint is
 * read as its 64-bit two's-complement pattern, which is how a Neki `range` index
 * orders it: bucket 0 is `00`, bucket 127 is `7f`, bucket -128 is `80` and bucket
 * -1 is `ff`. Neki documents key ranges as hexadecimal prefixes of an unsigned
 * 64-bit space and a `range` index as using the integer directly, but not how a
 * negative integer is encoded, so this is the one place to change if a run against
 * Neki shows otherwise.
 */
export const bucketHex = (bucket: number) => {
  if (!Number.isInteger(bucket) || bucket < -128 || bucket > 127)
    throw new RangeError("bucket must be an integer from -128 to 127")
  return hexByte(bucket & 0xff)
}

/** The first top byte owned by each shard when 256 buckets are split into near-equal runs. */
const startBytes = (shardCount: number) => {
  checkShardCount(shardCount)
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
 * Contiguous key ranges that cover the whole routing-key space, one per shard,
 * with every boundary on a bucket boundary. The first range has no start and the
 * last has no end, so no 64-bit value falls outside them.
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

/**
 * The signed buckets each shard owns, in shard order. Neki orders by the unsigned
 * byte, so a shard whose run crosses `7f`/`80` owns the end of the positive
 * buckets and the start of the negative ones as two spans.
 */
export const shardBucketSpans = (shardCount: number): ReadonlyArray<ReadonlyArray<BucketSpan>> => {
  const starts = startBytes(shardCount)
  return starts.map((start, shard) => {
    const last = (starts[shard + 1] ?? BUCKET_COUNT) - 1
    if (start < 128 && last >= 128)
      return [
        { first: start, last: 127 },
        { first: -128, last: signedBucket(last) },
      ]
    return [{ first: signedBucket(start), last: signedBucket(last) }]
  })
}

/**
 * The topology Neki is given. The authoritative group is the single control shard
 * and the cluster default. Every table in the schema is routed by a range index on
 * `routing_key` across the data shards, except the tables named as unsharded, which
 * stay on the authoritative group. One data shard, the authoritative one, is the
 * initial unsharded layout.
 */
export const dataTopology = (input: TopologyInput): DataTopology => ({
  authoritative_shard_group: AUTHORITATIVE_GROUP,
  default_shard_group: AUTHORITATIVE_GROUP,
  shard_indexes: { [ROUTING_KEY_INDEX]: { type: "range", columns: ["routing_key"] } },
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
          default_shard_group: ACTOR_DATA_GROUP,
          tables: Object.fromEntries(
            input.unshardedTables.map((table) => [table, { shard_group: AUTHORITATIVE_GROUP }]),
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

const KEY_SPACE = 2n ** 64n

const bound = (hex: string | null | undefined, open: bigint) => {
  if (hex === undefined || hex === null || hex === "") return open
  if (!/^[0-9a-f]{1,16}$/i.test(hex)) throw new RangeError(`"${hex}" is not a hexadecimal prefix`)
  return BigInt(`0x${hex.padEnd(16, "0")}`)
}

const dataRanges = (topology: LiveTopology) =>
  (topology.shard_groups.find((group) => group.uid === ACTOR_DATA_GROUP)?.key_ranges ?? [])
    .map((range) => ({
      shard: range.shard_uid,
      from: bound(range.start, 0n),
      to: bound(range.end, KEY_SPACE),
    }))
    .sort((left, right) => (left.from < right.from ? -1 : 1))

/** The data shards a topology routes `routing_key` to, in key order. */
export const dataShardsOf = (topology: LiveTopology) =>
  dataRanges(topology).map((range) => range.shard)

/**
 * What a topology places and where, as a string two topologies can be compared by:
 * the authoritative shard, the data ranges as numeric bounds so `40` and
 * `4000000000000000` are the same bound, and the schema's table bindings. Group
 * names and sections this module does not generate do not take part. The active
 * shard index and cluster/schema defaults detect changes in routing semantics.
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
