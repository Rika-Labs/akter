import { Context, DateTime, Effect, Redacted, Schema } from "effect"

/**
 * A usage-priced component of a tier, billed per unit of the named Stripe
 * meter. The first `includedUnits` units of each period are free.
 */
export interface UsagePrice {
  readonly meter: string
  readonly displayName: string
  readonly unitAmountDecimal: string
  readonly includedUnits?: number | undefined
}

/** A plan sold through checkout; `id` is the stable key every Stripe object derives its identity from. */
export interface Tier {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  readonly basePriceCents: number
  readonly currency: string
  readonly taxCode?: string | undefined
  readonly usage: ReadonlyArray<UsagePrice>
}

export interface CatalogMeter {
  readonly meter: string
  readonly meterId: string
  readonly priceId: string
}

export interface CatalogTier {
  readonly tierId: string
  readonly productId: string
  readonly basePriceId: string
  readonly usage: ReadonlyArray<CatalogMeter>
}

export interface Catalog {
  readonly tiers: ReadonlyArray<CatalogTier>
}

export interface CustomerInput {
  readonly organizationId: string
  readonly email: string
  readonly name?: string | undefined
}

export interface BillingCustomer {
  readonly customerId: string
}

/**
 * Starts a monthly subscription anchored to day 1 at 00:00:00 UTC. No base
 * proration is charged for the initial partial period; the first full monthly
 * base charge begins at the next boundary. This is not a trial, and gross
 * metered usage is still submitted against UTC calendar-month allowances.
 */
export interface CheckoutInput {
  readonly organizationId: string
  readonly customerId: string
  readonly tierId: string
  readonly successUrl: string
  readonly cancelUrl: string
  readonly idempotencyKey?: string | undefined
}

export interface PortalInput {
  readonly customerId: string
  readonly returnUrl: string
  readonly idempotencyKey?: string | undefined
}

/** Changes the managed prices on an existing subscription, never creating a second one. */
export interface ChangeSubscriptionInput {
  readonly customerId: string
  readonly subscriptionId: string
  readonly tierId: string
  readonly idempotencyKey: string
}

/** A hosted Stripe page the browser should navigate to. */
export interface HostedSession {
  readonly id: string
  readonly url: string
}

export interface BillingAddress {
  readonly line1: string | null
  readonly line2: string | null
  readonly city: string | null
  readonly state: string | null
  readonly postalCode: string | null
  readonly country: string | null
}

export interface TaxId {
  readonly type: string
  readonly value: string
}

export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused"

/** A subscription as the provider reports it now, reduced to what entitlements need. */
export interface Subscription {
  readonly subscriptionId: string
  readonly customerId: string
  readonly tierId: string
  readonly status: SubscriptionStatus
  readonly currentPeriodEnd: DateTime.Utc | null
  readonly cancelAtPeriodEnd: boolean
}

/** `subscription` is the customer's current one, or null when it has none; its `currentPeriodEnd` is the renewal date. */
export interface BillingDetails {
  readonly customerId: string
  readonly email: string | null
  readonly name: string | null
  readonly address: BillingAddress | null
  readonly taxIds: ReadonlyArray<TaxId>
  readonly subscription: Subscription | null
}

export interface PaymentMethod {
  readonly id: string
  readonly brand: string
  readonly lastFour: string
  readonly expiryMonth: number
  readonly expiryYear: number
}

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible"

export interface InvoiceRecord {
  readonly id: string
  readonly number: string | null
  readonly periodStart: DateTime.Utc
  readonly periodEnd: DateTime.Utc
  readonly amountCents: number
  readonly currency: string
  readonly status: InvoiceStatus
  readonly pdfUrl: string | null
  readonly hostedUrl: string | null
}

/**
 * One usage report for a meter. `key` names the occurrence being reported (a
 * period, a batch, a source row): the same meter, customer and key always
 * produce the same Stripe event identifier, so a replay is deduplicated.
 * `value` may be fractional. Stripe wire values have at most 15 significant
 * digits; fractional values are quantized deterministically to that limit,
 * while integer counts must be exact and within the limit. `occurredAt` must be within
 * the last 35 days and no more than a few minutes ahead.
 */
export interface UsageEvent {
  readonly meter: string
  readonly customerId: string
  readonly key: string
  readonly value: number
  readonly occurredAt: DateTime.Utc
}

/**
 * What a `recordUsage` call handed to the provider, in submission order and
 * with repeats removed. Hosted Stripe accepts meter events asynchronously and
 * validates them afterwards, so a receipt means "accepted for processing", not
 * "counted". It only deduplicates within Stripe's rolling 24 hours: replaying
 * the same identifier later counts again. The local provider remembers
 * identifiers permanently.
 */
