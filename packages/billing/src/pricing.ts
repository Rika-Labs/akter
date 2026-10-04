import { Context, Effect, Layer, Schema } from "effect"

import type { Tier } from "./contract.ts"

export type PlanId = "free" | "pro" | "team" | "enterprise"

/**
 * What one plan includes and charges. Prices of paid plans are provisional
 * until launch pricing is confirmed. `commandQuota` is a hard stop on the
 * commands a plan may run in a period; paid plans have none and bill overage
 * instead. A customer's own spend limit is separate and never part of a tier.
 */
export interface PricingTier {
  readonly id: PlanId
  readonly name: string
  readonly basePriceCents: number
  readonly includedCommands: number
  readonly commandQuota: number | null
  readonly commandOverageCentsPerMillion: number
  readonly includedStorageGb: number
  readonly storageCentsPerGbMonth: number
  readonly concurrentConnections: number
  readonly provisional: boolean
}

export interface PricingConfig {
  readonly tiers: ReadonlyArray<PricingTier>
  readonly readCommandWeight: number
}

const Amount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Operator-configured prices retain the fixed one-fifth read unit and reject negative allowances or duplicate tiers. */
export const PricingConfigSchema = Schema.Struct({
  readCommandWeight: Schema.Literal(0.2),
  tiers: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(["free", "pro", "team", "enterprise"]),
      name: Schema.NonEmptyString,
      basePriceCents: Count,
      includedCommands: Count,
      commandQuota: Schema.NullOr(Count),
      commandOverageCentsPerMillion: Amount,
      includedStorageGb: Amount,
      storageCentsPerGbMonth: Amount,
      concurrentConnections: Count,
      provisional: Schema.Boolean,
    }),
  ).check(
    Schema.makeFilter(
      (tiers) => tiers.length === 4 && new Set(tiers.map((tier) => tier.id)).size === 4,
    ),
  ),
}).check(
  Schema.makeFilter((config) => {
    const free = config.tiers.find((tier) => tier.id === "free")
    return (
      free?.basePriceCents === 0 &&
      free.includedCommands === 1_000_000 &&
      free.commandQuota === 1_000_000 &&
      free.commandOverageCentsPerMillion === 0 &&
      free.includedStorageGb === 0.5 &&
      free.storageCentsPerGbMonth === 0 &&
      !free.provisional
    )
  }),
)

/** Usage over one period; `commands` is already weighted, see `Pricing.weightedCommands`. */
export interface UsageTotals {
  readonly commands: number
  readonly storageGbMonths: number
}

/** The cost of a period's usage as it actually accrued: never limited by any spend cap. */
export interface CostEstimate {
  readonly tierId: PlanId
  readonly provisional: boolean
  readonly baseCents: number
  readonly commandOverageCents: number
  readonly storageCents: number
  readonly totalCents: number
  readonly commandQuotaExceeded: boolean
}

export const COMMANDS_METER = "commands"
export const STORAGE_METER = "storageGb"

const MILLION = 1_000_000

export const defaultPricingConfig: PricingConfig & { readonly readCommandWeight: 0.2 } = {
  readCommandWeight: 0.2,
  tiers: [
    {
      id: "free",
      name: "Free",
      basePriceCents: 0,
      includedCommands: 1_000_000,
      commandQuota: 1_000_000,
      commandOverageCentsPerMillion: 0,
      includedStorageGb: 0.5,
      storageCentsPerGbMonth: 0,
      concurrentConnections: 100,
      provisional: false,
    },
    {
      id: "pro",
      name: "Pro",
      basePriceCents: 2_500,
      includedCommands: 25_000_000,
      commandQuota: null,
      commandOverageCentsPerMillion: 100,
      includedStorageGb: 10,
      storageCentsPerGbMonth: 30,
      concurrentConnections: 5_000,
      provisional: true,
    },
    {
      id: "team",
      name: "Team",
      basePriceCents: 24_900,
      includedCommands: 300_000_000,
      commandQuota: null,
      commandOverageCentsPerMillion: 60,
      includedStorageGb: 100,
      storageCentsPerGbMonth: 30,
      concurrentConnections: 50_000,
      provisional: true,
    },
    {
      id: "enterprise",
      name: "Enterprise",
      basePriceCents: 250_000,
      includedCommands: 5_000_000_000,
      commandQuota: null,
      commandOverageCentsPerMillion: 50,
      includedStorageGb: 1_000,
      storageCentsPerGbMonth: 30,
      concurrentConnections: 100_000,
      provisional: true,
    },
  ],
}

