import { Database } from "@rikalabs/akter/runtime"
import { Crypto, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

import {
  BillingProviderError,
  type BillingConfig,
  type Catalog,
  type CatalogMeter,
  type CatalogTier,
  CardPaymentMethod,
  CatalogNotReady,
  type CheckoutInput,
  type ChangeSubscriptionInput,
  type CustomerInput,
  type PortalInput,
  StripeBilling,
  type Subscription,
  type SubscriptionStatus,
  type Tier,
  UnknownCustomer,
  UnknownSubscription,
  UnknownTier,
  type UsageEvent,
  type UsagePrice,
} from "./contract.ts"
import { planUsage, sha256Hex, usageValueText } from "./usage.ts"
import { verifyWebhook } from "./webhooks.ts"

export interface LocalBillingConfig extends BillingConfig {
  readonly hostedBaseUrl?: string | undefined
}

interface CustomerRow {
  readonly customer_id: string
  readonly email: string
  readonly name: string | null
}

interface SessionRow {
  readonly id: string
  readonly url: string
}

interface SubscriptionRow {
  readonly subscription_id: string
  readonly customer_id: string
  readonly tier_id: string
  readonly status: SubscriptionStatus
  readonly current_period_end: Date | string | null
  readonly cancel_at_period_end: boolean
}

interface CheckoutSessionRow {
  readonly customer_id: string
  readonly tier_id: string | null
  readonly base_price_cents: number | null
  readonly currency: string | null
}

interface PaymentRow {
  readonly id: string
  readonly brand: string
  readonly last_four: string
  readonly expiry_month: number
  readonly expiry_year: number
}

interface InvoiceRow {
  readonly id: string
  readonly number: string
  readonly period_start: Date
  readonly period_end: Date
  readonly amount_cents: number
  readonly currency: string
}

interface CatalogRow {
  readonly object_id: string
}

const DEFAULT_HOSTED_BASE_URL = "http://localhost:3000"

const baseLookupKey = (tier: Tier): string => `akter_${tier.id}_base`
const usageLookupKey = (tier: Tier, usage: UsagePrice): string => `akter_${tier.id}_${usage.meter}`

const CURRENT_STATUSES = "('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'paused')"

/** The checkout session does not exist locally, or is not a checkout. */
export class UnknownSession extends Schema.TaggedError<UnknownSession>()("UnknownSession", {
  sessionId: Schema.String,
}) {}

const subscriptionOf = (row: SubscriptionRow): Subscription => ({
  subscriptionId: row.subscription_id,
  customerId: row.customer_id,
  tierId: row.tier_id,
  status: row.status,
  currentPeriodEnd:
    row.current_period_end === null ? null : DateTime.makeUnsafe(row.current_period_end),
  cancelAtPeriodEnd: row.cancel_at_period_end,
})

const storeFailure = (operation: string) =>
  BillingProviderError.make({
    operation,
    message: "The local billing store failed",
    retryable: false,
  })

/**
 * The same `StripeBilling` service for development and tests, with every fact
 * the hosted provider would keep (customers, catalog, hosted sessions, meter
 * event identifiers) stored in the database's `cloud_billing_*` tables
 * instead of process memory, so it survives restarts and is shared by every
 * process on the database. Completed checkouts have explicitly simulated card
 * and invoice records, never real payment credentials or calculated tax. It
 * checks webhooks with the same Stripe helpers as the hosted provider.
 */
export const StripeBillingLocal = (config: LocalBillingConfig) =>
  Layer.effect(
    StripeBilling,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const crypto = yield* Crypto.Crypto
      const hostedBaseUrl = config.hostedBaseUrl ?? DEFAULT_HOSTED_BASE_URL
      const withCrypto = Effect.provideService(Crypto.Crypto, crypto)

      yield* Database.schemaChange(
        Effect.gen(function* () {
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_customer (
            organization_id text PRIMARY KEY,
            customer_id text NOT NULL UNIQUE,
            email text NOT NULL,
            name text,
            created_at timestamptz NOT NULL DEFAULT now()
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_catalog (
            key text PRIMARY KEY,
            object_id text NOT NULL,
            fingerprint text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_session (
            id text PRIMARY KEY,
            kind text NOT NULL,
            customer_id text NOT NULL,
            organization_id text,
            tier_id text,
            idempotency_key text UNIQUE,
            url text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )`
          yield* sql`ALTER TABLE cloud_billing_session
            ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}'::jsonb`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_portal_configuration (
            key text PRIMARY KEY,
            configuration_id text NOT NULL UNIQUE,
            features jsonb NOT NULL
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_subscription_change (
            idempotency_key text PRIMARY KEY,
            subscription_id text NOT NULL,
            customer_id text NOT NULL,
            tier_id text NOT NULL
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_payment_method (
            customer_id text PRIMARY KEY,
            id text NOT NULL,
            brand text NOT NULL,
            last_four text NOT NULL,
            expiry_month integer NOT NULL,
            expiry_year integer NOT NULL
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_invoice (
            id text PRIMARY KEY,
            checkout_id text NOT NULL UNIQUE,
            customer_id text NOT NULL,
            number text NOT NULL,
            period_start timestamptz NOT NULL,
            period_end timestamptz NOT NULL,
            amount_cents integer NOT NULL,
            currency text NOT NULL
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_subscription (
            subscription_id text PRIMARY KEY,
            customer_id text NOT NULL,
            tier_id text NOT NULL,
            status text NOT NULL,
            current_period_end timestamptz,
            cancel_at_period_end boolean NOT NULL DEFAULT false,
            updated_at timestamptz NOT NULL DEFAULT now()
          )`
          yield* sql`CREATE TABLE IF NOT EXISTS cloud_billing_meter_event (
            identifier text PRIMARY KEY,
            meter text NOT NULL,
            customer_id text NOT NULL,
            value double precision NOT NULL,
            occurred_at timestamptz NOT NULL,
            recorded_at timestamptz NOT NULL DEFAULT now()
          )`
          yield* sql`ALTER TABLE cloud_billing_meter_event ADD COLUMN IF NOT EXISTS payload_value text`
        }),
        499500503,
      )

      const findTier = (tierId: string): Effect.Effect<Tier, UnknownTier> => {
        const tier = config.tiers.find((candidate) => candidate.id === tierId)
        return tier === undefined ? Effect.fail(UnknownTier.make({ tierId })) : Effect.succeed(tier)
      }

      const objectId = (prefix: string, key: string, fingerprint: string) =>
        sha256Hex(`${key}:${fingerprint}`).pipe(
          withCrypto,
          Effect.map((hash) => `${prefix}_local_${hash.slice(0, 24)}`),
        )

      const ensureObject = (prefix: string, key: string, fingerprint: string) =>
        Effect.gen(function* () {
          const candidate = yield* objectId(prefix, key, fingerprint)
          const [row] = yield* sql<CatalogRow>`
            INSERT INTO cloud_billing_catalog (key, object_id, fingerprint)
            VALUES (${key}, ${candidate}, ${fingerprint})
            ON CONFLICT (key) DO UPDATE SET
              object_id = CASE
                WHEN cloud_billing_catalog.fingerprint = EXCLUDED.fingerprint
                THEN cloud_billing_catalog.object_id ELSE EXCLUDED.object_id END,
              fingerprint = EXCLUDED.fingerprint
            RETURNING object_id
          `
          return row!.object_id
        })

      const lookupObject = (key: string) =>
        sql<CatalogRow>`SELECT object_id FROM cloud_billing_catalog WHERE key = ${key}`.pipe(
          Effect.map(([row]) => row?.object_id),
        )

      const ensureCatalog: Effect.Effect<Catalog, BillingProviderError> = Effect.gen(function* () {
        const tiers: Array<CatalogTier> = []
        for (const tier of config.tiers) {
          const productId = yield* ensureObject("prod", `product:${tier.id}`, "")
          const basePriceId = yield* ensureObject(
            "price",
            baseLookupKey(tier),
            `${tier.basePriceCents}|${tier.currency}`,
          )
          const usage: Array<CatalogMeter> = []
          for (const component of tier.usage) {
            usage.push({
              meter: component.meter,
              meterId: yield* ensureObject("meter", `meter:${component.meter}`, ""),
              priceId: yield* ensureObject(
                "price",
                usageLookupKey(tier, component),
                `${component.unitAmountDecimal}|${component.includedUnits ?? 0}`,
              ),
            })
          }
          tiers.push({ tierId: tier.id, productId, basePriceId, usage })
        }
        yield* ensurePortal
        return { tiers }
      }).pipe(Effect.mapError(() => storeFailure("ensureCatalog")))

      const ensurePortal = Effect.gen(function* () {
        const [row] = yield* sql<{ configuration_id: string }>`
          INSERT INTO cloud_billing_portal_configuration (key, configuration_id, features)
          VALUES ('akter_billing_management_v1', 'bpc_local_akter_billing_management_v1',
            '{"customer_update":{"enabled":true,"allowed_updates":["address","email","name","tax_id"]},
              "payment_method_update":{"enabled":true},"invoice_history":{"enabled":true},
              "subscription_cancel":{"enabled":true,"mode":"at_period_end","proration_behavior":"none"},
              "subscription_update":{"enabled":false}}'::jsonb)
          ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
          RETURNING configuration_id`
        return row!.configuration_id
      })

      const ensureCustomer = (input: CustomerInput) =>
        Effect.gen(function* () {
          const customerId = yield* sha256Hex(input.organizationId).pipe(
            withCrypto,
            Effect.map((hash) => `cus_local_${hash.slice(0, 24)}`),
          )
          yield* sql`
            INSERT INTO cloud_billing_customer (organization_id, customer_id, email, name)
            VALUES (${input.organizationId}, ${customerId}, ${input.email}, ${input.name ?? null})
            ON CONFLICT (organization_id) DO NOTHING
          `
          const [row] = yield* sql<CustomerRow>`
            SELECT customer_id, email, name FROM cloud_billing_customer
            WHERE organization_id = ${input.organizationId}
          `
          return { customerId: row!.customer_id }
        }).pipe(Effect.mapError(() => storeFailure("ensureCustomer")))

      const requireCustomer = (operation: string, customerId: string) =>
        sql<CustomerRow>`
          SELECT customer_id, email, name FROM cloud_billing_customer WHERE customer_id = ${customerId}
        `.pipe(
          Effect.mapError(() => storeFailure(operation)),
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(UnknownCustomer.make({ customerId }))
              : Effect.succeed(row),
          ),
        )

      const createSession = (
        kind: "checkout" | "portal",
        customerId: string,
        organizationId: string | null,
        tierId: string | null,
        idempotencyKey: string | undefined,
        successUrl?: string,
        cancelUrl?: string,
        configurationId?: string,
        tier?: Tier,
      ) =>
        Effect.gen(function* () {
          const id = `${kind === "checkout" ? "cs" : "bps"}_local_${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`
          const scopedKey = idempotencyKey === undefined ? null : `${kind}:${idempotencyKey}`
          yield* sql`
            INSERT INTO cloud_billing_session
              (id, kind, customer_id, organization_id, tier_id, idempotency_key, url, params)
            VALUES (${id}, ${kind}, ${customerId}, ${organizationId}, ${tierId}, ${scopedKey},
                    ${`${hostedBaseUrl}/billing/${kind}/${id}`},
                    jsonb_strip_nulls(jsonb_build_object(
                      'customer', ${customerId}::text,
                      'success_url', ${successUrl ?? null}::text,
                      'cancel_url', ${cancelUrl ?? null}::text,
                      'configuration', ${configurationId ?? null}::text,
                      'base_price_cents', ${tier?.basePriceCents ?? null}::integer,
                      'currency', ${tier?.currency ?? null}::text,
                      'automatic_tax', CASE WHEN ${kind} = 'checkout' THEN jsonb_build_object('enabled', true) END,
                      'customer_update', CASE WHEN ${kind} = 'checkout' THEN jsonb_build_object('address', 'auto', 'name', 'auto') END,
                      'tax_id_collection', CASE WHEN ${kind} = 'checkout' THEN jsonb_build_object('enabled', true) END,
                      'subscription_data', CASE WHEN ${kind} = 'checkout' THEN jsonb_build_object(
                        'billing_cycle_anchor_config', jsonb_build_object('day_of_month', 1, 'hour', 0, 'minute', 0, 'second', 0),
                        'proration_behavior', 'none') END,
                      'metadata', jsonb_build_object(
                        'akter_organization_id', ${organizationId}::text,
                        'akter_tier', ${tierId}::text,
                        'akter_request', ${idempotencyKey ?? null}::text))))
            ON CONFLICT (idempotency_key) DO NOTHING
          `
          const [row] = yield* sql<SessionRow>`
            SELECT id, url FROM cloud_billing_session
            WHERE ${scopedKey === null ? sql`id = ${id}` : sql`idempotency_key = ${scopedKey}`}
              AND customer_id = ${customerId} AND kind = ${kind}
              AND organization_id IS NOT DISTINCT FROM ${organizationId}
              AND tier_id IS NOT DISTINCT FROM ${tierId}
          `
          if (row === undefined)
            return yield* BillingProviderError.make({
              operation: kind === "checkout" ? "startCheckout" : "openPortal",
              message: "Idempotency key belongs to another session",
              retryable: false,
            })
          return { id: row!.id, url: row!.url }
        }).pipe(
          Effect.catchTag("SqlError", () =>
            Effect.fail(storeFailure(kind === "checkout" ? "startCheckout" : "openPortal")),
          ),
        )

      const startCheckout = (input: CheckoutInput) =>
        Effect.gen(function* () {
          const tier = yield* findTier(input.tierId)
          yield* requireCustomer("startCheckout", input.customerId)
          if (input.idempotencyKey !== undefined) {
            const [previous] = yield* sql<SessionRow>`
              SELECT id, url FROM cloud_billing_session
              WHERE idempotency_key = ${`checkout:${input.idempotencyKey}`}
                AND customer_id = ${input.customerId} AND organization_id = ${input.organizationId}
                AND tier_id = ${tier.id}`.pipe(Effect.mapError(() => storeFailure("startCheckout")))
            if (previous !== undefined) return previous
          }
          const active = yield* sql`
            SELECT 1 FROM cloud_billing_subscription
            WHERE customer_id = ${input.customerId} AND status IN ${sql.unsafe(CURRENT_STATUSES)}
            LIMIT 1`.pipe(Effect.mapError(() => storeFailure("startCheckout")))
          if (active.length > 0)
            return yield* BillingProviderError.make({
              operation: "startCheckout",
              message: "Customer already has a subscription; change it instead",
              retryable: false,
            })
          const keys = [
            baseLookupKey(tier),
            ...tier.usage.map((usage) => usageLookupKey(tier, usage)),
          ]
          for (const key of keys) {
            const found = yield* lookupObject(key).pipe(
              Effect.mapError(() => storeFailure("startCheckout")),
            )
            if (found === undefined) return yield* CatalogNotReady.make({ tierId: tier.id })
          }
          return yield* createSession(
            "checkout",
            input.customerId,
            input.organizationId,
            tier.id,
            input.idempotencyKey,
            input.successUrl,
            input.cancelUrl,
            undefined,
            tier,
          )
        })

      const openPortal = (input: PortalInput) =>
        Effect.gen(function* () {
          yield* requireCustomer("openPortal", input.customerId)
          const configuration = yield* ensurePortal.pipe(
            Effect.mapError(() => storeFailure("openPortal")),
          )
          return yield* createSession(
            "portal",
            input.customerId,
            null,
            null,
            input.idempotencyKey,
            undefined,
            undefined,
            configuration,
          )
        })

      const billingDetails = (customerId: string) =>
        Effect.gen(function* () {
          const customer = yield* requireCustomer("billingDetails", customerId)
          const current = yield* sql<SubscriptionRow>`
            SELECT subscription_id, customer_id, tier_id, status, current_period_end, cancel_at_period_end
            FROM cloud_billing_subscription
            WHERE customer_id = ${customerId} AND status IN ${sql.unsafe(CURRENT_STATUSES)}
            ORDER BY updated_at DESC LIMIT 2
          `.pipe(Effect.mapError(() => storeFailure("billingDetails")))
          if (current.length > 1)
            return yield* BillingProviderError.make({
              operation: "billingDetails",
              message: "Customer has multiple managed subscriptions",
              retryable: false,
            })
          return {
            customerId,
            email: customer.email,
            name: customer.name,
            address: null,
            taxIds: [],
            subscription: current[0] === undefined ? null : subscriptionOf(current[0]),
          }
        })

      const reconcileSubscription = (customerId: string, subscriptionId: string) =>
        sql<SubscriptionRow>`
          SELECT subscription_id, customer_id, tier_id, status, current_period_end, cancel_at_period_end
          FROM cloud_billing_subscription
          WHERE subscription_id = ${subscriptionId} AND customer_id = ${customerId}
        `.pipe(
          Effect.mapError(() => storeFailure("reconcileSubscription")),
          Effect.flatMap(([row]) =>
            row === undefined
              ? Effect.fail(UnknownSubscription.make({ subscriptionId }))
              : Effect.succeed(subscriptionOf(row)),
          ),
        )

      const changeSubscription = (input: ChangeSubscriptionInput) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const target = yield* findTier(input.tierId)
              const current = yield* reconcileSubscription(input.customerId, input.subscriptionId)
              yield* findTier(current.tierId)
              const keys = [
                baseLookupKey(target),
                ...target.usage.map((entry) => usageLookupKey(target, entry)),
              ]
              for (const key of keys) {
                if ((yield* lookupObject(key)) === undefined)
                  return yield* CatalogNotReady.make({ tierId: target.id })
              }
              const inserted = yield* sql<{ idempotency_key: string }>`
            INSERT INTO cloud_billing_subscription_change
              (idempotency_key, subscription_id, customer_id, tier_id)
            VALUES (${input.idempotencyKey}, ${input.subscriptionId}, ${input.customerId}, ${target.id})
            ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`
              const [saved] = yield* sql<{
                subscription_id: string
                customer_id: string
                tier_id: string
              }>`
            SELECT subscription_id, customer_id, tier_id FROM cloud_billing_subscription_change
            WHERE idempotency_key = ${input.idempotencyKey}`
              if (
                saved!.subscription_id !== input.subscriptionId ||
                saved!.customer_id !== input.customerId ||
                saved!.tier_id !== target.id
              ) {
                return yield* BillingProviderError.make({
                  operation: "changeSubscription",
                  message: "Idempotency key belongs to a different subscription change",
                  retryable: false,
                })
              }
              if (inserted.length > 0) {
                yield* sql`UPDATE cloud_billing_subscription SET tier_id = ${target.id}, updated_at = now()
              WHERE subscription_id = ${input.subscriptionId} AND customer_id = ${input.customerId}`
              }
              return yield* reconcileSubscription(input.customerId, input.subscriptionId)
            }),
          )
          .pipe(Effect.catchTag("SqlError", () => Effect.fail(storeFailure("changeSubscription"))))

      const paymentMethod = (customerId: string) =>
        Effect.gen(function* () {
          yield* requireCustomer("paymentMethod", customerId)
          const [row] = yield* sql<PaymentRow>`
            SELECT id, brand, last_four, expiry_month, expiry_year FROM cloud_billing_payment_method
            WHERE customer_id = ${customerId}`.pipe(
            Effect.mapError(() => storeFailure("paymentMethod")),
          )
          return row === undefined
            ? null
            : CardPaymentMethod.make({
                id: row.id,
                brand: row.brand,
                lastFour: row.last_four,
                expiryMonth: row.expiry_month,
                expiryYear: row.expiry_year,
              })
        })

      const invoices = (customerId: string, limit = 24) =>
        Effect.gen(function* () {
          yield* requireCustomer("invoices", customerId)
          const rows = yield* sql<InvoiceRow>`
            SELECT id, number, period_start, period_end, amount_cents, currency
            FROM cloud_billing_invoice WHERE customer_id = ${customerId}
            ORDER BY period_start DESC, id LIMIT ${Math.max(1, Math.min(100, Math.trunc(limit)))}`.pipe(
            Effect.mapError(() => storeFailure("invoices")),
          )
          return rows.map((row) => ({
            id: row.id,
            number: row.number,
            periodStart: DateTime.fromDateUnsafe(row.period_start),
            periodEnd: DateTime.fromDateUnsafe(row.period_end),
            amountCents: row.amount_cents,
            currency: row.currency,
            status: "paid" as const,
            pdfUrl: `${hostedBaseUrl}/billing/invoices/${encodeURIComponent(row.id)}/pdf`,
            hostedUrl: null,
          }))
        })

      const recordUsage = (events: ReadonlyArray<UsageEvent>) =>
        Effect.gen(function* () {
          const batches = yield* planUsage(config)(events).pipe(withCrypto)
          for (const batch of batches) {
            yield* sql
              .withTransaction(
                Effect.forEach(
                  batch,
                  ({ identifier, event }) => sql`
                  INSERT INTO cloud_billing_meter_event
                    (identifier, meter, customer_id, value, occurred_at, payload_value)
                  VALUES (${identifier}, ${event.meter}, ${event.customerId}, ${event.value},
                          ${DateTime.formatIso(event.occurredAt)}, ${usageValueText(event.value)})
                  ON CONFLICT (identifier) DO NOTHING
                `,
                  { discard: true },
                ),
              )
              .pipe(Effect.mapError(() => storeFailure("recordUsage")))
          }
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

const pdfText = (text: string) => text.replaceAll(/[\\()]/gu, (character) => `\\${character}`)

/**
 * A one-page PDF of a simulated invoice in the standard Helvetica font, built
 * byte for byte so its cross-reference offsets are exact and any PDF reader
 * opens it. Every value is ASCII, so string length is byte length.
 */
const invoiceDocument = (invoice: InvoiceRow): Uint8Array => {
  const day = (date: Date) => DateTime.formatIso(DateTime.fromDateUnsafe(date)).slice(0, 10)
  const lines = [
    "Akter Cloud invoice",
    `Invoice ${invoice.number}`,
    `Period ${day(invoice.period_start)} to ${day(invoice.period_end)}`,
    `Amount ${(invoice.amount_cents / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
    "Status paid",
    "Simulated by the local Stripe stand-in: no payment was taken and no tax was calculated.",
  ]
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((line) => `(${pdfText(line)}) Tj T*`).join(" ")} ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let body = "%PDF-1.4\n"
  const offsets: Array<number> = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}

/**
 * The PDF of a locally simulated invoice, which its `pdfUrl` serves, or
 * `None` when no such invoice exists.
 */
export const localInvoicePdf = Effect.fn("localInvoicePdf")(function* (invoiceId: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<InvoiceRow>`
    SELECT id, number, period_start, period_end, amount_cents, currency
    FROM cloud_billing_invoice WHERE id = ${invoiceId}`
  return Option.map(Option.fromUndefinedOr(row), invoiceDocument)
})

/**
 * Completes a local checkout the way Stripe would after payment: the session's
 * customer gets a subscription on the session's tier, which later
 * `reconcileSubscription` calls report. Running it again for the same session
 * only changes the status, so tests can move a subscription through its states.
 * An active completion also stores a simulated Visa card (no PAN or CVC) and
 * one synthetic paid invoice for the checkout's first full UTC calendar month
 * at its captured base price. That invoice is a development fixture, not an
 * upfront charge for the free initial partial period, real payment or tax
 * calculation. The subscription's initial renewal is the next UTC month.
 */
export const completeLocalCheckout = Effect.fn("completeLocalCheckout")(
  function* (sessionId: string, status: SubscriptionStatus = "active") {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [session] = yield* sql<CheckoutSessionRow>`
      SELECT customer_id, tier_id, (params->>'base_price_cents')::integer AS base_price_cents,
        params->>'currency' AS currency FROM cloud_billing_session
      WHERE id = ${sessionId} AND kind = 'checkout'
    `
        if (session === undefined || session.tier_id === null) {
          return yield* UnknownSession.make({ sessionId })
        }
        if (
          status === "active" &&
          (session.base_price_cents === null || session.currency === null)
        ) {
          return yield* BillingProviderError.make({
            operation: "completeLocalCheckout",
            message: "Checkout has no captured price for a simulated invoice",
            retryable: false,
          })
        }
        const subscriptionId = `sub_local_${(yield* sha256Hex(sessionId)).slice(0, 24)}`
        const [row] = yield* sql<SubscriptionRow>`
      INSERT INTO cloud_billing_subscription
        (subscription_id, customer_id, tier_id, status, current_period_end)
      VALUES (${subscriptionId}, ${session.customer_id}, ${session.tier_id}, ${status},
              (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC')
      ON CONFLICT (subscription_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
      RETURNING subscription_id, customer_id, tier_id, status, current_period_end, cancel_at_period_end
    `
        if (status === "active") {
          const hash = (yield* sha256Hex(sessionId)).slice(0, 24)
          yield* sql`INSERT INTO cloud_billing_payment_method
        (customer_id, id, brand, last_four, expiry_month, expiry_year)
        VALUES (${session.customer_id}, ${`pm_local_${hash}`}, 'visa', '4242', 7, 2036)
        ON CONFLICT (customer_id) DO NOTHING`
          yield* sql`INSERT INTO cloud_billing_invoice
        (id, checkout_id, customer_id, number, period_start, period_end, amount_cents, currency)
        VALUES (${`in_local_${hash}`}, ${sessionId}, ${session.customer_id}, ${`LOCAL-${hash}`},
          ${row!.current_period_end},
          (${row!.current_period_end}::timestamptz AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC',
          ${session.base_price_cents!}, ${session.currency!})
        ON CONFLICT (checkout_id) DO NOTHING`
        }
        return subscriptionOf(row!)
      }),
    )
  },
  Effect.catchTag("SqlError", () => Effect.fail(storeFailure("completeLocalCheckout"))),
)
