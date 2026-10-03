import type { ProjectRegion } from "@akter/cloud-api"
import { formatCompact, formatInteger } from "@akter/ui/geometry"
import { DateTime } from "effect"
import { databaseCpuLimit } from "../overview/mapping.ts"
import { ago } from "../overview/time.ts"
import { RegionsPage } from "./model.ts"

const gigabyte = 1_000_000_000

/** A byte count as the console writes sizes: `512 B`, `41 KB`, `38 MB`, `41 GB`, decimal units. */
export const formatBytes = (bytes: number): string => {
  const units = [
    [gigabyte * 1000, "TB"],
    [gigabyte, "GB"],
    [1_000_000, "MB"],
    [1000, "KB"],
  ] as const
  const unit = units.find(([size]) => bytes >= size)
  if (unit === undefined) return `${formatInteger(bytes)} B`
  const scaled = bytes / unit[0]
  return `${scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/u, "")} ${unit[1]}`
}

/**
 * Whether a region looks healthy: its database CPU is under the shared limit and neither its
 * connections nor its storage are exhausted. The API reports no health verdict of its own.
 */
export const regionHealthy = (region: ProjectRegion): boolean =>
  region.cpuPercent < databaseCpuLimit &&
  region.connections.used < region.connections.limit &&
  region.storage.usedBytes < region.storage.limitBytes

const backups = (now: DateTime.Utc, region: ProjectRegion): string => {
  const mode = region.backups.pointInTimeRecovery ? "Point-in-time" : "Point-in-time off"
  return region.backups.latestBackupAt === null
    ? `${mode} · no backup yet`
    : `${mode} · latest ${ago(now)(region.backups.latestBackupAt)} ago`
}

/** The environment's regions and their largest tables, biggest first, as the console's page. */
export const toRegionsPage =
  (now: DateTime.Utc) =>
  (regions: ReadonlyArray<ProjectRegion>): RegionsPage =>
    RegionsPage.make({
      regions: regions.map((region) => ({
        id: region.region.id,
        place: region.region.city,
        primary: region.home,
        healthy: regionHealthy(region),
        tenants: region.tenantCount,
        database: `${region.database.engine} ${region.database.version}`,
        storageUsed: region.storage.usedBytes / gigabyte,
        storageLimit: region.storage.limitBytes / gigabyte,
        cpu: `${String(Math.round(region.cpuPercent))}%`,
        connections: `${formatInteger(region.connections.used)} of ${formatInteger(region.connections.limit)}`,
        runners: `${formatInteger(region.runners)} · shard group ${region.shardGroup}`,
        backups: backups(now, region),
      })),
      tables: regions
        .flatMap((region) => region.largestTables)
        .sort((left, right) => right.sizeBytes - left.sizeBytes)
        .map((table) => ({
          name: table.name,
          actorType: table.actor,
          rows: formatCompact(table.rows),
          size: formatBytes(table.sizeBytes),
          region: table.region,
        })),
    })
