import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { Pricing, type PricingTier, type UnknownPlan } from "./pricing.ts"

/** Usage units one command weighs; a read weighs one. */
export const COMMAND_UNITS = 5

/** Usage units one read weighs. */
export const READ_UNITS = 1

/** A Free tenant's storage cap in decimal bytes; no other tier caps storage at admission. */
export const storageLimitBytes = (tier: PricingTier): number | null =>
  tier.id === "free" ? tier.includedStorageGb * 1_000_000_000 : null

/** The usage units a tier admits in a period, or `null` when it bills overage instead. */
export const commandLimitUnits = (tier: PricingTier): number | null =>
  tier.commandQuota === null ? null : tier.commandQuota * COMMAND_UNITS

/**
 * A new command is refused while a tenant's latest sample is at or over its
 * tier's storage cap. A tenant with no sample is admitted, because no evidence
 * says it is over.
 */
export const refusesStorage = (input: {
  readonly tier: PricingTier
  readonly sampledBytes: number | undefined
}): boolean => {
  const limit = storageLimitBytes(input.tier)
  return limit !== null && input.sampledBytes !== undefined && input.sampledBytes >= limit
}

/** Committed plus reserved units, with the request's own, must stay within the tier's period quota. */
export const refusesUnits = (input: {
  readonly tier: PricingTier
  readonly usedUnits: number
  readonly requestedUnits: number
}): boolean => {
  const limit = commandLimitUnits(input.tier)
  return limit !== null && input.usedUnits + input.requestedUnits > limit
}

/** A new connection is refused once the organization holds every connection its tier allows. */
export const refusesConnection = (input: {
  readonly tier: PricingTier
  readonly open: number
}): boolean => input.open >= input.tier.concurrentConnections

/**
 * The period's cost if `units` were committed, priced on the subscribed plan
 * so a downgraded entitlement never hides a paid base from the spend cap.
 */
export const projectedSpendCents = (input: {
  readonly subscribedPlan: string
  readonly units: number
  readonly storageGbMonths: number
}): Effect.Effect<number, UnknownPlan, Pricing> =>
  Pricing.use((pricing) =>
    pricing.estimate(input.subscribedPlan, {
      commands: input.units / COMMAND_UNITS,
      storageGbMonths: input.storageGbMonths,
    }),
  ).pipe(Effect.map((estimate) => estimate.totalCents))

/** A new admission is refused when the projected cost would pass a set spend limit. */
export const refusesSpend = (input: {
  readonly limitCents: number | null
  readonly projectedCents: number
}): boolean => input.limitCents !== null && input.projectedCents > input.limitCents

/** The four caps edge admission enforces. */
export type CapName = "commands" | "spend" | "connections" | "storage"

/**
 * One cap as edge admission sees it now. `limit` and `used` are units for
 * `commands`, cents for `spend`, open connections for `connections` and the
 * largest latest sampled bytes of a serving deployment's tenant for
 * `storage`; `limit` is `null` when the cap does not apply. `atCap` means
 * usage has reached the limit, and `refusing` that the edge would refuse the
 * next new command (for `connections`, the next new connection). `reason` is
 * `unbound` when the edge refuses every metered request regardless of usage,
 * because the organization has no billing account. The `commands` cap, and
 * only it, carries `unitsPerCommand` so a reader converts its units to
 * commands without knowing the weights.
 */
export type CapState =
  | (CapFields & { readonly cap: "commands"; readonly unitsPerCommand: number })
  | (CapFields & { readonly cap: Exclude<CapName, "commands"> })

interface CapFields {
  readonly limit: number | null
  readonly used: number
  readonly atCap: boolean
  readonly refusing: boolean
  readonly reason?: "unbound"
}

/** What edge admission reads about an organization in its current period. */
export interface AdmissionUsage {
  readonly tier: PricingTier
  readonly subscribedPlan: string
  readonly spendLimitCents: number | null
  readonly usedUnits: number
  readonly storageGbMonths: number
  readonly openConnections: number
  readonly largestSampleBytes: number | undefined
}

