import { Schema } from "effect"

import { PlanId, UnboundPlan } from "./identity.ts"
import {
  ActorReference,
  BillingPeriod,
  CalendarDay,
  Email,
  EnvironmentId,
  InvoiceId,
  NonNegative,
  NonNegativeInt,
  ProjectId,
  Timestamp,
} from "./primitives.ts"

/**
 * The plan of an organization with a billing account, tagged `known` like the
 * organization's `KnownPlan`, so `Plan | UnboundPlan` is a tagged union.
 */
export const Plan = Schema.TaggedStruct("known", {
  id: PlanId,
  name: Schema.String,
  basePriceCents: NonNegativeInt,
  currency: Schema.Literal("usd"),
  renewsAt: Schema.NullOr(Timestamp),
  monthToDateEstimateCents: NonNegativeInt,
  provisional: Schema.optionalKey(Schema.Boolean),
  subscribedId: Schema.optionalKey(PlanId),
  paymentStatus: Schema.optionalKey(
    Schema.Literals(["free", "active", "past_due", "unpaid", "canceled", "incomplete"]),
  ),
})
export type Plan = typeof Plan.Type

/** A card on file. */
export const CardPaymentMethod = Schema.TaggedStruct("card", {
  brand: Schema.String,
  lastFour: Schema.String,
  expiryMonth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
  expiryYear: NonNegativeInt,
})

/**
 * A Link account on file. Stripe reports only the account's email, which is null when Link holds
 * none, and nothing about the card behind it.
 */
export const LinkPaymentMethod = Schema.TaggedStruct("link", {
  email: Schema.NullOr(Schema.String),
})

export const PaymentMethod = Schema.Union([CardPaymentMethod, LinkPaymentMethod])
export type PaymentMethod = typeof PaymentMethod.Type

export const SpendLimit = Schema.Struct({
  limitCents: Schema.NullOr(NonNegativeInt),
  currentSpendCents: NonNegativeInt,
})
export type SpendLimit = typeof SpendLimit.Type

const capFields = {
  limit: Schema.NullOr(NonNegative),
  used: NonNegative,
  atCap: Schema.Boolean,
  refusing: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Literal("unbound")),
}

/**
 * One cap as the edge's admission decides it now, whatever period is being
 * reported, discriminated by `cap`. `limit` is null when the cap does not
 * apply. `atCap` means usage has reached the limit; `refusing` means the edge
 * would refuse the next new command, or for `connections` the next new
 * connection. `reason` is `unbound` when the edge refuses everything because
 * the organization has no billing account; such caps have no limit.
 *
 * For `commands`, `limit` and `used` are usage units, the same units as
 * `QuotaExceeded`'s `limitUnits` and `usedUnits`: a read weighs one unit and a
 * command `unitsPerCommand` units, which this cap always carries and no other
 * does, so commands are `used / unitsPerCommand`. They are cents for `spend`,
 * open connections for `connections`, and compute unit-hours used in the
 * current billing period for `compute`.
 *
 * `storage` is deprecated: the server no longer reports it, and it stays
 * decodable only so clients reading older responses keep working. It was the
 * largest latest sample of a serving deployment's tenant.
 */
export const CapState = Schema.Union([
  Schema.Struct({
    cap: Schema.Literal("commands"),
    ...capFields,
    unitsPerCommand: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    cap: Schema.Literals(["spend", "connections", "compute", "storage"]),
    ...capFields,
  }),
])
export type CapState = typeof CapState.Type

/**
 * `plan` is `unbound` when the organization has no billing account: it has no
 * plan, price or allowances, and is never reported as Free. Its spend limit is
 * then null and its current spend zero, since the edge admits nothing for it.
 */
export const BillingSummary = Schema.Struct({
  plan: Schema.Union([Plan, UnboundPlan]),
  paymentMethod: Schema.NullOr(PaymentMethod),
  billingEmail: Schema.NullOr(Email),
  spendLimit: SpendLimit,
  caps: Schema.optionalKey(Schema.Array(CapState)),
})
export type BillingSummary = typeof BillingSummary.Type

export const SetSpendLimit = Schema.Struct({ limitCents: Schema.NullOr(NonNegativeInt) })
export type SetSpendLimit = typeof SetSpendLimit.Type

