import { BunCrypto } from "@effect/platform-bun"
import { PgliteClient } from "@effect/sql-pglite"
import { Clock, type Crypto, DateTime, Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { it } from "@effect/vitest"
import { afterAll, describe, expect } from "vitest"

import {
  BillingProviderError,
  CatalogNotReady,
  StripeBilling,
  type Tier,
  UnknownCustomer,
  UnknownMeter,
  UnknownSubscription,
  UnknownTier,
  type UsageEvent,
  WebhookRejected,
} from "./contract.ts"
import {
  type LocalBillingConfig,
  StripeBillingLocal,
  UnknownSession,
  completeLocalCheckout,
} from "./local.ts"
import { signWebhook } from "./webhooks.ts"

const SECRET = Redacted.make("whsec_local_secret")

type Services = SqlClient.SqlClient | Crypto.Crypto

const runtime = ManagedRuntime.make(Layer.merge(PgliteClient.layer(), BunCrypto.layer))

afterAll(() => runtime.dispose())

const tierNamed = (id: string, basePriceCents = 2500): Tier => ({
  id,
  name: id,
  basePriceCents,
  currency: "usd",
  usage: [
    { meter: "commands", displayName: "Commands", unitAmountDecimal: "0.0001" },
    { meter: "storageGb", displayName: "Storage", unitAmountDecimal: "30" },
  ],
})

const configFor = (id: string, basePriceCents?: number): LocalBillingConfig => ({
  tiers: [tierNamed(id, basePriceCents)],
  webhookSecret: SECRET,
})

/** Each call builds a fresh provider over the shared database, as a restarted process would. */
const billing = <A, E>(
  config: LocalBillingConfig,
  program: Effect.Effect<A, E, StripeBilling | Services>,
) =>
  Effect.promise(() =>
    runtime.runPromise(
      Effect.scoped(
        Layer.build(StripeBillingLocal(config)).pipe(
          Effect.flatMap((context) => program.pipe(Effect.provideContext(context))),
        ),
      ),
    ),
  )

const query = <A, E>(program: Effect.Effect<A, E, Services>) =>
  Effect.promise(() => runtime.runPromise(program))

const total = (
  table: string,
  column: string,
  value: string,
  match: "equals" | "contains" = "equals",
) =>
  query(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ total: number }>`
        SELECT count(*)::int AS total FROM ${sql(table)}
        WHERE ${sql(column)} ${match === "equals" ? sql.unsafe("=") : sql.unsafe("LIKE")} ${match === "equals" ? value : `%${value}%`}
      `
      return row!.total
    }),
  )

const events = (
  at: DateTime.Utc,
  customerId: string,
  count: number,
  key: (index: number) => string = (index) => `k${index}`,
) =>
  Array.from({ length: count }, (_, index): UsageEvent => ({
    meter: "commands",
    customerId,
    key: key(index),
    value: index + 1,
    occurredAt: at,
  }))

const customerFor = (organizationId: string, email = `${organizationId}@example.com`) =>
  StripeBilling.use((service) => service.ensureCustomer({ organizationId, email, name: "A" }))

const checkout = (customerId: string, tierId: string, idempotencyKey?: string) =>
  StripeBilling.use((service) =>
    service.startCheckout({
      organizationId: "org",
      customerId,
      tierId,
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      idempotencyKey,
    }),
  )

const catalog = StripeBilling.use((service) => service.ensureCatalog)

