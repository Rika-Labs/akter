import { ProjectRegion } from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { formatBytes, regionHealthy, toRegionsPage } from "./mapping.ts"

const decode = <T, E>(schema: Schema.Codec<T, E>, input: Schema.Json) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(JSON.stringify(input))

const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z")

const region = (fields: Record<string, Schema.Json>) => ({
  region: { id: "us-east-1", city: "Virginia" },
  home: true,
  tenantCount: 1204,
  database: { engine: "Neki Postgres", version: "18", sizeBytes: 212_000_000_000 },
  storage: { usedBytes: 212_000_000_000, limitBytes: 500_000_000_000 },
  cpuPercent: 41.4,
  connections: { used: 180, limit: 400 },
  runners: 3,
  shardGroup: "default",
  backups: { pointInTimeRecovery: true, latestBackupAt: "2026-10-03T09:00:00.000Z" },
  largestTables: [
    {
      name: "cart_items",
      actor: "Cart",
      rows: 6_200_000,
      sizeBytes: 38_000_000_000,
      region: "us-east-1",
    },
  ],
  ...fields,
})

describe("regions mapping", () => {
  it("writes a region's facts in the units the page shows", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const east = yield* decode(ProjectRegion, region({}))
        const page = toRegionsPage(now)([east])
        expect(page.regions).toEqual([
          {
            id: "us-east-1",
            place: "Virginia",
            primary: true,
            healthy: true,
            tenants: 1204,
            database: "Neki Postgres 18",
            storageUsed: 212,
            storageLimit: 500,
            cpu: "41%",
            connections: "180 of 400",
            runners: "3 · shard group default",
            backups: "Point-in-time · latest 3h ago",
          },
        ])
      }),
    ))

  it("merges the largest tables of every region, biggest first", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const east = yield* decode(ProjectRegion, region({}))
        const west = yield* decode(
          ProjectRegion,
          region({
            region: { id: "us-west-2", city: "Oregon" },
            home: false,
            backups: { pointInTimeRecovery: false, latestBackupAt: null },
            largestTables: [
              {
                name: "receipts",
                actor: "",
                rows: 9_400_000,
                sizeBytes: 12_000_000_000,
                region: "us-west-2",
              },
              {
                name: "transcript",
                actor: "AgentSession",
                rows: 880_000,
                sizeBytes: 41_000_000_000,
                region: "us-west-2",
              },
            ],
          }),
        )
        const page = toRegionsPage(now)([east, west])
        expect(
          page.tables.map((table) => [table.name, table.rows, table.size, table.region]),
        ).toEqual([
          ["transcript", "880K", "41 GB", "us-west-2"],
          ["cart_items", "6.2M", "38 GB", "us-east-1"],
          ["receipts", "9.4M", "12 GB", "us-west-2"],
        ])
        expect(page.regions[1]).toMatchObject({
          primary: false,
          backups: "Point-in-time off · no backup yet",
        })
      }),
    ))

  it("flags a region whose CPU, connections or storage is at its limit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const healthy = (fields: Record<string, Schema.Json>) =>
          decode(ProjectRegion, region(fields)).pipe(Effect.map(regionHealthy))
        expect(yield* healthy({ cpuPercent: 84.9 })).toBe(true)
        expect(yield* healthy({ cpuPercent: 85 })).toBe(false)
        expect(yield* healthy({ connections: { used: 400, limit: 400 } })).toBe(false)
        expect(
          yield* healthy({ storage: { usedBytes: 500_000_000_000, limitBytes: 500_000_000_000 } }),
        ).toBe(false)
      }),
    ))
})

describe("byte sizes", () => {
  it("uses decimal units and keeps one decimal only below ten", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(41_000)).toBe("41 KB")
    expect(formatBytes(1_500_000)).toBe("1.5 MB")
    expect(formatBytes(2_000_000_000)).toBe("2 GB")
    expect(formatBytes(41_400_000_000)).toBe("41 GB")
    expect(formatBytes(3_000_000_000_000)).toBe("3 TB")
  })
})
