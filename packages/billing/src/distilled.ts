import * as Stripe from "@distilled.cloud/stripe"
import {
  Clock,
  type Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Ref,
} from "effect"
import type { HttpClient } from "effect/http"

import {
  BillingProviderError,
  type BillingConfig,
  type BillingDetails,
  type Catalog,
  CatalogNotReady,
  type CatalogMeter,
  type CatalogTier,
  type CheckoutInput,
  type ChangeSubscriptionInput,
  type CustomerInput,
  type InvoiceRecord,
  type InvoiceStatus,
  type PaymentMethod,
  type PortalInput,
  StripeBilling,
  type Subscription,
  type Tier,
  UnknownCustomer,
  UnknownSubscription,
  UnknownTier,
  type UsageEvent,
  type UsagePrice,
} from "./contract.ts"
import { planUsage, sha256Hex, usageValueText } from "./usage.ts"
import { verifyWebhook } from "./webhooks.ts"

const stripe = Stripe.Services.stripe

export const DEFAULT_METER_EVENTS_BASE_URL = "https://meter-events.stripe.com"

const SESSION_REFRESH_MARGIN_MILLIS = 60_000

const RETRYABLE_TAGS = new Set([
  "ApiError",
  "ExternalDependencyFailed",
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
  "Locked",
  "HttpClientError",
])

export interface DistilledBillingConfig extends BillingConfig {
  readonly meterEventsBaseUrl?: string | undefined
  readonly retry?: Stripe.Retry.Policy | undefined
}

interface MeterEventSession {
  readonly token: string
  readonly expiresAtMillis: number
}

const productId = (tier: Tier): string => `akter_${tier.id}`
const baseLookupKey = (tier: Tier): string => `akter_${tier.id}_base`
const usageLookupKey = (tier: Tier, usage: UsagePrice): string => `akter_${tier.id}_${usage.meter}`

const providerError = (operation: string, error: Stripe.StripeOpError): BillingProviderError =>
  BillingProviderError.make({
    operation,
    message: `Stripe ${error._tag}`,
    retryable: RETRYABLE_TAGS.has(error._tag),
  })

const isMissing = (error: Stripe.StripeOpError): boolean =>
  Predicate.isTagged(error, "NotFound") ||
  (Predicate.isTagged(error, "InvalidRequestError") && error.code === "resource_missing")

const customerFailure =
  (operation: string, customerId: string) =>
  (error: Stripe.StripeOpError): BillingProviderError | UnknownCustomer =>
    isMissing(error) ? UnknownCustomer.make({ customerId }) : providerError(operation, error)

const BASE_COMPONENT = "base"

const PORTAL_KEY = "akter_billing_management_v1"

const CURRENT_STATUSES: ReadonlySet<string> = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
])

const invoiceStatus = (status: string | null | undefined): InvoiceStatus => {
  switch (status) {
    case "open":
    case "paid":
    case "void":
    case "uncollectible":
      return status
    default:
      return "draft"
  }
}

/**
 * Stripe behind the `StripeBilling` service, through the Distilled client.
 * Nothing is remembered in process: Stripe is the authority for products,
 * prices, meters and customers, and every create is guarded by a lookup first
 * and an idempotency key second, so repeating any call, or racing two
 * processes, converges on the same objects. Meter events go through the
 * high-throughput stream with its own short-lived session token.
 */