export interface UsageReceipt {
  readonly identifiers: ReadonlyArray<string>
  readonly batches: number
}

export interface BillingEvent {
  readonly id: string
  readonly type: string
  readonly createdAt: DateTime.Utc
  readonly livemode: boolean
  readonly data: Schema.JsonObject
}

export type WebhookPayload = string | Uint8Array

/** The provider failed or rejected the request; `retryable` says whether repeating it can succeed. */
export class BillingProviderError extends Schema.TaggedError<BillingProviderError>()(
  "BillingProviderError",
  { operation: Schema.String, message: Schema.String, retryable: Schema.Boolean },
) {}

/** The tier is not part of the configured catalog. */
export class UnknownTier extends Schema.TaggedError<UnknownTier>()("UnknownTier", {
  tierId: Schema.String,
}) {}

/** The provider has no customer with this id. */
export class UnknownCustomer extends Schema.TaggedError<UnknownCustomer>()("UnknownCustomer", {
  customerId: Schema.String,
}) {}

/** The meter is not declared by any configured tier. */
export class UnknownMeter extends Schema.TaggedError<UnknownMeter>()("UnknownMeter", {
  meter: Schema.String,
}) {}

/** The provider has no such subscription for this customer; another customer's subscription is indistinguishable. */
export class UnknownSubscription extends Schema.TaggedError<UnknownSubscription>()(
  "UnknownSubscription",
  { subscriptionId: Schema.String },
) {}

/** The tier's prices do not exist yet; `ensureCatalog` must run first. */
export class CatalogNotReady extends Schema.TaggedError<CatalogNotReady>()("CatalogNotReady", {
  tierId: Schema.String,
}) {}

/**
 * The checkout this request identity already created has expired, so it can
 * never create a subscription. Replaying the identity would only return the
 * provider's cached dead session; a new checkout needs a new identity.
 */
export class CheckoutExpired extends Schema.TaggedError<CheckoutExpired>()("CheckoutExpired", {
  sessionId: Schema.String,
}) {}

/** The webhook body failed signature verification or is not a Stripe event. */
export class WebhookRejected extends Schema.TaggedError<WebhookRejected>()("WebhookRejected", {
  reason: Schema.String,
}) {}

export interface BillingConfig {
  readonly tiers: ReadonlyArray<Tier>
  readonly webhookSecret: Redacted.Redacted<string>
  readonly webhookToleranceSeconds?: number | undefined
}

export class StripeBilling extends Context.Service<
  StripeBilling,
  {
    readonly ensureCatalog: Effect.Effect<Catalog, BillingProviderError>
    readonly ensureCustomer: (
      input: CustomerInput,
    ) => Effect.Effect<BillingCustomer, BillingProviderError>
    readonly startCheckout: (
      input: CheckoutInput,
    ) => Effect.Effect<
      HostedSession,
      BillingProviderError | UnknownTier | UnknownCustomer | CatalogNotReady | CheckoutExpired
    >
    readonly openPortal: (
      input: PortalInput,
    ) => Effect.Effect<HostedSession, BillingProviderError | UnknownCustomer>
    /** The returned state is provider state, not permission to grant entitlements; reconcile it from the verified webhook. */
    readonly changeSubscription: (
      input: ChangeSubscriptionInput,
    ) => Effect.Effect<
      Subscription,
      BillingProviderError | UnknownSubscription | UnknownTier | CatalogNotReady
    >
    readonly reconcileSubscription: (
      customerId: string,
      subscriptionId: string,
    ) => Effect.Effect<Subscription, BillingProviderError | UnknownSubscription>
    readonly billingDetails: (
      customerId: string,
    ) => Effect.Effect<BillingDetails, BillingProviderError | UnknownCustomer>
    readonly paymentMethod: (
      customerId: string,
    ) => Effect.Effect<PaymentMethod | null, BillingProviderError | UnknownCustomer>
    readonly invoices: (
      customerId: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<InvoiceRecord>, BillingProviderError | UnknownCustomer>
    readonly recordUsage: (
      events: ReadonlyArray<UsageEvent>,
    ) => Effect.Effect<UsageReceipt, BillingProviderError | UnknownMeter>
    readonly verifyWebhook: (
      payload: WebhookPayload,
      signature: string | null,
    ) => Effect.Effect<BillingEvent, WebhookRejected>
  }
>()("@akter/billing/contract/StripeBilling") {}
