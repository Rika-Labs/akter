import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  ACTOR_DATA_GROUP,
  AUTHORITATIVE_GROUP,
  bucketHex,
  checkRoutedTables,
  dataShardsOf,
  dataTopology,
  LiveTopology,
  keyRanges,
  placementOf,
  ROUTABLE_TABLES,
  ROUTING_BUCKET,
  ROUTING_KEY_INDEX,
  shardBucketSpans,
  type KeyRange,
} from "./topology.ts"

const SPAN = 2n ** 56n
const SHARD_COUNTS = [1, 2, 3, 4, 5, 7, 8, 10, 16, 31, 64, 100, 128, 200, 255, 256]

const bucketKey = (bucket: number, offset: bigint) => BigInt(bucket) * SPAN + offset

const buckets = Array.from({ length: 256 }, (_, index) => index - 128)

const sampleKeys = buckets.flatMap((bucket) => [
  bucketKey(bucket, 0n),
  bucketKey(bucket, 12345n),
  bucketKey(bucket, SPAN - 1n),
])

const shardNames = (count: number) => Array.from({ length: count }, (_, index) => `shard-${index}`)

const boundary = (hex: string) => BigInt(`0x${hex}`)

/**
 * Reads key ranges the way a live Neki router placed rows of a `range` index: the
 * index value compared as a signed integer, each bound a hexadecimal integer, start
 * inclusive, end exclusive, a missing start or end unbounded. The value is
 * `ROUTING_BUCKET`, the signed bucket moved to 0..255.
 */
const owners = (ranges: ReadonlyArray<KeyRange>, key: bigint) => {
  const routing = (key >> 56n) + 128n
  return ranges.flatMap((range) =>
    (range.start === undefined || routing >= boundary(range.start)) &&
    (range.end === undefined || routing < boundary(range.end))
      ? [range.shard_uid]
      : [],
  )
}

describe("routing key to bucket hex", () => {
  it("routes by the signed bucket moved to 0..255", () => {
    expect(ROUTING_BUCKET).toBe("(routing_key >> 56) + 128")
  })

  it("maps signed buckets to bounds in signed order", () => {
    expect([0, 1, 63, 64, 127, -128, -127, -64, -2, -1].map((bucket) => bucketHex(bucket))).toEqual(
      ["80", "81", "bf", "c0", "ff", "00", "01", "40", "7e", "7f"],
    )
  })

  it("agrees with the routed value of every sampled key", () => {
    for (const key of [
      ...sampleKeys,
      -(2n ** 63n),
      2n ** 63n - 1n,
      0n,
      -1n,
      1n,
      -SPAN,
      SPAN - 1n,
      -SPAN - 1n,
    ]) {
      const routed = ((key >> 56n) + 128n).toString(16).padStart(2, "0")
      expect(bucketHex(Number(key >> 56n))).toBe(routed)
    }
  })

  it("rejects a mapping that prints the signed value or reads the two's-complement top byte", () => {
    expect(bucketHex(-1)).not.toContain("-")
    expect(bucketHex(-1)).not.toBe("ff")
    expect(bucketHex(-128)).not.toBe("80")
    expect(bucketHex(0)).not.toBe("00")
    expect(bucketHex(127)).not.toBe("7f")
  })

  it("rejects values that are not buckets", () => {
    expect(() => bucketHex(128)).toThrow(RangeError)
    expect(() => bucketHex(-129)).toThrow(RangeError)
    expect(() => bucketHex(1.5)).toThrow(RangeError)
  })
})