export const StripeBillingDistilled = (config: DistilledBillingConfig) =>
  Layer.effect(
    StripeBilling,
    Effect.gen(function* () {
      const context = yield* Effect.context<
        Stripe.Credentials | HttpClient.HttpClient | Crypto.Crypto
      >()
      const session = yield* Ref.make<Option.Option<MeterEventSession>>(Option.none())
      const meterEventsBaseUrl = config.meterEventsBaseUrl ?? DEFAULT_METER_EVENTS_BASE_URL

      const request = <A>(
        effect: Effect.Effect<A, Stripe.StripeOpError, Stripe.StripeOpContext>,
        idempotencyKey?: string,
      ): Effect.Effect<A, Stripe.StripeOpError> =>
        effect.pipe(
          Stripe.withRequestOptions(idempotencyKey === undefined ? {} : { idempotencyKey }),
          Stripe.Retry.policy(config.retry ?? Stripe.Retry.makeDefault),
          Effect.provideContext(context),
        )

      const hash = (text: string) => sha256Hex(text).pipe(Effect.provideContext(context))

      const findTier = (tierId: string): Effect.Effect<Tier, UnknownTier> => {
        const tier = config.tiers.find((candidate) => candidate.id === tierId)
        return tier === undefined ? Effect.fail(UnknownTier.make({ tierId })) : Effect.succeed(tier)
      }

      const activeMeters = Effect.gen(function* () {
        const found = new Map<string, string>()
        let startingAfter: string | undefined
        for (;;) {
          const page = yield* request(
            stripe.GetBillingMeters({
              limit: 100,
              status: "active",
              starting_after: startingAfter,
            }),
          )
          for (const meter of page.data) found.set(meter.event_name, meter.id)
          const last = page.data.at(-1)
          if (!page.has_more || last === undefined) return found
          startingAfter = last.id
        }
      })

      const ensureMeter = (usage: UsagePrice, known: Map<string, string>) =>
        Effect.gen(function* () {
          const existing = known.get(usage.meter)
          if (existing !== undefined) return existing
          const created = yield* request(
            stripe.CreateBillingMeter({
              display_name: usage.displayName,
              event_name: usage.meter,
              default_aggregation: { formula: "sum" },
              customer_mapping: { event_payload_key: "stripe_customer_id", type: "by_id" },
              value_settings: { event_payload_key: "value" },
            }),
            `akter:meter:${usage.meter}`,
          )
          known.set(usage.meter, created.id)
          return created.id
        })

      const ensureProduct = (tier: Tier) =>
        request(stripe.GetProduct({ id: productId(tier) })).pipe(
          Effect.catchIf(isMissing, () =>
            request(
              stripe.CreateProduct({
                id: productId(tier),
                name: tier.name,
                description: tier.description,
                tax_code: tier.taxCode,
                metadata: { akter_tier: tier.id },
              }),
              `akter:product:${tier.id}`,
            ),
          ),
        )

      const ensurePrice = (
        lookupKey: string,
        tier: Tier,
        component: string,
        specification: string,
        body: Stripe.Services.stripe.CreatePriceRequest,
      ) =>
        Effect.gen(function* () {
          const fingerprint = yield* hash(`v1|${lookupKey}|${specification}`)
          const found = yield* request(
            stripe.GetPrices({ lookup_keys: [lookupKey], active: true, limit: 10 }),
          )
          const current = found.data.find(
            (price) => price.metadata.akter_fingerprint === fingerprint,
          )
          if (current !== undefined) return current.id
          const created = yield* request(
            stripe.CreatePrice(
              Object.assign({}, body, {
                lookup_key: lookupKey,
                transfer_lookup_key: true,
                metadata: {
                  akter_fingerprint: fingerprint,
                  akter_tier: tier.id,
                  akter_component: component,
                },
              }),
            ),
            `akter:price:${lookupKey}:${fingerprint}`,
          )
          return created.id
        })

      const usagePriceBody = (
        tier: Tier,
        usage: UsagePrice,
        meterId: string,
      ): Stripe.Services.stripe.CreatePriceRequest => {
        const included = Math.ceil(usage.includedUnits ?? 0)
        return {
          product: productId(tier),
          currency: tier.currency,
          nickname: usage.displayName,
          tax_behavior: "exclusive",
          recurring: { interval: "month", usage_type: "metered", meter: meterId },
          ...(included > 0
            ? {
                billing_scheme: "tiered",
                tiers_mode: "graduated",
                tiers: [
                  { up_to: included, unit_amount: 0 },
                  { up_to: "inf", unit_amount_decimal: usage.unitAmountDecimal },
                ],
              }
            : { billing_scheme: "per_unit", unit_amount_decimal: usage.unitAmountDecimal }),
        }
      }

      const ensureTier = (tier: Tier, meters: Map<string, string>) =>
        Effect.gen(function* () {
          yield* ensureProduct(tier)
          const basePriceId = yield* ensurePrice(
            baseLookupKey(tier),
            tier,
            BASE_COMPONENT,
            `${tier.basePriceCents}|${tier.currency}`,
            {
              product: productId(tier),
              currency: tier.currency,
              nickname: `${tier.name} base`,
              unit_amount: tier.basePriceCents,
              tax_behavior: "exclusive",
              recurring: { interval: "month" },
            },
          )
          const usage: Array<CatalogMeter> = []
          for (const component of tier.usage) {
            const meterId = yield* ensureMeter(component, meters)
            const priceId = yield* ensurePrice(
              usageLookupKey(tier, component),
              tier,
              component.meter,
              `${meterId}|${component.unitAmountDecimal}|${component.includedUnits ?? 0}|${tier.currency}`,
              usagePriceBody(tier, component, meterId),
            )
            usage.push({ meter: component.meter, meterId, priceId })
          }
          const entry: CatalogTier = {
            tierId: tier.id,
            productId: productId(tier),
            basePriceId,
            usage,
          }
          return entry
        })

      const ensureCatalog: Effect.Effect<Catalog, BillingProviderError> = Effect.gen(function* () {
        const meters = yield* activeMeters
        const tiers: Array<CatalogTier> = []
        for (const tier of config.tiers) tiers.push(yield* ensureTier(tier, meters))
        yield* ensurePortal
        return { tiers }
      }).pipe(Effect.mapError((error) => providerError("ensureCatalog", error)))

      const ensurePortal = Effect.gen(function* () {
        let after: string | undefined
        for (;;) {
          const page = yield* request(
            stripe.GetBillingPortalConfigurations({
              active: true,
              limit: 100,
              starting_after: after,
            }),
          )
          const existing = page.data.find((entry) => entry.metadata?.akter_portal === PORTAL_KEY)
          if (existing !== undefined) return existing.id
          const last = page.data.at(-1)
          if (!page.has_more || last === undefined) break
          after = last.id
        }
        const created = yield* request(
          stripe.CreateBillingPortalConfiguration({
            name: "Akter billing management",
            metadata: { akter_portal: PORTAL_KEY },
            features: {
              customer_update: {
                enabled: true,
                allowed_updates: ["address", "email", "name", "tax_id"],
              },
              payment_method_update: { enabled: true },
              invoice_history: { enabled: true },
              subscription_cancel: {
                enabled: true,
                mode: "at_period_end",
                proration_behavior: "none",
              },
              subscription_update: { enabled: false },
            },
          }),
          `akter:portal:${PORTAL_KEY}`,
        )
        return created.id
      })

      const ensureCustomer = (input: CustomerInput) =>
        Effect.gen(function* () {
          let after: string | undefined
          for (;;) {
            const page = yield* request(stripe.GetCustomers({ limit: 100, starting_after: after }))
            const match = page.data.find(
              (customer) => customer.metadata?.akter_organization_id === input.organizationId,
            )
            if (match !== undefined) return { customerId: match.id }
            const last = page.data.at(-1)
            if (!page.has_more || last === undefined) break
            after = last.id
          }
          const created = yield* request(
            stripe.CreateCustomer({
              email: input.email,
              name: input.name,
              metadata: { akter_organization_id: input.organizationId },
            }),
            `akter:customer:${input.organizationId}`,
          )
          return { customerId: created.id }
        }).pipe(Effect.mapError((error) => providerError("ensureCustomer", error)))

      const startCheckout = (input: CheckoutInput) =>
        Effect.gen(function* () {
          const tier = yield* findTier(input.tierId)
          if (input.idempotencyKey !== undefined) {
            let after: string | undefined
            for (;;) {
              const page = yield* request(
                stripe.GetCheckoutSessions({
                  customer: input.customerId,
                  limit: 100,
                  starting_after: after,
                }),
              ).pipe(Effect.mapError(customerFailure("startCheckout", input.customerId)))
              const previous = page.data.find(
                (session) =>
                  session.metadata?.akter_request === input.idempotencyKey &&
                  session.metadata?.akter_organization_id === input.organizationId &&
                  session.metadata?.akter_tier === tier.id &&
                  (session.status === "open" || session.status === "complete"),
              )
              if (previous !== undefined) {
                const url =
                  previous.url ??
                  (previous.status === "complete"
                    ? (previous.success_url ?? input.successUrl)
                    : null)
                if (url === null)
                  return yield* BillingProviderError.make({
                    operation: "startCheckout",
                    message: "Existing checkout has no hosted URL",
                    retryable: false,
                  })
                return { id: previous.id, url }
              }
              const last = page.data.at(-1)
              if (!page.has_more || last === undefined) break
              after = last.id
            }
          }
          let afterSubscription: string | undefined
          for (;;) {
            const page = yield* request(
              stripe.GetSubscriptions({
                customer: input.customerId,
                status: "all",
                limit: 100,
                starting_after: afterSubscription,
              }),
            ).pipe(Effect.mapError(customerFailure("startCheckout", input.customerId)))
            if (
              page.data.some(
                (subscription) =>
                  CURRENT_STATUSES.has(subscription.status) &&
                  (Predicate.isString(subscription.customer)
                    ? subscription.customer
                    : subscription.customer.id) === input.customerId,
              )
            ) {
              return yield* BillingProviderError.make({
                operation: "startCheckout",
                message: "Customer already has a subscription; change it instead",
                retryable: false,
              })
            }
            const last = page.data.at(-1)
            if (!page.has_more || last === undefined) break
            afterSubscription = last.id
          }
          const keys = [
            baseLookupKey(tier),
            ...tier.usage.map((usage) => usageLookupKey(tier, usage)),
          ]
          const prices = yield* request(
            stripe.GetPrices({ lookup_keys: keys, active: true, limit: 100 }),
          ).pipe(Effect.mapError((error) => providerError("startCheckout", error)))
          const byKey = new Map(prices.data.map((price) => [price.lookup_key, price.id]))
          const lineItems: Array<{ readonly price: string; readonly quantity?: number }> = []
          for (const key of keys) {
            const price = byKey.get(key)
            if (price === undefined) return yield* CatalogNotReady.make({ tierId: tier.id })
            lineItems.push(key === baseLookupKey(tier) ? { price, quantity: 1 } : { price })
          }
          const metadata = { akter_organization_id: input.organizationId, akter_tier: tier.id }
          const created = yield* request(
            stripe.CreateCheckoutSession({
              mode: "subscription",
              customer: input.customerId,
              client_reference_id: input.organizationId,
              line_items: lineItems,
              success_url: input.successUrl,
              cancel_url: input.cancelUrl,
              automatic_tax: { enabled: true },
              customer_update: { address: "auto", name: "auto" },
              billing_address_collection: "required",
              tax_id_collection: { enabled: true },
              metadata: { ...metadata, akter_request: input.idempotencyKey },
              subscription_data: {
                metadata,
                billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
                proration_behavior: "none",
              },
            }),
            input.idempotencyKey,
          ).pipe(Effect.mapError(customerFailure("startCheckout", input.customerId)))
          if (created.url === null) {
            return yield* BillingProviderError.make({
              operation: "startCheckout",
              message: "Stripe returned a checkout session without a URL",
              retryable: false,
            })
          }
          return { id: created.id, url: created.url }
        })

      const openPortal = (input: PortalInput) =>
        Effect.flatMap(ensurePortal, (configuration) =>
          request(
            stripe.CreateBillingPortalSession({
              customer: input.customerId,
              return_url: input.returnUrl,
              configuration,
            }),
            input.idempotencyKey,
          ),
        ).pipe(
          Effect.map((created) => ({ id: created.id, url: created.url })),
          Effect.mapError(customerFailure("openPortal", input.customerId)),
        )

      const retrieveCustomer = (operation: string, customerId: string) =>
        request(stripe.GetCustomer({ customer: customerId })).pipe(
          Effect.mapError(customerFailure(operation, customerId)),
          Effect.filterOrFail(
            (customer): customer is Stripe.Services.stripe.Customer => !("deleted" in customer),
            () => UnknownCustomer.make({ customerId }),
          ),
        )

      const toSubscription = (
        subscription: Stripe.Services.stripe.Subscription,
      ): Subscription | undefined => {
        const customerId = Predicate.isString(subscription.customer)
          ? subscription.customer
          : subscription.customer.id
        const base = subscription.items.data.find(
          (item) => item.price.metadata.akter_component === BASE_COMPONENT,
        )
        const tierId = base?.price.metadata.akter_tier ?? subscription.metadata.akter_tier
        if (tierId === undefined || !config.tiers.some((tier) => tier.id === tierId))
          return undefined
        return {
          subscriptionId: subscription.id,
          customerId,
          tierId,
          status: subscription.status,
          currentPeriodEnd:
            base === undefined ? null : DateTime.makeUnsafe(base.current_period_end * 1000),
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        }
      }

      const reconcileSubscription = (
        customerId: string,
        subscriptionId: string,
      ): Effect.Effect<Subscription, BillingProviderError | UnknownSubscription> =>
        request(stripe.GetSubscription({ subscription_exposed_id: subscriptionId })).pipe(
          Effect.mapError((error) =>
            isMissing(error)
              ? UnknownSubscription.make({ subscriptionId })
              : providerError("reconcileSubscription", error),
          ),
          Effect.flatMap((subscription) => {
            const canonical = toSubscription(subscription)
            return canonical === undefined || canonical.customerId !== customerId
              ? Effect.fail(UnknownSubscription.make({ subscriptionId }))
              : Effect.succeed(canonical)
          }),
        )

      const changeSubscription = (input: ChangeSubscriptionInput) =>
        Effect.gen(function* () {
          const target = yield* findTier(input.tierId)
          const stored = yield* request(
            stripe.GetSubscription({ subscription_exposed_id: input.subscriptionId }),
          ).pipe(
            Effect.mapError((error) =>
              isMissing(error)
                ? UnknownSubscription.make({ subscriptionId: input.subscriptionId })
                : providerError("changeSubscription", error),
            ),
          )
          const current = toSubscription(stored)
          if (current === undefined || current.customerId !== input.customerId) {
            return yield* UnknownSubscription.make({ subscriptionId: input.subscriptionId })
          }
          const previous = yield* findTier(current.tierId)
          const expected = new Set([BASE_COMPONENT, ...previous.usage.map((entry) => entry.meter)])
          const oldItems = new Map<string, string>()
          for (const item of stored.items.data) {
            const component = item.price.metadata.akter_component
            const product = Predicate.isString(item.price.product)
              ? item.price.product
              : item.price.product.id
            if (
              component === undefined ||
              !expected.has(component) ||
              oldItems.has(component) ||
              item.price.metadata.akter_tier !== previous.id ||
              product !== productId(previous)
            ) {
              return yield* BillingProviderError.make({
                operation: "changeSubscription",
                message: "Subscription contains unmanaged or duplicate items",
                retryable: false,
              })
            }
            oldItems.set(component, item.id)
          }
          if (
            stored.items.has_more ||
            oldItems.size !== expected.size ||
            !stored.automatic_tax.enabled
          ) {
            return yield* BillingProviderError.make({
              operation: "changeSubscription",
              message: "Subscription items are incomplete or automatic tax is disabled",
              retryable: false,
            })
          }
          const components = [BASE_COMPONENT, ...target.usage.map((entry) => entry.meter)]
          const keys = [
            baseLookupKey(target),
            ...target.usage.map((entry) => usageLookupKey(target, entry)),
          ]
          const catalog = yield* request(
            stripe.GetPrices({ lookup_keys: keys, active: true, limit: 100 }),
          ).pipe(Effect.mapError((error) => providerError("changeSubscription", error)))
          const prices = new Map(catalog.data.map((price) => [price.lookup_key, price]))
          const items: Array<Stripe.Services.stripe.UpdateSubscriptionRequestItemsItem> = []
          for (let index = 0; index < components.length; index++) {
            const component = components[index]!
            const price = prices.get(keys[index]!)
            const product =
              price === undefined
                ? undefined
                : Predicate.isString(price.product)
                  ? price.product
                  : price.product.id
            if (
              price === undefined ||
              price.metadata.akter_tier !== target.id ||
              price.metadata.akter_component !== component ||
              price.tax_behavior !== "exclusive" ||
              product !== productId(target)
            ) {
              return yield* CatalogNotReady.make({ tierId: target.id })
            }
            const id = oldItems.get(component)
            items.push(
              component === BASE_COMPONENT
                ? { id, price: price.id, quantity: 1 }
                : { id, price: price.id },
            )
            oldItems.delete(component)
          }
          for (const id of oldItems.values()) items.push({ id, deleted: true })
          const updated = yield* request(
            stripe.UpdateSubscription({
              subscription_exposed_id: input.subscriptionId,
              items,
              billing_cycle_anchor: "unchanged",
              proration_behavior: "create_prorations",
              payment_behavior: "pending_if_incomplete",
            }),
            input.idempotencyKey,
          ).pipe(Effect.mapError((error) => providerError("changeSubscription", error)))
          const canonical = toSubscription(updated)
          if (canonical === undefined || canonical.customerId !== input.customerId) {
            return yield* UnknownSubscription.make({ subscriptionId: input.subscriptionId })
          }
          return canonical
        })

      const billingDetails = (
        customerId: string,
      ): Effect.Effect<BillingDetails, BillingProviderError | UnknownCustomer> =>
        Effect.gen(function* () {
          const customer = yield* retrieveCustomer("billingDetails", customerId)
          const taxIds = yield* request(
            stripe.GetCustomerTaxIds({ customer: customerId, limit: 100 }),
          ).pipe(Effect.mapError(customerFailure("billingDetails", customerId)))
          const subscriptions: Array<Subscription> = []
          let after: string | undefined
          for (;;) {
            const page = yield* request(
              stripe.GetSubscriptions({
                customer: customerId,
                status: "all",
                limit: 100,
                starting_after: after,
              }),
            ).pipe(Effect.mapError(customerFailure("billingDetails", customerId)))
            for (const entry of page.data) {
              const canonical = toSubscription(entry)
              if (
                canonical !== undefined &&
                canonical.customerId === customerId &&
                CURRENT_STATUSES.has(canonical.status)
              ) {
                subscriptions.push(canonical)
              }
            }
            if (subscriptions.length > 1)
              return yield* BillingProviderError.make({
                operation: "billingDetails",
                message: "Customer has multiple managed subscriptions",
                retryable: false,
              })
            const last = page.data.at(-1)
            if (!page.has_more || last === undefined) break
            after = last.id
          }
          return {
            customerId,
            subscription: subscriptions[0] ?? null,
            email: customer.email,
            name: customer.name ?? null,
            address:
              customer.address == null
                ? null
                : {
                    line1: customer.address.line1,
                    line2: customer.address.line2,
                    city: customer.address.city,
                    state: customer.address.state,
                    postalCode: customer.address.postal_code,
                    country: customer.address.country,
                  },
            taxIds: taxIds.data.map((taxId) => ({ type: taxId.type, value: taxId.value })),
          }
        })

      const paymentMethod = (
        customerId: string,
      ): Effect.Effect<PaymentMethod | null, BillingProviderError | UnknownCustomer> =>
        Effect.gen(function* () {
          const customer = yield* retrieveCustomer("paymentMethod", customerId)
          const preferred = customer.invoice_settings?.default_payment_method
          const method = Predicate.isString(preferred)
            ? yield* request(stripe.GetPaymentMethod({ payment_method: preferred })).pipe(
                Effect.mapError(customerFailure("paymentMethod", customerId)),
              )
            : preferred != null
              ? preferred
              : (yield* request(
                  stripe.GetCustomerPaymentMethods({
                    customer: customerId,
                    type: "card",
                    limit: 1,
                  }),
                ).pipe(Effect.mapError(customerFailure("paymentMethod", customerId)))).data[0]
          if (method?.card === undefined) return null
          return {
            id: method.id,
            brand: method.card.brand,
            lastFour: method.card.last4,
            expiryMonth: method.card.exp_month,
            expiryYear: method.card.exp_year,
          }
        })

      const invoices = (
        customerId: string,
        limit = 24,
      ): Effect.Effect<ReadonlyArray<InvoiceRecord>, BillingProviderError | UnknownCustomer> =>
        request(stripe.GetInvoices({ customer: customerId, limit })).pipe(
          Effect.mapError(customerFailure("invoices", customerId)),
          Effect.map((page) =>
            page.data.map((invoice) => ({
              id: invoice.id ?? "",
              number: invoice.number,
              periodStart: DateTime.makeUnsafe(invoice.period_start * 1000),
              periodEnd: DateTime.makeUnsafe(invoice.period_end * 1000),
              amountCents: invoice.total,
              currency: invoice.currency,
              status: invoiceStatus(invoice.status),
              pdfUrl: invoice.invoice_pdf ?? null,
              hostedUrl: invoice.hosted_invoice_url ?? null,
            })),
          ),
        )

      const meterEventSession = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(session)
        if (
          Option.isSome(cached) &&
          cached.value.expiresAtMillis - SESSION_REFRESH_MARGIN_MILLIS > now
        ) {
          return { token: cached.value.token, fresh: false }
        }
        const created = yield* request(stripe.CreateBillingMeterEventSession({}))
        const expiresAt = DateTime.make(created.expires_at)
        yield* Ref.set(
          session,
          Option.map(expiresAt, (expires) => ({
            token: created.authentication_token,
            expiresAtMillis: DateTime.toEpochMillis(expires),
          })),
        )
        return { token: created.authentication_token, fresh: true }
      })

      const sendBatch = (
        token: string,
        batch: ReadonlyArray<{ readonly identifier: string; readonly event: UsageEvent }>,
      ) =>
        request(
          stripe
            .CreateBillingMeterEventStream({
              events: batch.map(({ identifier, event }) => ({
                event_name: event.meter,
                identifier,
                timestamp: DateTime.formatIso(event.occurredAt),
                payload: {
                  stripe_customer_id: event.customerId,
                  value: usageValueText(event.value),
                },
              })),
            })
            .pipe(
              Effect.provideService(
                Stripe.Credentials,
                Effect.succeed({
                  apiKey: Redacted.make(token),
                  apiBaseUrl: meterEventsBaseUrl,
                }),
              ),
            ),
        )

      const submitBatch = (
        batch: ReadonlyArray<{ readonly identifier: string; readonly event: UsageEvent }>,
      ) =>
        Effect.gen(function* () {
          const first = yield* meterEventSession
          yield* sendBatch(first.token, batch).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* Ref.set(session, Option.none())
                if (first.fresh) return yield* error
                const renewed = yield* meterEventSession
                yield* sendBatch(renewed.token, batch).pipe(
                  Effect.tapError(() => Ref.set(session, Option.none())),
                )
              }),
            ),
          )
        }).pipe(Effect.mapError((error) => providerError("recordUsage", error)))

      const recordUsage = (events: ReadonlyArray<UsageEvent>) =>
        Effect.gen(function* () {
          const batches = yield* planUsage(config)(events).pipe(Effect.provideContext(context))
          for (const batch of batches) yield* submitBatch(batch)
          return {
            identifiers: batches.flatMap((batch) => batch.map(({ identifier }) => identifier)),
            batches: batches.length,
          }
        })

      return StripeBilling.of({
        ensureCatalog,
        ensureCustomer,
        startCheckout,
        openPortal,
        changeSubscription,
        billingDetails,
        paymentMethod,
        invoices,
        reconcileSubscription,
        recordUsage,
        verifyWebhook: verifyWebhook(config),
      })
    }),
  )
