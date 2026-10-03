import { Schema } from "effect"

import { PlanId } from "./identity.ts"
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

export const BillingSummary = Schema.Struct({
  plan: Plan,
  paymentMethod: Schema.NullOr(PaymentMethod),
  billingEmail: Schema.NullOr(Email),
  spendLimit: SpendLimit,
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
export const StartCheckout = Schema.Struct({ plan: Schema.Literals(["pro", "enterprise"]) })
export type StartCheckout = typeof StartCheckout.Type

/** A hosted Stripe page the browser should navigate to. */
export const HostedSession = Schema.Struct({ url: Schema.String })
export type HostedSession = typeof HostedSession.Type

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
})
export type UsagePricing = typeof UsagePricing.Type

export const Usage = Schema.Struct({
  period: BillingPeriod,
  meters: Schema.Array(UsageMeter),
  commandsPerDay: Schema.Array(Schema.Struct({ day: CalendarDay, commands: NonNegativeInt })),
  byProject: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: Schema.String,
      commands: NonNegativeInt,
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