describe("key ranges", () => {
  it("cover the whole routing-key space with exactly one owner for every shard count", () => {
    for (const count of SHARD_COUNTS) {
      const names = shardNames(count)
      const ranges = keyRanges(names)
      for (const key of sampleKeys) {
        const found = owners(ranges, key)
        expect(found).toHaveLength(1)
        expect(names).toContain(found[0])
      }
    }
  })

  it("start unbounded, end unbounded and join end to start without a gap or overlap", () => {
    for (const count of SHARD_COUNTS) {
      const ranges = keyRanges(shardNames(count))
      expect(ranges[0]?.start).toBeUndefined()
      expect(ranges[count - 1]?.end).toBeUndefined()
      const edges = ranges.flatMap((range) => [range.start, range.end])
      const inner = edges.slice(1, -1)
      expect(inner).toHaveLength(2 * (count - 1))
      for (let index = 0; index < count - 1; index++) {
        expect(ranges[index]?.end).toBe(ranges[index + 1]?.start)
        expect(ranges[index]?.end).toMatch(/^[0-9a-f]{2}$/)
      }
      const starts = ranges.slice(1).map((range) => boundary(range.start ?? ""))
      expect(starts).toEqual([...starts].sort((a, b) => (a < b ? -1 : 1)))
      expect(new Set(starts).size).toBe(count - 1)
    }
  })

  it("gives a boundary bucket to the range that starts there and its predecessor to the one before", () => {
    const ranges = keyRanges(["a", "b", "c", "d"])
    expect(ranges.map((range) => [range.start, range.end])).toEqual([
      [undefined, "40"],
      ["40", "80"],
      ["80", "c0"],
      ["c0", undefined],
    ])
    expect(owners(ranges, bucketKey(-128, 0n))).toEqual(["a"])
    expect(owners(ranges, bucketKey(-65, SPAN - 1n))).toEqual(["a"])
    expect(owners(ranges, bucketKey(-64, 0n))).toEqual(["b"])
    expect(owners(ranges, bucketKey(-1, SPAN - 1n))).toEqual(["b"])
    expect(owners(ranges, bucketKey(0, 0n))).toEqual(["c"])
    expect(owners(ranges, bucketKey(63, SPAN - 1n))).toEqual(["c"])
    expect(owners(ranges, bucketKey(64, 0n))).toEqual(["d"])
    expect(owners(ranges, bucketKey(127, SPAN - 1n))).toEqual(["d"])
  })

  it("puts the negative half of the signed key space on the first shard, as the live router did", () => {
    const ranges = keyRanges(["low", "high"])
    expect(owners(ranges, -(2n ** 63n))).toEqual(["low"])
    expect(owners(ranges, -1n)).toEqual(["low"])
    expect(owners(ranges, 0n)).toEqual(["high"])
    expect(owners(ranges, 127n)).toEqual(["high"])
    expect(owners(ranges, 128n)).toEqual(["high"])
    expect(owners(ranges, 2n ** 63n - 1n)).toEqual(["high"])
  })

  it("splits 256 buckets into whole buckets that differ by at most one", () => {
    expect(keyRanges(["a", "b", "c"]).map((range) => [range.start, range.end])).toEqual([
      [undefined, "55"],
      ["55", "aa"],
      ["aa", undefined],
    ])
    for (const count of SHARD_COUNTS) {
      const names = shardNames(count)
      const ranges = keyRanges(names)
      const owned = buckets.flatMap((bucket) => owners(ranges, bucketKey(bucket, 0n)))
      const sizes = names.map((name) => owned.filter((owner) => owner === name).length)
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(256)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1)
    }
  })

  it("rejects shard counts that cannot align to buckets", () => {
    expect(() => keyRanges([])).toThrow(RangeError)
    expect(() => keyRanges(shardNames(257))).toThrow(RangeError)
  })
})