describe("durable local provider", () => {
  it.live("keeps customers and catalog in the database across provider restarts", () =>
    Effect.gen(function* () {
      const config = configFor("restart")
      const first = yield* billing(
        config,
        Effect.all({ customer: customerFor("org_restart"), catalog }),
      )
      const second = yield* billing(
        config,
        Effect.all({ customer: customerFor("org_restart"), catalog }),
      )

      expect(second).toEqual(first)
      expect(first.catalog.tiers[0]!.usage).toHaveLength(2)
      expect(yield* total("cloud_billing_customer", "organization_id", "org_restart")).toBe(1)
      expect(yield* total("cloud_billing_catalog", "key", "restart", "contains")).toBe(1 + 1 + 2)
    }),
  )

  it.live("creates one customer when the same organization is ensured concurrently", () =>
    Effect.gen(function* () {
      const ids = yield* billing(
        configFor("concurrent"),
        Effect.all(
          Array.from({ length: 8 }, () => customerFor("org_concurrent")),
          { concurrency: 8 },
        ),
      )

      expect(new Set(ids.map((entry) => entry.customerId)).size).toBe(1)
      expect(yield* total("cloud_billing_customer", "organization_id", "org_concurrent")).toBe(1)
    }),
  )

  it.live("gives a changed price a new identifier and leaves an unchanged one alone", () =>
    Effect.gen(function* () {
      const before = yield* billing(configFor("repriced"), catalog)
      const again = yield* billing(configFor("repriced"), catalog)
      const repriced = yield* billing(configFor("repriced", 3000), catalog)

      expect(again).toEqual(before)
      expect(repriced.tiers[0]!.basePriceId).not.toBe(before.tiers[0]!.basePriceId)
      expect(repriced.tiers[0]!.productId).toBe(before.tiers[0]!.productId)
      expect(repriced.tiers[0]!.usage).toEqual(before.tiers[0]!.usage)
    }),
  )

  it.live("stores hosted sessions and replays one idempotency key to the same session", () =>
    Effect.gen(function* () {
      const config = configFor("sessions")
      const result = yield* billing(
        config,
        Effect.gen(function* () {
          const { customerId } = yield* customerFor("org_sessions")
          yield* catalog
          const service = yield* StripeBilling
          const first = yield* checkout(customerId, "sessions", "key-1")
          return {
            customerId,
            first,
            replay: yield* checkout(customerId, "sessions", "key-1"),
            other: yield* checkout(customerId, "sessions", "key-2"),
            portal: yield* service.openPortal({
              customerId,
              returnUrl: "https://app.test/billing",
              idempotencyKey: "key-1",
            }),
          }
        }),
      )

      expect(result.replay).toEqual(result.first)
      expect(result.other.id).not.toBe(result.first.id)
      expect(result.portal.id).not.toBe(result.first.id)
      expect(result.first.url).toContain(result.first.id)
      expect(yield* total("cloud_billing_session", "customer_id", result.customerId)).toBe(3)
      const saved = yield* query(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [row] = yield* sql<{
            params: {
              customer: string
              success_url: string
              cancel_url: string
              metadata: { akter_organization_id: string; akter_tier: string; akter_request: string }
            }
          }>`SELECT params FROM cloud_billing_session WHERE id = ${result.first.id}`
          return row!.params
        }),
      )
      expect(saved).toEqual({
        customer: result.customerId,
        success_url: "https://app.test/ok",
        cancel_url: "https://app.test/no",
        base_price_cents: 2500,
        currency: "usd",
        automatic_tax: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        tax_id_collection: { enabled: true },
        subscription_data: {
          billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
          proration_behavior: "none",
        },
        metadata: { akter_organization_id: "org", akter_tier: "sessions", akter_request: "key-1" },
      })
    }),
  )

  it.live("rejects unknown tiers, customers and an unprepared catalog", () =>
    Effect.gen(function* () {
      const config = configFor("strict")
      const { customerId } = yield* billing(config, customerFor("org_strict"))
      const rejected = (id: string, tierId: string) =>
        billing(config, Effect.flip(checkout(id, tierId)))

      expect(yield* rejected(customerId, "gold")).toEqual(UnknownTier.make({ tierId: "gold" }))
      expect(yield* rejected(customerId, "strict")).toEqual(
        CatalogNotReady.make({ tierId: "strict" }),
      )
      expect(yield* rejected("cus_nobody", "strict")).toEqual(
        UnknownCustomer.make({ customerId: "cus_nobody" }),
      )
      expect(
        yield* billing(
          config,
          Effect.flip(StripeBilling.use((service) => service.billingDetails("cus_nobody"))),
        ),
      ).toEqual(UnknownCustomer.make({ customerId: "cus_nobody" }))
      expect(yield* total("cloud_billing_session", "customer_id", customerId)).toBe(0)
    }),
  )

  it.live("reports billing details with no payment method or invoices", () =>
    Effect.gen(function* () {
      const config = configFor("details")
      const state = yield* billing(
        config,
        Effect.gen(function* () {
          const { customerId } = yield* customerFor("org_details", "a@example.com")
          const service = yield* StripeBilling
          return {
            customerId,
            details: yield* service.billingDetails(customerId),
            method: yield* service.paymentMethod(customerId),
            invoices: yield* service.invoices(customerId),
          }
        }),
      )

      expect(state.details).toEqual({
        customerId: state.customerId,
        email: "a@example.com",
        name: "A",
        address: null,
        taxIds: [],
        subscription: null,
      })
      expect(state.method).toBeNull()
      expect(state.invoices).toEqual([])
    }),
  )
})