/** The plan is not in the pricing configuration. */
export class UnknownPlan extends Schema.TaggedError<UnknownPlan>()("UnknownPlan", {
  tierId: Schema.String,
}) {}

/** Rounds up to a whole cent after absorbing floating-point noise from fractional inputs. */
const ceilCents = (cents: number): number => Math.ceil(Math.round(cents * 1e6) / 1e6)

const overage = (used: number, included: number): number => Math.max(0, used - included)

export class Pricing extends Context.Service<
  Pricing,
  {
    readonly config: PricingConfig
    readonly tier: (tierId: string) => Effect.Effect<PricingTier, UnknownPlan>
    readonly weightedCommands: (commands: number, reads: number) => number
    readonly estimate: (
      tierId: string,
      usage: UsageTotals,
    ) => Effect.Effect<CostEstimate, UnknownPlan>
  }
>()("@akter/billing/pricing") {}

export const PricingLive = (config: PricingConfig = defaultPricingConfig) => {
  const tier = (tierId: string): Effect.Effect<PricingTier, UnknownPlan> => {
    const found = config.tiers.find((candidate) => candidate.id === tierId)
    return found === undefined ? Effect.fail(UnknownPlan.make({ tierId })) : Effect.succeed(found)
  }

  return Layer.succeed(
    Pricing,
    Pricing.of({
      config,
      tier,
      weightedCommands: (commands, reads) => commands + reads * config.readCommandWeight,
      estimate: (tierId, usage) =>
        Effect.map(tier(tierId), (found) => {
          const commandOverageCents = ceilCents(
            (overage(usage.commands, found.includedCommands) / MILLION) *
              found.commandOverageCentsPerMillion,
          )
          const storageCents = ceilCents(
            overage(usage.storageGbMonths, found.includedStorageGb) * found.storageCentsPerGbMonth,
          )
          return {
            tierId: found.id,
            provisional: found.provisional,
            baseCents: found.basePriceCents,
            commandOverageCents,
            storageCents,
            totalCents: found.basePriceCents + commandOverageCents + storageCents,
            commandQuotaExceeded:
              found.commandQuota !== null && usage.commands > found.commandQuota,
          }
        }),
    }),
  )
}

/**
 * The Stripe catalog for a pricing configuration: the sold plans (those with a
 * base price; the free plan has no subscription) with their usage prices.
 * Allowances are expressed in the prices themselves, as graduated tiers whose
 * first tier is the included amount at no charge, so meter events carry gross
 * usage and are never reduced by the allowance.
 */
export const stripeTiers = (config: PricingConfig): ReadonlyArray<Tier> =>
  config.tiers
    .filter((tier) => tier.basePriceCents > 0)
    .map((tier) => ({
      id: tier.id,
      name: tier.name,
      basePriceCents: tier.basePriceCents,
      currency: "usd",
      usage: [
        {
          meter: COMMANDS_METER,
          displayName: "Commands",
          unitAmountDecimal: String(tier.commandOverageCentsPerMillion / MILLION),
          includedUnits: tier.includedCommands,
        },
        {
          meter: STORAGE_METER,
          displayName: "Storage (GB-months)",
          unitAmountDecimal: String(tier.storageCentsPerGbMonth),
          includedUnits: tier.includedStorageGb,
        },
      ],
    }))
