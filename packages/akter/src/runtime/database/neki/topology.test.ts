import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { shardMapOf } from "./topology.ts"

const topology = ({
  ranges,
  tables = { actor_outbox: "actor_data", actor_receipts: "actor_data" },
  index = { type: "range", columns: ["routing_key"] },
  schemaDefault = "authoritative",
}: {
  readonly ranges: ReadonlyArray<{ shard_uid: string; start?: string; end?: string }>
  readonly tables?: Record<string, string>
  readonly index?: { type: string; columns: ReadonlyArray<string> }
  readonly schemaDefault?: string
}) =>
  JSON.stringify({
    authoritative_shard_group: "authoritative",
    default_shard_group: "authoritative",
    shard_indexes: { routing_key_range: index },
    shard_groups: [
      { uid: "authoritative", key_ranges: [{ shard_uid: "sh-auth" }] },
      { uid: "actor_data", default_shard_index: "routing_key_range", key_ranges: ranges },
    ],
    databases: {
      app: {
        schemas: {
          public: {
            default_shard_group: schemaDefault,
            tables: Object.fromEntries(
              Object.entries(tables).map(([name, group]) => [name, { shard_group: group }]),
            ),
          },
        },
      },
      other: { schemas: { public: { default_shard_group: "actor_data", tables: {} } } },
    },
  })

const parse = (input: Parameters<typeof topology>[0], database = "app") =>
  shardMapOf({ topology: topology(input), database, schema: "public" })

const map = (input: Parameters<typeof topology>[0], database = "app") =>
  Effect.runSync(parse(input, database))

const refusal = (input: Parameters<typeof topology>[0]) => {
  const exit = Effect.runSyncExit(parse(input))

  return Exit.isFailure(exit) ? String(exit.cause) : undefined
}

describe("Neki shard map", () => {
  it("maps one data shard to the whole bucket space, and names the authority", () => {
    const found = map({ ranges: [{ shard_uid: "sh-auth" }] })
    expect(found.ranges).toEqual([{ first: -128, last: 127, shard: "sh-auth" }])
    expect(found.placement.authoritative).toBe("sh-auth")
    expect(found.placement.routes("actor_outbox")).toBe(true)
    expect(found.placement.routes("cloud_meter_seal")).toBe(false)
  })

  it("reads a bucket-expression bound of 80 as negative buckets on the first shard and the rest on the second", () => {
    expect(
      map({
        ranges: [
          { shard_uid: "sh2", end: "80" },
          { shard_uid: "sh3", start: "80" },
        ],
        index: { type: "range", columns: ["(routing_key >> 56) + 128"] },
      }).ranges,
    ).toEqual([
      { first: -128, last: -1, shard: "sh2" },
      { first: 0, last: 127, shard: "sh3" },
    ])
  })

  it("orders three bucket-expression shards by signed bucket", () => {
    expect(
      map({
        ranges: [
          { shard_uid: "a", end: "40" },
          { shard_uid: "b", start: "40", end: "c0" },
          { shard_uid: "c", start: "c0" },
        ],
        index: { type: "range", columns: ["(routing_key>>56)+128"] },
      }).ranges,
    ).toEqual([
      { first: -128, last: -65, shard: "a" },
      { first: -64, last: 63, shard: "b" },
      { first: 64, last: 127, shard: "c" },
    ])
  })

  it("reads a routing_key bound as a key value, so 2^62 starts bucket 64 and every negative key stays on the first shard", () => {
    expect(
      map({
        ranges: [
          { shard_uid: "a", end: "4000000000000000" },
          { shard_uid: "b", start: "4000000000000000" },
        ],
      }).ranges,
    ).toEqual([
      { first: -128, last: 63, shard: "a" },
      { first: 64, last: 127, shard: "b" },
    ])
  })

  it("keeps one untargeted range when the schema routes no table, while another database routes everything", () => {
    const found = map({ ranges: [{ shard_uid: "sh-auth" }], tables: {} })
    expect(found.ranges).toEqual([{ first: -128, last: 127 }])
    expect(found.placement.routes("actor_outbox")).toBe(false)
    expect(map({ ranges: [{ shard_uid: "x" }], tables: {} }, "other").ranges).toEqual([
      { first: -128, last: 127, shard: "x" },
    ])
  })

  it("routes every unlisted table when the schema's default group is the routed one", () => {
    const found = map({
      ranges: [{ shard_uid: "sh-auth" }],
      tables: {},
      schemaDefault: "actor_data",
    })
    expect(found.ranges).toEqual([{ first: -128, last: 127, shard: "sh-auth" }])
    expect(found.placement.routes("anything")).toBe(true)
  })

  it.each([
    {
      name: "a routing_key bound of 80, which splits bucket 0 at key 128",
      ranges: [
        { shard_uid: "a", end: "80" },
        { shard_uid: "b", start: "80" },
      ],
    },
    {
      name: "a gap",
      ranges: [
        { shard_uid: "a", end: "1000000000000000" },
        { shard_uid: "b", start: "2000000000000000" },
      ],
    },
    {
      name: "an overlap",
      ranges: [
        { shard_uid: "a", end: "2000000000000000" },
        { shard_uid: "b", start: "1000000000000000" },
      ],
    },
    {
      name: "a bound that is not hexadecimal",
      ranges: [
        { shard_uid: "a", end: "zz" },
        { shard_uid: "b", start: "zz" },
      ],
    },
    { name: "a shard UID that needs quoting", ranges: [{ shard_uid: "a b" }] },
  ])("refuses $name", ({ ranges }) => {
    expect(refusal({ ranges })).toBeDefined()
  })

  it("refuses a routed group whose index is not a range on routing_key alone", () => {
    for (const index of [
      { type: "hash", columns: ["routing_key"] },
      { type: "range", columns: ["tenant_id"] },
      { type: "range", columns: ["(routing_key >> 48) + 128"] },
    ])
      expect(refusal({ ranges: [{ shard_uid: "a" }], index })).toContain("routing_key")
  })
})