describe("local meter events", () => {
  it.live("deduplicates by deterministic identifier across calls and restarts", () =>
    Effect.gen(function* () {
      const config = configFor("meters")
      const record = (list: ReadonlyArray<UsageEvent>) =>
        billing(
          config,
          StripeBilling.use((service) => service.recordUsage(list)),
        )
      const at = yield* DateTime.now
      const first = yield* record(events(at, "cus_meters", 250))
      const replay = yield* record(
        events(at, "cus_meters", 250).map((event) => ({ ...event, value: 999 })),
      )
      const kept = yield* query(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [row] = yield* sql<{ value: number }>`
          SELECT value FROM cloud_billing_meter_event WHERE identifier = ${first.identifiers[0]!}
        `
          return row!.value
        }),
      )

      expect(first.batches).toBe(3)
      expect(first.identifiers).toHaveLength(250)
      expect(new Set(first.identifiers).size).toBe(250)
      expect(replay.identifiers).toEqual(first.identifiers)
      expect(yield* total("cloud_billing_meter_event", "customer_id", "cus_meters")).toBe(250)
      expect(kept).toBe(1)
    }),
  )

  it.live("stores fractional values exactly as reported", () =>
    Effect.gen(function* () {
      const config = configFor("fractions")
      const at = yield* DateTime.now
      const [event] = events(at, "cus_fractions", 1)
      const receipt = yield* billing(
        config,
        StripeBilling.use((service) =>
          service.recordUsage([
            { ...event!, key: "reads", value: 12.4 },
            { ...event!, meter: "storageGb", key: "storage", value: 0.21345 },
            {
              ...event!,
              meter: "storageGb",
              key: "storage-hour",
              value: 53 / (1_000_000_000 * 744),
            },
          ]),
        ),
      )
      const stored = yield* query(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ meter: string; value: number }>`
            SELECT meter, value FROM cloud_billing_meter_event
            WHERE customer_id = ${"cus_fractions"} ORDER BY meter
          `
        }),
      )

      expect(receipt.identifiers).toHaveLength(3)
      expect(stored.map((row) => [row.meter, row.value])).toEqual(
        expect.arrayContaining([
          ["commands", 12.4],
          ["storageGb", 0.21345],
          ["storageGb", 53 / (1_000_000_000 * 744)],
        ]),
      )
      const payloads = yield* query(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ payload_value: string }>`
          SELECT payload_value FROM cloud_billing_meter_event WHERE customer_id = 'cus_fractions'`
        }),
      )
      expect(payloads.map((row) => row.payload_value)).toEqual(
        expect.arrayContaining(["12.4", "0.21345", "0.0000000000712365591397849"]),
      )
    }),
  )

  it.live("refuses unknown meters and negative values without storing anything", () =>
    Effect.gen(function* () {
      const config = configFor("refusals")
      const now = yield* DateTime.now
      const [event] = events(now, "cus_refusals", 1)
      const record = (list: ReadonlyArray<UsageEvent>) =>
        billing(config, Effect.flip(StripeBilling.use((service) => service.recordUsage(list))))

      expect(yield* record([{ ...event!, meter: "mystery" }])).toEqual(
        UnknownMeter.make({ meter: "mystery" }),
      )
      expect(yield* record([{ ...event!, value: -5 }])).toBeInstanceOf(BillingProviderError)
      expect(
        yield* record([{ ...event!, occurredAt: DateTime.subtract(now, { days: 36 }) }]),
      ).toBeInstanceOf(BillingProviderError)
      expect(
        yield* record([{ ...event!, occurredAt: DateTime.add(now, { minutes: 10 }) }]),
      ).toBeInstanceOf(BillingProviderError)
      expect(yield* total("cloud_billing_meter_event", "customer_id", "cus_refusals")).toBe(0)
    }),
  )
})