describe("bucket spans", () => {
  it("lists one contiguous run of signed buckets per shard", () => {
    expect(shardBucketSpans(2)).toEqual([
      { first: -128, last: -1 },
      { first: 0, last: 127 },
    ])
    expect(shardBucketSpans(3)).toEqual([
      { first: -128, last: -44 },
      { first: -43, last: 41 },
      { first: 42, last: 127 },
    ])
  })

  it("match the owner of every bucket in the generated key ranges", () => {
    for (const count of SHARD_COUNTS) {
      const names = shardNames(count)
      const ranges = keyRanges(names)
      const spans = shardBucketSpans(count)
      const claimed = spans.flatMap((span, shard) =>
        Array.from({ length: span.last - span.first + 1 }, (_, index) => {
          const bucket = span.first + index
          expect(owners(ranges, bucketKey(bucket, 0n))).toEqual([names[shard]])
          expect(owners(ranges, bucketKey(bucket, SPAN - 1n))).toEqual([names[shard]])
          return bucket
        }),
      )
      expect([...claimed].sort((a, b) => a - b)).toEqual(buckets)
    }
  })
})

describe("routable tables", () => {
  it("are the 18 framework per-actor tables", () => {
    expect(ROUTABLE_TABLES).toHaveLength(18)
    expect(ROUTABLE_TABLES.every((table) => /^(actor|tenant)_/.test(table))).toBe(true)
    expect(() => checkRoutedTables(ROUTABLE_TABLES)).not.toThrow()
    expect(() => checkRoutedTables([])).not.toThrow()
  })

  it("refuse an owned table with a trigger, a control table and a registry", () => {
    for (const table of [
      "cloud_billing_state",
      "cloud_meter_evidence",
      "tenant_directory",
      "deployment",
      "actor_placements",
    ])
      expect(() => checkRoutedTables(["actor_state", table])).toThrow(table)
  })
})

describe("data topology", () => {
  const scope = { database: "postgres", schema: "public" }
  const input = {
    authoritativeShard: "meta",
    dataShards: ["s1", "s2", "s3"],
    ...scope,
    routedTables: [],
  }
  it("starts unsharded with the authoritative shard also holding the data", () => {
    const topology = dataTopology({ ...input, dataShards: ["meta"] })
    expect(topology.shard_groups).toEqual([
      { uid: AUTHORITATIVE_GROUP, key_ranges: [{ shard_uid: "meta" }] },
      {
        uid: ACTOR_DATA_GROUP,
        default_shard_index: ROUTING_KEY_INDEX,
        key_ranges: [{ shard_uid: "meta" }],
      },
    ])
  })

  it("keeps the authoritative group standalone and the default for the schema and the cluster", () => {
    const topology = dataTopology(input)
    expect(topology.shard_indexes).toEqual({
      [ROUTING_KEY_INDEX]: { type: "range", columns: [ROUTING_BUCKET] },
    })
    const groups = topology.shard_groups
    expect(groups.find((group) => group.uid === AUTHORITATIVE_GROUP)?.key_ranges).toEqual([
      { shard_uid: "meta" },
    ])
    const data = groups.find((group) => group.uid === ACTOR_DATA_GROUP)
    expect(data?.default_shard_index).toBe(ROUTING_KEY_INDEX)
    expect(data?.key_ranges.map((range) => range.shard_uid)).toEqual(["s1", "s2", "s3"])
    expect(topology.default_shard_group).toBe(topology.authoritative_shard_group)
    expect(topology.databases).toEqual({
      postgres: { schemas: { public: { default_shard_group: AUTHORITATIVE_GROUP, tables: {} } } },
    })
  })

  it("routes only the listed tables by routing_key, leaving every other table authoritative", () => {
    const topology = dataTopology({
      ...input,
      routedTables: ["actor_outbox", "actor_state"],
    })
    expect(topology.databases.postgres?.schemas.public).toEqual({
      default_shard_group: AUTHORITATIVE_GROUP,
      tables: {
        actor_outbox: { shard_group: ACTOR_DATA_GROUP },
        actor_state: { shard_group: ACTOR_DATA_GROUP },
      },
    })
  })

  it("serialises to JSON a Neki router accepts: no null, no undefined bounds", () => {
    const topology = dataTopology(input)
    const text = JSON.stringify(topology)
    expect(text).not.toContain("null")
    expect(text).not.toContain("undefined")
    expect(JSON.parse(text)).toEqual(topology)
  })
})