export const Invoice = Schema.Struct({
  id: InvoiceId,
  number: Schema.String,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  amountCents: NonNegativeInt,
  currency: Schema.Literal("usd"),
  status: Schema.Literals(["draft", "open", "paid", "void", "uncollectible"]),
  pdfUrl: Schema.NullOr(Schema.String),
})
export type Invoice = typeof Invoice.Type

/** The paid plan to move to; the server builds the checkout and return URLs. */
export const StartCheckout = Schema.Struct({ plan: Schema.Literals(["pro", "team", "enterprise"]) })
export type StartCheckout = typeof StartCheckout.Type

/** A plan change on the existing subscription; payment confirmation can leave it pending. */
export const PlanChange = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literals(["pending", "completed", "failed"]),
})
export type PlanChange = typeof PlanChange.Type

/** A hosted Stripe page the browser should navigate to. */
export const HostedSession = Schema.Struct({ url: Schema.String })
export type HostedSession = typeof HostedSession.Type

/**
 * What a plan offers, derived from the pricing configuration: a hard command
 * cap, billed command overage, billed compute overage, a hard compute cap,
 * and a paid subscription bought through checkout.
 *
 * `storage-overage` and `storage-cap` are deprecated: the server no longer
 * reports them, and they stay decodable only for older responses.
 */
export const PlanFeature = Schema.Literals([
  "command-cap",
  "command-overage",
  "compute-overage",
  "compute-cap",
  "storage-overage",
  "storage-cap",
  "checkout",
])
export type PlanFeature = typeof PlanFeature.Type

/**
 * One tier of the pricing configuration. `allowances.commands` is the
 * included command equivalents and `allowances.commandCap` its hard stop
 * (null when overage is billed instead). `allowances.computeUnitHours` is the
 * included compute unit-hours and `allowances.computeUnitHourCap` its hard
 * stop (null when overage is billed instead at
 * `overage.computeCentsPerUnitHour`). A compute unit-hour is one hour of a
 * shared CPU with 256 MiB of memory; see `ComputeUsage`. A provisional tier's
 * prices are not yet published.
 *
 * `allowances.storageGb` and `overage.storageCentsPerGbMonth` are deprecated
 * and optional: the server no longer reports them, and they stay decodable
 * only for older responses.
 */
export const CatalogPlan = Schema.Struct({
  id: PlanId,
  name: Schema.String,
  basePriceCents: NonNegativeInt,
  currency: Schema.Literal("usd"),
  allowances: Schema.Struct({
    commands: NonNegativeInt,
    commandCap: Schema.NullOr(NonNegativeInt),
    computeUnitHours: NonNegative,
    computeUnitHourCap: Schema.NullOr(NonNegative),
    storageGb: Schema.optionalKey(NonNegative),
    concurrentConnections: NonNegativeInt,
  }),
  overage: Schema.Struct({
    commandCentsPerMillion: NonNegative,
    computeCentsPerUnitHour: NonNegative,
    storageCentsPerGbMonth: Schema.optionalKey(NonNegative),
  }),
  features: Schema.Array(PlanFeature),
  provisional: Schema.Boolean,
})
export type CatalogPlan = typeof CatalogPlan.Type

/** Every plan, cheapest first; `provisional` is true while any plan's prices are provisional. */
export const PlanCatalog = Schema.Struct({
  plans: Schema.Array(CatalogPlan),
  readCommandWeight: NonNegative,
  provisional: Schema.Boolean,
})
export type PlanCatalog = typeof PlanCatalog.Type

/**
 * `runnerHours` is measured in compute unit-hours (see `ComputeUsage`), not
 * machine hours; raw machine hours are reported per machine size in
 * `ComputeUsage.machineHours`. `egressGb` is outbound traffic in decimal
 * gigabytes. `storageGb` is deprecated: the server no longer reports it, and
 * it stays decodable only for older responses.
 */
export const UsageMeterName = Schema.Literals([
  "commands",
  "reads",
  "runnerHours",
  "storageGb",
  "egressGb",
])
export type UsageMeterName = typeof UsageMeterName.Type

