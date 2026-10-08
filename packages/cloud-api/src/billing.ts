import { Schema } from "effect"

import { PlanId, UnboundPlan } from "./identity.ts"
import {
  ActorReference,
  BillingPeriod,
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
 * connection, or for `storage` that the organization's managed databases are
 * read-only: writes fail and reads still work. `reason` is `unbound` when the
 * edge refuses everything because the organization has no billing account;
 * such caps have no limit.
 *
 * `limit` and `used` are cents for `spend`, open connections for
 * `connections`, compute unit-hours used in the current billing period for
 * `compute`, and decimal gigabytes for `storage`: the organization's pooled
 * managed database storage, where `used` is the latest pooled sample. A
 * database the customer brings never counts toward it.
 */
export const CapState = Schema.Struct({
  cap: Schema.Literals(["spend", "connections", "compute", "storage"]),
  ...capFields,
})
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

const machineSizeFields = {
  cpuKind: Schema.Literals(["shared", "performance"]),
  cpus: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  memoryMb: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}

/**
 * What a plan offers, derived from the pricing configuration: billed compute
 * overage, a hard compute cap, billed storage overage, a hard storage cap, a
 * database the customer brings, a dedicated database, and a paid subscription
 * bought through checkout.
 */
export const PlanFeature = Schema.Literals([
  "compute-overage",
  "compute-cap",
  "storage-overage",
  "storage-cap",
  "byo-database",
  "dedicated-database",
  "checkout",
])
export type PlanFeature = typeof PlanFeature.Type

/**
 * One tier of the pricing configuration. `allowances.computeUnitHours` is the
 * included compute unit-hours and `allowances.computeUnitHourCap` its hard
 * stop (null when overage is billed instead at
 * `overage.computeCentsPerUnitHour`). A machine size's hour bills the compute
 * unit-hours `PlanCatalog.computeSizes` gives it.
 *
 * `allowances.storageGb` is the managed database storage included in the
 * plan, in decimal gigabytes, pooled across the organization's managed
 * environment databases. `allowances.storageGbCap` is its hard stop, past
 * which those databases are read-only, and is null when overage is billed
 * instead at `overage.storageCentsPerGbMonth`. A provisional tier's prices
 * are not yet published.
 */
export const CatalogPlan = Schema.Struct({
  id: PlanId,
  name: Schema.String,
  basePriceCents: NonNegativeInt,
  currency: Schema.Literal("usd"),
  allowances: Schema.Struct({
    computeUnitHours: NonNegative,
    computeUnitHourCap: Schema.NullOr(NonNegative),
    storageGb: NonNegative,
    storageGbCap: Schema.NullOr(NonNegative),
    concurrentConnections: NonNegativeInt,
  }),
  overage: Schema.Struct({
    computeCentsPerUnitHour: NonNegative,
    storageCentsPerGbMonth: NonNegative,
  }),
  features: Schema.Array(PlanFeature),
  provisional: Schema.Boolean,
})
export type CatalogPlan = typeof CatalogPlan.Type

/**
 * One machine size's weight in compute units: an hour of the size bills
 * `unitsPerHour` compute unit-hours. The weights come from the pricing
 * configuration.
 */
export const ComputeSize = Schema.Struct({
  ...machineSizeFields,
  unitsPerHour: Schema.Finite.check(Schema.isGreaterThan(0)),
})
export type ComputeSize = typeof ComputeSize.Type

/**
 * Every plan, cheapest first; `provisional` is true while any plan's prices
 * are provisional. `computeSizes` lists the compute unit weight of every
 * machine size the platform runs.
 */
export const PlanCatalog = Schema.Struct({
  plans: Schema.Array(CatalogPlan),
  computeSizes: Schema.Array(ComputeSize),
  provisional: Schema.Boolean,
})
export type PlanCatalog = typeof PlanCatalog.Type

/**
 * `runnerHours` is measured in compute unit-hours (see `ComputeUsage`), not
 * machine hours; raw machine hours are reported per machine size in
 * `ComputeUsage.machineHours`. `storageGb` is the average pooled managed
 * database storage over the period in decimal gigabytes, billed per GB-month.
 */
export const UsageMeterName = Schema.Literals(["runnerHours", "storageGb"])
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
 * allowance and `storageCentsPerGbMonth` prices managed database storage
 * beyond it; each is 0 where the plan bills no overage.
 */
export const UsagePricing = Schema.Struct({
  computeCentsPerUnitHour: NonNegative,
  storageCentsPerGbMonth: NonNegative,
  provisional: Schema.optionalKey(Schema.Boolean),
})
export type UsagePricing = typeof UsagePricing.Type

/**
 * Compute used by one machine size in one environment during the period:
 * `machineHours` raw machine hours, billed as `computeUnitHours` at the
 * size's `ComputeSize.unitsPerHour` in the plan catalog.
 */
export const ComputeUsage = Schema.Struct({
  environmentId: EnvironmentId,
  ...machineSizeFields,
  machineHours: NonNegative,
  computeUnitHours: NonNegative,
})
export type ComputeUsage = typeof ComputeUsage.Type

/**
 * The organization's latest pooled managed database storage: the sum of the
 * sampled bytes of its managed environment databases, and when it was
 * sampled. A database the customer brings is excluded.
 */
export const StorageSample = Schema.Struct({ bytes: NonNegative, sampledAt: Timestamp })
export type StorageSample = typeof StorageSample.Type

/**
 * `caps` describe now whatever `period` is reported. A project's
 * `computeUnitHours` is its compute for the period and `compute` breaks it
 * down by environment and machine size; its `storageGbMonths` is its managed
 * databases' storage for the period.
 */
export const Usage = Schema.Struct({
  period: BillingPeriod,
  meters: Schema.Array(UsageMeter),
  latestStorageSample: Schema.NullOr(StorageSample),
  caps: Schema.Array(CapState),
  byProject: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: Schema.String,
      computeUnitHours: NonNegative,
      compute: Schema.Array(ComputeUsage),
      storageGbMonths: NonNegative,
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
