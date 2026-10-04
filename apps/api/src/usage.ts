import { Pricing } from "@akter/billing"
import * as Cloud from "@akter/cloud-api"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"

interface ProjectUsage {
  readonly project_id: string
  readonly name: string
  readonly commands: string
  readonly reads: string
  readonly storage_byte_hours: number
}

/** The UTC month's actual duration, so February does not buy thirty-one days of storage. */
export const hoursInMonth = (period: string) => {
  const start = DateTime.makeUnsafe(`${period}-01T00:00:00.000Z`)
  const end = DateTime.add(start, { months: 1 })
  return (DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 3_600_000
}

/** Organization-wide allowances are applied once, before cost is attributed to projects. */
export const usageReport = Effect.fn("Billing.usage")(function* (
  organizationId: string,
  plan: string,
  period: string,
) {
  const sql = yield* SqlClient.SqlClient
  const pricing = yield* Pricing
  const tier = yield* pricing.tier(plan)
  const start = DateTime.makeUnsafe(`${period}-01T00:00:00.000Z`)
  const from = DateTime.formatIso(start)
  const until = DateTime.formatIso(DateTime.add(start, { months: 1 }))
  const projects = yield* sql<ProjectUsage>`
    SELECT h.project_id, COALESCE(p.name, 'Deleted project') AS name,
      sum(h.command_count)::text AS commands, sum(h.read_count)::text AS reads,
      sum(h.storage_byte_hours)::double precision AS storage_byte_hours
    FROM cloud_usage_hour h
    LEFT JOIN cloud_project p ON p.id = h.project_id AND p.organization_id = h.organization_id
    WHERE h.organization_id = ${organizationId}
      AND h.hour >= ${from}::timestamptz
      AND h.hour < ${until}::timestamptz
    GROUP BY h.project_id, p.name ORDER BY h.project_id
  `.pipe(Effect.orDie)
  const days = yield* sql<{ readonly day: string; readonly commands: string }>`
    SELECT to_char(hour AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
      sum(command_count)::text AS commands
    FROM cloud_usage_hour WHERE organization_id = ${organizationId}
      AND hour >= ${from}::timestamptz
      AND hour < ${until}::timestamptz
    GROUP BY day ORDER BY day
  `.pipe(Effect.orDie)
  const commands = projects.reduce((total, project) => total + Number(project.commands), 0)
  const reads = projects.reduce((total, project) => total + Number(project.reads), 0)
  const byteHours = projects.reduce((total, project) => total + project.storage_byte_hours, 0)
  const storageGbMonths = byteHours / 1_000_000_000 / hoursInMonth(period)
  const weighted = pricing.weightedCommands(commands, reads)
  const estimate = yield* pricing.estimate(plan, { commands: weighted, storageGbMonths })
  let allocated = 0
  const variableCents = estimate.commandOverageCents + estimate.storageCents
  const byProject = projects.map((project, index) => {
    const projectWeighted = pricing.weightedCommands(
      Number(project.commands),
      Number(project.reads),
    )
    const share =
      (weighted === 0 ? 0 : (projectWeighted / weighted) * estimate.commandOverageCents) +
      (byteHours === 0 ? 0 : (project.storage_byte_hours / byteHours) * estimate.storageCents)
    const cost = index === projects.length - 1 ? variableCents - allocated : Math.floor(share)
    allocated += cost
    return {
      projectId: project.project_id,
      name: project.name,
      commands: Number(project.commands),
      reads: Number(project.reads),
      storageGbMonths: project.storage_byte_hours / 1_000_000_000 / hoursInMonth(period),
      estimatedCostCents: cost,
    }
  })
  return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.Usage))({
    period,
    meters: [
      {
        meter: "commands",
        used: weighted,
        included: tier.includedCommands,
        overage: Math.max(0, weighted - tier.includedCommands),
        overageCostCents: estimate.commandOverageCents,
      },
      {
        meter: "reads",
        used: reads,
        included: Math.max(0, tier.includedCommands - commands) * 5,
        overage: Math.max(0, reads - Math.max(0, tier.includedCommands - commands) * 5),
        overageCostCents: 0,
      },
      {
        meter: "storageGb",
        used: storageGbMonths,
        included: tier.includedStorageGb,
        overage: Math.max(0, storageGbMonths - tier.includedStorageGb),
        overageCostCents: estimate.storageCents,
      },
    ],
    commandsPerDay: days.map(({ day, commands }) => ({ day, commands: Number(commands) })),
    byProject,
    pricing: {
      freeCommands:
        pricing.config.tiers.find((configured) => configured.id === "free")?.includedCommands ?? 0,
      readCommandWeight: pricing.config.readCommandWeight,
      storagePerGbCents: tier.storageCentsPerGbMonth,
      provisional: tier.provisional,
    },
  }).pipe(Effect.orDie)
})

/**
 * The organization's latest storage: the latest sample of each bound tenant
 * of a serving deployment, summed, at the newest of their hours, or null
 * before any was sampled. A drained deployment's last sample is left out, so
 * a redeploy never counts the same data twice. A tenant is bound by its exact
 * mapping, else its deployment's `'*'` mapping, as metering binds it.
 */
export const latestStorageSample = Effect.fn("Billing.latestStorageSample")(function* (
  organizationId: string,
) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ readonly bytes: number | null; readonly sampledAt: Date | null }>`
    SELECT sum(s.logical_bytes)::float8 AS bytes, max(s.hour) AS "sampledAt"
    FROM cloud_meter_storage_sample s
    JOIN deployment d ON d.id = s.deployment_id AND d.serving
    WHERE (SELECT m.organization_id FROM cloud_meter_tenant m
      WHERE m.deployment_id = s.deployment_id AND m.tenant IN (s.tenant, '*')
      ORDER BY (m.tenant = '*') LIMIT 1) = ${organizationId}
  `.pipe(Effect.orDie)
  return row?.bytes == null || row.sampledAt === null
    ? null
    : { bytes: row.bytes, sampledAt: DateTime.fromDateUnsafe(row.sampledAt) }
})

export const currentPeriod = Effect.map(DateTime.now, (now) => DateTime.formatIso(now).slice(0, 7))