export const UsageMeter = Schema.Struct({
  meter: UsageMeterName,
  used: NonNegative,
  included: NonNegative,
  overage: NonNegative,
  overageCostCents: NonNegative,
})
export type UsageMeter = typeof UsageMeter.Type

/**
 * The published rules usage is priced by, sent with every usage report.
 * `computeCentsPerUnitHour` prices compute unit-hours beyond the plan's
 * allowance. `storagePerGbCents` is deprecated and optional: the server no
 * longer reports it, and it stays decodable only for older responses.
 */
export const UsagePricing = Schema.Struct({
  freeCommands: NonNegativeInt,
  readCommandWeight: NonNegative,
  computeCentsPerUnitHour: NonNegative,
  storagePerGbCents: Schema.optionalKey(NonNegative),
  provisional: Schema.optionalKey(Schema.Boolean),
})
export type UsagePricing = typeof UsagePricing.Type

/**
 * Compute used by one machine size in one environment during the period.
 * `computeUnitHours` normalizes `machineHours` to a baseline of one shared CPU
 * with 256 MiB of memory: each machine hour weighs
 * `max(cpus * (cpuKind === "performance" ? 4 : 1), memoryMb / 256)` units, so
 * a shared 1 CPU, 1024 MiB machine weighs 4 and a performance 2 CPU, 4096 MiB
 * machine weighs 16. A record whose `computeUnitHours` disagrees with that
 * weight beyond floating-point rounding is refused, so machine hours cannot
 * be reported as unit-hours.
 */
export const ComputeUsage = Schema.Struct({
  environmentId: EnvironmentId,
  cpuKind: Schema.Literals(["shared", "performance"]),
  cpus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  memoryMb: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  machineHours: NonNegative,
  computeUnitHours: NonNegative,
}).check(
  Schema.makeFilter((usage) => {
    const weight = Math.max(
      usage.cpus * (usage.cpuKind === "performance" ? 4 : 1),
      usage.memoryMb / 256,
    )
    const expected = usage.machineHours * weight
    return (
      Math.abs(usage.computeUnitHours - expected) <= 1e-9 * Math.max(1, expected) ||
      "computeUnitHours must equal machineHours times the machine size's unit weight"
    )
  }),
)
export type ComputeUsage = typeof ComputeUsage.Type

/**
 * The organization's latest storage sample: the sum of every tenant's latest
 * sampled logical bytes, and the newest hour among those samples. Deprecated:
 * the server no longer reports it, and it stays decodable only for older
 * responses.
 */
export const StorageSample = Schema.Struct({ bytes: NonNegative, sampledAt: Timestamp })
export type StorageSample = typeof StorageSample.Type

/**
 * `caps` describe now whatever `period` is reported. A project's
 * `computeUnitHours` is its compute for the period and `compute` breaks it
 * down by environment and machine size; both are omitted when the server
 * does not meter compute for the project.
 *
 * `latestStorageSample` and a project's `storageGbMonths` are deprecated: the
 * server no longer reports them, and they stay decodable only for older
 * responses.
 */
export const Usage = Schema.Struct({
  period: BillingPeriod,
  meters: Schema.Array(UsageMeter),
  latestStorageSample: Schema.optionalKey(Schema.NullOr(StorageSample)),
  caps: Schema.optionalKey(Schema.Array(CapState)),
  commandsPerDay: Schema.Array(Schema.Struct({ day: CalendarDay, commands: NonNegativeInt })),
  byProject: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: Schema.String,
      commands: NonNegativeInt,
      reads: Schema.optionalKey(NonNegativeInt),
      computeUnitHours: Schema.optionalKey(NonNegative),
      compute: Schema.optionalKey(Schema.Array(ComputeUsage)),
      storageGbMonths: Schema.optionalKey(NonNegative),
      estimatedCostCents: NonNegative,
    }),
  ),
  pricing: UsagePricing,
})
export type Usage = typeof Usage.Type

export const AuditEntry = Schema.Struct({
  id: Schema.String,
  at: Timestamp,
  actor: ActorReference,
  action: Schema.String,
  target: Schema.Struct({
    type: Schema.String,
    id: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
  }),
  ipAddress: Schema.NullOr(Schema.String),
})
export type AuditEntry = typeof AuditEntry.Type
