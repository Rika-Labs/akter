import { Schema } from "effect"

import { PlanId, UnboundPlan } from "./identity.ts"
import {
  ActorReference,
  BillingPeriod,
  CalendarDay,
  Email,
  InvoiceId,
  NonNegative,
  NonNegativeInt,
  ProjectId,
  Timestamp,
} from "./primitives.ts"

export const Plan = Schema.Struct({
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

export const PaymentMethod = Schema.Struct({
  brand: Schema.String,
  lastFour: Schema.String,
  expiryMonth: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 12 }))),
  expiryYear: NonNegativeInt,
})
export type PaymentMethod = typeof PaymentMethod.Type

export const SpendLimit = Schema.Struct({
  limitCents: Schema.NullOr(NonNegativeInt),
  currentSpendCents: NonNegativeInt,
})
export type SpendLimit = typeof SpendLimit.Type

/**
 * One cap as the edge's admission decides it now, whatever period is being
 * reported. `limit` and `used` are usage units for `commands`, the same units
 * as `QuotaExceeded`'s `limitUnits` and `usedUnits`; a read weighs one unit and
 * a command `unitsPerCommand` units, which the `commands` cap always carries
 * and no other cap does, so commands are `used / unitsPerCommand`. They are
 * cents for `spend`, open connections for
 * `connections`, and for `storage` the largest latest sample of a serving
 * deployment's tenant, since storage is capped per deployment and tenant;
 * `limit` is null when the cap does not apply. `atCap` means usage has
 * reached the limit; `refusing` means the edge would refuse the next new
 * command, or for `connections` the next new connection. `reason` is
 * `unbound` when the edge refuses everything because the organization has no
 * billing account; such caps have no limit.
 */
export const CapState = Schema.Struct({
  cap: Schema.Literals(["commands", "spend", "connections", "storage"]),
  limit: Schema.NullOr(NonNegative),
  used: NonNegative,
  atCap: Schema.Boolean,
  refusing: Schema.Boolean,
  reason: Schema.optionalKey(Schema.Literal("unbound")),
  unitsPerCommand: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
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

/**
 * What a plan offers, derived from the pricing configuration: a hard command
 * cap, billed command overage, billed storage overage, a storage admission
 * cap, and a paid subscription bought through checkout.
 */
export const PlanFeature = Schema.Literals([
  "command-cap",
  "command-overage",
  "storage-overage",
  "storage-cap",
  "checkout",
])
export type PlanFeature = typeof PlanFeature.Type

/**
 * One tier of the pricing configuration. `allowances.commands` is the
 * included command equivalents, `allowances.commandCap` the hard stop (null
 * when overage is billed instead) and `allowances.storageGb` decimal
 * gigabytes. A provisional tier's prices are not yet published.
 */
export const CatalogPlan = Schema.Struct({
  id: PlanId,
  name: Schema.String,
  basePriceCents: NonNegativeInt,
  currency: Schema.Literal("usd"),
  allowances: Schema.Struct({
    commands: NonNegativeInt,
    commandCap: Schema.NullOr(NonNegativeInt),
    storageGb: NonNegative,
    concurrentConnections: NonNegativeInt,
  }),
  overage: Schema.Struct({
    commandCentsPerMillion: NonNegative,
    storageCentsPerGbMonth: NonNegative,
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

/** The published rules usage is priced by, sent with every usage report. */
export const UsagePricing = Schema.Struct({
  freeCommands: NonNegativeInt,
  readCommandWeight: NonNegative,
  storagePerGbCents: NonNegative,
  provisional: Schema.optionalKey(Schema.Boolean),
})
export type UsagePricing = typeof UsagePricing.Type

/**
 * The organization's latest storage sample: the sum of every tenant's latest
 * sampled logical bytes, and the newest hour among those samples.
 */
export const StorageSample = Schema.Struct({ bytes: NonNegative, sampledAt: Timestamp })
export type StorageSample = typeof StorageSample.Type

/**
 * `latestStorageSample` and `caps` describe now whatever `period` is
 * reported; the sample is null before any tenant was sampled.
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
