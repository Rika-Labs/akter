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
  const tier = yield* pricing.tier(plan).pipe(Effect.orDie)
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
  const estimate = yield* pricing
    .estimate(plan, { commands: weighted, storageGbMonths })
    .pipe(Effect.orDie)
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

export const currentPeriod = Effect.map(DateTime.now, (now) => DateTime.formatIso(now).slice(0, 7))