describe("local subscriptions", () => {
  it.live("keeps incomplete local subscriptions canonical and blocks a second checkout", () =>
    Effect.gen(function* () {
      const config = configFor("initial-payment")
      const { customerId, session } = yield* billing(config, subscribed("initial-payment"))
      yield* query(completeLocalCheckout(session.id, "incomplete"))
      const details = yield* billing(
        config,
        StripeBilling.use((service) => service.billingDetails(customerId)),
      )
      expect(details.subscription?.status).toBe("incomplete")
      expect(
        yield* billing(
          config,
          Effect.flip(checkout(customerId, "initial-payment", "second-request")),
        ),
      ).toMatchObject({ retryable: false })
      yield* query(completeLocalCheckout(session.id, "incomplete_expired"))
      const expired = yield* billing(
        config,
        StripeBilling.use((service) => service.billingDetails(customerId)),
      )
      expect(expired.subscription).toBeNull()
    }),
  )
  it.live(
    "persists a simulated card and one paid base-price invoice after checkout completion",
    () =>
      Effect.gen(function* () {
        const config = configFor("simulated-payment", 24900)
        const { customerId, session } = yield* billing(config, subscribed("simulated-payment"))
        const completed = yield* query(completeLocalCheckout(session.id))
        yield* query(completeLocalCheckout(session.id))
        const read = Effect.gen(function* () {
          const service = yield* StripeBilling
          return {
            method: yield* service.paymentMethod(customerId),
            invoices: yield* service.invoices(customerId),
          }
        })
        const first = yield* billing(config, read)
        const restarted = yield* billing(configFor("simulated-payment", 30000), read)
        expect(restarted).toEqual(first)
        expect(first.method).toMatchObject({
          brand: "visa",
          lastFour: "4242",
          expiryMonth: 7,
          expiryYear: 2036,
        })
        expect(first.invoices).toHaveLength(1)
        expect(first.invoices[0]).toMatchObject({
          amountCents: 24900,
          currency: "usd",
          status: "paid",
          pdfUrl: null,
        })
        expect(first.invoices[0]!.periodStart).toEqual(completed.currentPeriodEnd)
        expect(first.invoices[0]!.periodEnd).toEqual(
          DateTime.add(first.invoices[0]!.periodStart, { months: 1 }),
        )
        expect(DateTime.startOf(first.invoices[0]!.periodStart, "month")).toEqual(
          first.invoices[0]!.periodStart,
        )
        const { customerId: other } = yield* billing(config, customerFor("no-simulated-payment"))
        expect(
          yield* billing(
            config,
            StripeBilling.use((service) => service.paymentMethod(other)),
          ),
        ).toBeNull()
        expect(
          yield* billing(
            config,
            StripeBilling.use((service) => service.invoices(other)),
          ),
        ).toEqual([])
      }),
  )
  it.live("fails closed if SQL contains multiple current subscriptions for the customer", () =>
    Effect.gen(function* () {
      const config = configFor("duplicate-state")
      const { customerId, session } = yield* billing(config, subscribed("duplicate-state"))
      const first = yield* query(completeLocalCheckout(session.id))
      yield* query(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO cloud_billing_subscription
          (subscription_id, customer_id, tier_id, status, current_period_end)
          VALUES (${`${first.subscriptionId}_duplicate`}, ${customerId}, 'duplicate-state', 'active', now())`
        }),
      )
      expect(
        yield* billing(
          config,
          Effect.flip(StripeBilling.use((service) => service.billingDetails(customerId))),
        ),
      ).toEqual(
        BillingProviderError.make({
          operation: "billingDetails",
          message: "Customer has multiple managed subscriptions",
          retryable: false,
        }),
      )
    }),
  )
  it.live(
    "recovers a completed checkout before the active-subscription guard and refuses a new request",
    () =>
      Effect.gen(function* () {
        const config = configFor("checkout-recovery")
        const { customerId } = yield* billing(config, customerFor("checkout-recovery-customer"))
        yield* billing(config, catalog)
        const first = yield* billing(
          config,
          checkout(customerId, "checkout-recovery", "checkout-recovery-request"),
        )
        yield* query(completeLocalCheckout(first.id))
        const replay = yield* billing(
          config,
          checkout(customerId, "checkout-recovery", "checkout-recovery-request"),
        )
        expect(replay).toEqual(first)
        const failure = yield* billing(
          config,
          Effect.flip(checkout(customerId, "checkout-recovery", "checkout-another-request")),
        )
        expect(failure).toMatchObject({ operation: "startCheckout", retryable: false })
        expect(yield* total("cloud_billing_session", "customer_id", customerId)).toBe(1)
        expect(yield* total("cloud_billing_subscription", "customer_id", customerId)).toBe(1)
      }),
  )
  it.live(
    "changes one subscription in SQL, keeps its period, and remembers change idempotency across layers",
    () =>
      Effect.gen(function* () {
        const config = {
          ...configFor("change-pro"),
          tiers: [tierNamed("change-pro"), tierNamed("change-team", 24900)],
        }
        const { customerId, session } = yield* billing(config, subscribed("change-pro"))
        const before = yield* query(completeLocalCheckout(session.id))
        const change = (tierId: string, idempotencyKey: string, customer = customerId) =>
          billing(
            config,
            StripeBilling.use((service) =>
              service.changeSubscription({
                customerId: customer,
                subscriptionId: before.subscriptionId,
                tierId,
                idempotencyKey,
              }),
            ),
          )
        const upgrade = yield* change("change-team", "upgrade-local")
        const downgrade = yield* change("change-pro", "downgrade-local")
        const replay = yield* change("change-team", "upgrade-local")
        expect(upgrade.tierId).toBe("change-team")
        expect(downgrade.tierId).toBe("change-pro")
        expect(replay.tierId).toBe("change-pro")
        expect(upgrade.subscriptionId).toBe(before.subscriptionId)
        expect(upgrade.currentPeriodEnd).toEqual(before.currentPeriodEnd)
        expect(yield* total("cloud_billing_subscription", "customer_id", customerId)).toBe(1)
        expect(
          yield* total(
            "cloud_billing_subscription_change",
            "subscription_id",
            before.subscriptionId,
          ),
        ).toBe(2)
        expect(
          yield* billing(
            config,
            Effect.flip(
              StripeBilling.use((service) =>
                service.changeSubscription({
                  customerId: "cus_other",
                  subscriptionId: before.subscriptionId,
                  tierId: "change-team",
                  idempotencyKey: "not-mine",
                }),
              ),
            ),
          ),
        ).toEqual(UnknownSubscription.make({ subscriptionId: before.subscriptionId }))
      }),
  )
  const subscribed = (tierId: string) =>
    Effect.gen(function* () {
      const { customerId } = yield* customerFor(`org_${tierId}`)
      yield* catalog
      const session = yield* checkout(customerId, tierId)
      return { customerId, session }
    })

  it.live(
    "reconciles the subscription a completed checkout created, for its own customer only",
    () =>
      Effect.gen(function* () {
        const config = configFor("reconcile")
        const { customerId, session } = yield* billing(config, subscribed("reconcile"))
        const created = yield* query(completeLocalCheckout(session.id))
        const reconcile = (customer: string, subscription: string) =>
          billing(
            config,
            StripeBilling.use((service) => service.reconcileSubscription(customer, subscription)),
          )
        const reconciled = yield* reconcile(customerId, created.subscriptionId)
        const details = yield* billing(
          config,
          StripeBilling.use((service) => service.billingDetails(customerId)),
        )

        expect(reconciled).toEqual(created)
        expect(reconciled).toMatchObject({ customerId, tierId: "reconcile", status: "active" })
        const now = yield* DateTime.now
        expect(reconciled.currentPeriodEnd).toEqual(
          DateTime.add(DateTime.startOf(now, "month"), { months: 1 }),
        )
        expect(details.subscription).toEqual(created)
        expect(
          yield* billing(
            config,
            Effect.flip(
              StripeBilling.use((service) =>
                service.reconcileSubscription("cus_other", created.subscriptionId),
              ),
            ),
          ),
        ).toEqual(UnknownSubscription.make({ subscriptionId: created.subscriptionId }))
        expect(
          yield* billing(
            config,
            Effect.flip(
              StripeBilling.use((service) => service.reconcileSubscription(customerId, "sub_nope")),
            ),
          ),
        ).toEqual(UnknownSubscription.make({ subscriptionId: "sub_nope" }))
      }),
  )

  it.live("reports the latest stored state, not an earlier one", () =>
    Effect.gen(function* () {
      const config = configFor("latest")
      const { customerId, session } = yield* billing(config, subscribed("latest"))
      const active = yield* query(completeLocalCheckout(session.id))
      yield* query(completeLocalCheckout(session.id, "past_due"))
      const current = yield* billing(
        config,
        StripeBilling.use((service) =>
          service.reconcileSubscription(customerId, active.subscriptionId),
        ),
      )
      yield* query(completeLocalCheckout(session.id, "canceled"))
      const details = yield* billing(
        config,
        StripeBilling.use((service) => service.billingDetails(customerId)),
      )

      expect(current.status).toBe("past_due")
      expect(details.subscription).toBeNull()
      expect(yield* total("cloud_billing_subscription", "customer_id", customerId)).toBe(1)
    }),
  )

  it.live("only completes checkout sessions that exist", () =>
    Effect.gen(function* () {
      expect(yield* query(Effect.flip(completeLocalCheckout("cs_local_nothing")))).toEqual(
        UnknownSession.make({ sessionId: "cs_local_nothing" }),
      )
    }),
  )
})

describe("local portal configuration", () => {
  it.live(
    "persists supported features and uses one durable configuration for portal sessions",
    () =>
      Effect.gen(function* () {
        const config = configFor("portal-config")
        const { customerId } = yield* billing(config, customerFor("portal-config-customer"))
        const portal = StripeBilling.use((service) =>
          service.openPortal({ customerId, returnUrl: "https://app.test/billing" }),
        )
        const first = yield* billing(config, portal)
        const second = yield* billing(config, portal)
        const saved = yield* query(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const configurations = yield* sql<{
              configuration_id: string
              features: {
                subscription_update: { enabled: boolean }
                subscription_cancel: { enabled: boolean; mode: string }
                customer_update: { enabled: boolean; allowed_updates: ReadonlyArray<string> }
                invoice_history: { enabled: boolean }
                payment_method_update: { enabled: boolean }
              }
            }>`SELECT configuration_id, features FROM cloud_billing_portal_configuration`
            const sessions = yield* sql<{ params: { configuration: string } }>`
          SELECT params FROM cloud_billing_session WHERE id IN ${sql.in([first.id, second.id])}`
            return { configurations, sessions }
          }),
        )
        expect(saved.configurations).toHaveLength(1)
        expect(saved.configurations[0]!.features.subscription_update.enabled).toBe(false)
        expect(saved.configurations[0]!.features.subscription_cancel).toMatchObject({
          enabled: true,
          mode: "at_period_end",
        })
        expect(saved.configurations[0]!.features.customer_update.allowed_updates).toContain(
          "tax_id",
        )
        expect(saved.configurations[0]!.features.invoice_history.enabled).toBe(true)
        expect(saved.configurations[0]!.features.payment_method_update.enabled).toBe(true)
        expect(saved.sessions.map((entry) => entry.params.configuration)).toEqual([
          saved.configurations[0]!.configuration_id,
          saved.configurations[0]!.configuration_id,
        ])
      }),
  )
})

describe("local webhooks", () => {
  const body =
    '{"id":"evt_9","type":"invoice.paid","created":1790000000,"livemode":false,"data":{"object":{"id":"in_9"}}}'
  const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))
  const verify = (signature: string | null) =>
    billing(
      configFor("webhooks"),
      Effect.exit(StripeBilling.use((service) => service.verifyWebhook(body, signature))),
    )

  it.live("verifies a signed event with the shared Stripe helpers", () =>
    Effect.gen(function* () {
      const header = yield* signWebhook(SECRET, body, yield* nowSeconds)
      const exit = yield* verify(header)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Exit.isSuccess(exit) ? exit.value : null).toMatchObject({
        id: "evt_9",
        type: "invoice.paid",
        data: { id: "in_9" },
      })
    }),
  )

  it.live("rejects a forged signature", () =>
    Effect.gen(function* () {
      const forged = yield* signWebhook(Redacted.make("whsec_other"), body, yield* nowSeconds)

      expect(
        yield* billing(
          configFor("webhooks"),
          Effect.flip(StripeBilling.use((service) => service.verifyWebhook(body, forged))),
        ),
      ).toBeInstanceOf(WebhookRejected)
    }),
  )
})