describe("placement comparison", () => {
  const scope = { database: "postgres", schema: "public" }
  const live = (value: typeof LiveTopology.Encoded) =>
    Effect.runSync(Schema.decodeEffect(LiveTopology)(value))
  const place = placementOf(scope)
  const input = {
    authoritativeShard: "meta",
    dataShards: ["s1", "s2"],
    ...scope,
    routedTables: ["actor_outbox"],
  }
  it("treats the generated topology as the same placement after Neki echoes it back", () => {
    const generated = dataTopology(input)
    expect(place(live(JSON.parse(JSON.stringify(generated))))).toBe(place(generated))
  })

  it("compares bounds as integers, so leading zeros do not change a bound and trailing ones do", () => {
    const generated = dataTopology(input)
    const withBounds = (end: string, start: string) => ({
      ...generated,
      shard_groups: [
        ...generated.shard_groups.slice(0, 1),
        {
          uid: ACTOR_DATA_GROUP,
          default_shard_index: ROUTING_KEY_INDEX,
          key_ranges: [
            { shard_uid: "s1", start: null, end },
            { shard_uid: "s2", start, end: "" },
          ],
        },
      ],
    })
    expect(place(live(withBounds("0080", "080")))).toBe(place(generated))
    expect(place(live(withBounds("8000", "8000")))).not.toBe(place(generated))
  })

  it("detects a moved boundary, a swapped shard, another authoritative shard and a rebound table", () => {
    const base = place(dataTopology(input))
    const moved = dataTopology({ ...input, dataShards: ["s1", "s2", "s3"] })
    const swapped = dataTopology({ ...input, dataShards: ["s2", "s1"] })
    const elsewhere = dataTopology({ ...input, authoritativeShard: "other" })
    const rebound = dataTopology({ ...input, routedTables: [] })
    for (const topology of [moved, swapped, elsewhere, rebound])
      expect(place(topology)).not.toBe(base)
  })

  it("reads the data shards in key order whatever order Neki lists them", () => {
    const generated = dataTopology({ ...input, dataShards: ["s1", "s2", "s3"] })
    const reordered = {
      ...generated,
      shard_groups: [
        ...generated.shard_groups.slice(0, 1),
        {
          uid: ACTOR_DATA_GROUP,
          default_shard_index: ROUTING_KEY_INDEX,
          key_ranges: [...(generated.shard_groups[1]?.key_ranges ?? [])].reverse(),
        },
      ],
    }
    expect(dataShardsOf(live(reordered))).toEqual(["s1", "s2", "s3"])
    expect(place(live(reordered))).toBe(place(generated))
  })

  it("detects a changed shard-index algorithm, column, or default group even with identical ranges", () => {
    const generated = dataTopology(input)
    const baseline = place(generated)
    const hashIndex = {
      ...generated,
      shard_indexes: { [ROUTING_KEY_INDEX]: { type: "xxhash", columns: ["routing_key"] } },
    }
    const wrongColumn = {
      ...generated,
      shard_indexes: { [ROUTING_KEY_INDEX]: { type: "range", columns: ["actor_id"] } },
    }
    const wrongDefault = { ...generated, default_shard_group: ACTOR_DATA_GROUP }
    for (const changed of [hashIndex, wrongColumn, wrongDefault])
      expect(place(live(changed))).not.toBe(baseline)
  })

  it("rejects a document that is not a topology and a bound that is not hexadecimal", () => {
    expect(
      Effect.runSyncExit(Schema.decodeUnknownEffect(LiveTopology)({ shard_groups: "none" }))._tag,
    ).toBe("Failure")
    const bad = live({
      authoritative_shard_group: "a",
      shard_groups: [{ uid: ACTOR_DATA_GROUP, key_ranges: [{ shard_uid: "s", start: "zz" }] }],
    })
    expect(() => place(bad)).toThrow(RangeError)
  })
})