/** Each cap's state under the same predicates edge admission refuses by. */
export const capStates = Effect.fnUntraced(function* (usage: AdmissionUsage) {
  const units = commandLimitUnits(usage.tier)
  const storage = storageLimitBytes(usage.tier)
  const spent = yield* projectedSpendCents({ ...usage, units: usage.usedUnits })
  const next = yield* projectedSpendCents({ ...usage, units: usage.usedUnits + COMMAND_UNITS })

  return [
    {
      cap: "commands",
      limit: units,
      used: usage.usedUnits,
      atCap: units !== null && usage.usedUnits >= units,
      refusing: refusesUnits({ ...usage, requestedUnits: COMMAND_UNITS }),
      unitsPerCommand: COMMAND_UNITS,
    },
    {
      cap: "spend",
      limit: usage.spendLimitCents,
      used: spent,
      atCap: usage.spendLimitCents !== null && spent >= usage.spendLimitCents,
      refusing: refusesSpend({ limitCents: usage.spendLimitCents, projectedCents: next }),
    },
    {
      cap: "connections",
      limit: usage.tier.concurrentConnections,
      used: usage.openConnections,
      atCap: refusesConnection({ tier: usage.tier, open: usage.openConnections }),
      refusing: refusesConnection({ tier: usage.tier, open: usage.openConnections }),
    },
    {
      cap: "storage",
      limit: storage,
      used: usage.largestSampleBytes ?? 0,
      atCap: refusesStorage({ tier: usage.tier, sampledBytes: usage.largestSampleBytes }),
      refusing: refusesStorage({ tier: usage.tier, sampledBytes: usage.largestSampleBytes }),
    },
  ] satisfies ReadonlyArray<CapState>
})

/**
 * An organization's caps as edge admission would decide them now, read from
 * the same control-plane rows the edge reads: the billing account, the
 * current UTC period's committed and reserved units by the database clock,
 * the live connection leases, and the latest storage sample of each tenant of
 * a serving deployment bound to the organization. The edge checks storage
 * per deployment and tenant, so the largest of those samples decides it, and
 * a drained deployment's last sample no longer counts. An organization with
 * no billing account is refused everything by the edge, so every cap reports
 * `refusing` with reason `unbound` and no limit. A plan the pricing
 * configuration does not know fails with `UnknownPlan`, as the edge refuses
 * it. The read takes no locks, so it reports the state at one snapshot
 * rather than reserving anything.
 */
export const organizationCaps = Effect.fnUntraced(function* (organizationId: string) {
  const sql = yield* SqlClient.SqlClient
  const pricing = yield* Pricing

  const [row] = yield* sql<{
    readonly plan: string | null
    readonly subscribedPlan: string | null
    readonly spendLimitCents: number | null
    readonly usedUnits: number | null
    readonly storageGbMonths: number | null
    readonly openConnections: number
    readonly largestSampleBytes: number | null
  }>`
    SELECT b.plan, b.subscribed_plan AS "subscribedPlan",
      b.spend_limit_cents::float8 AS "spendLimitCents",
      (u.command_units + u.reserved_units)::float8 AS "usedUnits",
      u.storage_gb_months AS "storageGbMonths",
      (SELECT count(*)::int FROM cloud_connection_lease l
        WHERE l.organization_id = ${organizationId} AND l.expires_at > now()) AS "openConnections",
      (SELECT max(s.logical_bytes) FROM cloud_meter_storage_sample s
        JOIN deployment d ON d.id = s.deployment_id AND d.serving
        WHERE (SELECT m.organization_id FROM cloud_meter_tenant m
          WHERE m.deployment_id = s.deployment_id AND m.tenant IN (s.tenant, '*')
          ORDER BY (m.tenant = '*') LIMIT 1) = ${organizationId}) AS "largestSampleBytes"
    FROM (SELECT 1) AS one
    LEFT JOIN cloud_billing_account b ON b.organization_id = ${organizationId}
    LEFT JOIN cloud_usage_account u ON u.organization_id = ${organizationId}
      AND u.period = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM')
  `

  const usedUnits = row?.usedUnits ?? 0
  const openConnections = row?.openConnections ?? 0
  const largestSampleBytes = row?.largestSampleBytes ?? undefined

  if (row?.plan == null || row.subscribedPlan == null) {
    const unbound = (used: number) =>
      ({ limit: null, used, atCap: false, refusing: true, reason: "unbound" }) as const

    return [
      { cap: "commands", ...unbound(usedUnits), unitsPerCommand: COMMAND_UNITS },
      { cap: "spend", ...unbound(0) },
      { cap: "connections", ...unbound(openConnections) },
      { cap: "storage", ...unbound(largestSampleBytes ?? 0) },
    ] satisfies ReadonlyArray<CapState>
  }

  return yield* capStates({
    tier: yield* pricing.tier(row.plan),
    subscribedPlan: row.subscribedPlan,
    spendLimitCents: row.spendLimitCents,
    usedUnits,
    storageGbMonths: row.storageGbMonths ?? 0,
    openConnections,
    largestSampleBytes,
  })
})
