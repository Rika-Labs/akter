import * as Stripe from "@distilled.cloud/stripe"
import { BunCrypto } from "@effect/platform-bun"
import { Clock, DateTime, Effect, Layer, Predicate, Redacted, Schedule, Schema } from "effect"
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"

import {
  type DistilledBillingConfig,
  StripeBillingDistilled,
  DEFAULT_METER_EVENTS_BASE_URL,
} from "./distilled.ts"
import {
  BillingProviderError,
  CardPaymentMethod,
  CatalogNotReady,
  CheckoutExpired,
  LinkPaymentMethod,
  StripeBilling,
  type Tier,
  UnknownCustomer,
  UnknownMeter,
  UnknownSubscription,
  UnknownTier,
  type UsageEvent,
  WebhookRejected,
} from "./contract.ts"
import { signWebhook } from "./webhooks.ts"

interface Recorded {
  readonly method: string
  readonly url: URL
  readonly authorization: string
  readonly idempotencyKey: string | null
  readonly form: URLSearchParams
  readonly body: string
}

const API_KEY = "sk_test_fake"
const SESSION_TOKEN = "mes_fake_token"
const SECRET = Redacted.make("whsec_test_secret")
const encoder = new TextEncoder()

const tiers: ReadonlyArray<Tier> = [
  {
    id: "pro",
    name: "Pro",
    description: "Pro plan",
    basePriceCents: 2500,
    currency: "usd",
    usage: [
      {
        meter: "commands",
        displayName: "Commands",
        unitAmountDecimal: "0.0001",
        includedUnits: 25_000_000,
      },
      { meter: "storageGb", displayName: "Storage", unitAmountDecimal: "30" },
    ],
  },
]

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(text))).pipe(Effect.map(hex))

const hmacHeader = (secret: string, body: string, timestamp: number) =>
  Effect.gen(function* () {
    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    )
    const mac = yield* Effect.promise(() =>
      crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)),
    )
    return `t=${timestamp},v1=${hex(mac)}`
  })

const json = (status: number, body: Schema.JsonObject): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const stripeError = (status: number, type: string, code: string): Response =>
  json(status, { error: { type, code, message: `${type} ${code}` } })

const entries = (form: URLSearchParams, prefix: string): Map<string, string> => {
  const found = new Map<string, string>()
  for (const [key, value] of form) {
    if (key.startsWith(`${prefix}[`)) found.set(key.slice(prefix.length + 1, -1), value)
  }
  return found
}

interface StoredPrice {
  id: string
  lookup_key: string | null
  metadata: Map<string, string>
  product: string
  unit_amount: number | null
  active: boolean
  tax_behavior: string | null
  meter: string | null
}

interface PaymentMethodState {
  customerDefault: string | null
  listed: Array<Schema.JsonObject>
}

const linkMethod = (id: string, email: string | null): Schema.JsonObject => ({
  id,
  type: "link",
  link: { email },
})

const cardMethod = (id: string): Schema.JsonObject => ({
  id,
  type: "card",
  card: { brand: "visa", last4: "4242", exp_month: 7, exp_year: 2031 },
})

/** A Stripe test double that remembers what was created, so repeated setup calls see earlier objects. */
const makeStripe = () => {
  const requests: Array<Recorded> = []
  const products = new Set<string>()
  const prices: Array<StoredPrice> = []
  const meters: Array<{ id: string; event_name: string }> = []
  const customers: Array<{ id: string; email: string; organization: string }> = []
  const portalConfigurations = [
    { id: "bpc_unrelated", metadata: { akter_portal: "another_application" } },
  ]
  const subscriptionState = {
    tierId: "pro",
    paymentDeclines: false,
    active: false,
    status: "active",
    paginated: false,
    multiple: false,
  }
  const paymentMethodState: PaymentMethodState = { customerDefault: "pm_1", listed: [] }
  const checkoutSessions: Array<{
    id: string
    customer: string
    url: string
    status: string
    metadata: Map<string, string> | null
  }> = []
  const checkoutReplies = new Map<string, { id: string; url: string }>()
  let checkoutSequence = 0
  const failures: Array<Response> = []
  const streamFailures: Array<Response> = []
  const session = { expiresAt: "2099-10-03T00:15:00.000Z" }
  let sequence = 0
  const nextId = (prefix: string) => `${prefix}_${++sequence}`

  const route = (request: Recorded): Response => {
    const { method, url, form } = request
    const path = url.pathname

    if (url.host === "meter-events.stripe.com") {
      if (request.authorization !== `Bearer ${SESSION_TOKEN}`) {
        return stripeError(401, "invalid_request_error", "authentication")
      }
      return json(200, {})
    }
    if (method === "POST" && path === "/v2/billing/meter_event_session") {
      return json(200, {
        id: "mes_1",
        object: "v2.billing.meter_event_session",
        authentication_token: SESSION_TOKEN,
        created: "2026-10-03T00:00:00.000Z",
        expires_at: session.expiresAt,
        livemode: false,
      })
    }
    const product = path.match(/^\/v1\/products\/(.+)$/)
    if (method === "GET" && product !== null) {
      return products.has(product[1]!)
        ? json(200, { id: product[1]!, object: "product" })
        : stripeError(404, "invalid_request_error", "resource_missing")
    }
    if (method === "POST" && path === "/v1/products") {
      products.add(form.get("id")!)
      return json(200, { id: form.get("id"), object: "product" })
    }
    if (method === "GET" && path === "/v1/billing/meters") {
      return json(200, { object: "list", data: meters, has_more: false, url: path })
    }
    if (method === "POST" && path === "/v1/billing/meters") {
      const meter = { id: nextId("mtr"), event_name: form.get("event_name")! }
      meters.push(meter)
      return json(200, meter)
    }
    if (method === "GET" && path === "/v1/prices") {
      const wanted = new Set(
        [...url.searchParams].flatMap(([key, value]) =>
          key.startsWith("lookup_keys") ? [value] : [],
        ),
      )
      const data = prices.flatMap((price) =>
        price.lookup_key !== null &&
        wanted.has(price.lookup_key) &&
        (url.searchParams.get("active") !== "true" || price.active)
          ? [
              {
                id: price.id,
                active: price.active,
                lookup_key: price.lookup_key,
                metadata: Object.fromEntries(price.metadata),
                tax_behavior: price.tax_behavior,
                product: price.product,
                recurring: {
                  interval: "month",
                  interval_count: 1,
                  meter: price.meter,
                  trial_period_days: null,
                  usage_type: price.meter === null ? "licensed" : "metered",
                },
              },
            ]
          : [],
      )
      return json(200, { object: "list", data, has_more: false, url: path })
    }
    if (method === "POST" && path === "/v1/prices") {
      const lookupKey = form.get("lookup_key")
      if (form.get("transfer_lookup_key") === "true") {
        for (const price of prices) if (price.lookup_key === lookupKey) price.lookup_key = null
      }
      const price: StoredPrice = {
        id: nextId("price"),
        lookup_key: lookupKey,
        metadata: entries(form, "metadata"),
        product: form.get("product")!,
        unit_amount: null,
        active: true,
        tax_behavior: form.get("tax_behavior"),
        meter: form.get("recurring[meter]"),
      }
      prices.push(price)
      return json(200, { id: price.id, lookup_key: lookupKey })
    }
    if (method === "GET" && path === "/v1/customers") {
      const email = url.searchParams.get("email")
      const after = url.searchParams.get("starting_after")
      const start = after === null ? 0 : customers.findIndex((entry) => entry.id === after) + 1
      const data = customers.slice(start, start + 1).flatMap((customer) =>
        email === null || customer.email === email
          ? [
              {
                id: customer.id,
                email: customer.email,
                metadata: { akter_organization_id: customer.organization },
              },
            ]
          : [],
      )
      return json(200, { object: "list", data, has_more: start + 1 < customers.length, url: path })
    }
    if (method === "POST" && path === "/v1/customers") {
      const customer = {
        id: nextId("cus"),
        email: form.get("email")!,
        organization: entries(form, "metadata").get("akter_organization_id")!,
      }
      customers.push(customer)
      return json(200, { id: customer.id })
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      if (form.get("customer") === "cus_missing")
        return stripeError(400, "invalid_request_error", "resource_missing")
      const cached =
        request.idempotencyKey === null ? undefined : checkoutReplies.get(request.idempotencyKey)
      if (cached !== undefined) return json(200, cached)
      const id = `cs_test_${++checkoutSequence}`
      const session = {
        id,
        customer: form.get("customer")!,
        url: `https://checkout.stripe.test/${id}`,
        status: "open",
        metadata: entries(form, "metadata"),
      }
      checkoutSessions.push(session)
      const reply = { id: session.id, url: session.url }
      if (request.idempotencyKey !== null) checkoutReplies.set(request.idempotencyKey, reply)
      return json(200, reply)
    }
    if (method === "GET" && path === "/v1/checkout/sessions") {
      return json(200, {
        object: "list",
        has_more: false,
        url: path,
        data: checkoutSessions.flatMap((session) =>
          session.customer === url.searchParams.get("customer")
            ? [
                {
                  id: session.id,
                  customer: session.customer,
                  url: session.url,
                  status: session.status,
                  metadata: session.metadata === null ? null : Object.fromEntries(session.metadata),
                },
              ]
            : [],
        ),
      })
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      return form.get("customer") === "cus_missing"
        ? stripeError(404, "invalid_request_error", "resource_missing")
        : json(200, { id: "bps_1", url: "https://portal.stripe.test/bps_1" })
    }
    if (method === "GET" && path === "/v1/billing_portal/configurations") {
      const after = url.searchParams.get("starting_after")
      const start =
        after === null ? 0 : portalConfigurations.findIndex((entry) => entry.id === after) + 1
      const data = portalConfigurations.slice(start, start + 1)
      return json(200, {
        object: "list",
        data,
        has_more: start + 1 < portalConfigurations.length,
        url: path,
      })
    }
    if (method === "POST" && path === "/v1/billing_portal/configurations") {
      const created = {
        id: nextId("bpc"),
        metadata: { akter_portal: form.get("metadata[akter_portal]")! },
      }
      portalConfigurations.push(created)
      return json(200, created)
    }
    if (method === "GET" && path === "/v1/customers/cus_missing") {
      return stripeError(404, "invalid_request_error", "resource_missing")
    }
    if (method === "GET" && path === "/v1/customers/cus_known/tax_ids") {
      return json(200, {
        object: "list",
        data: [{ id: "txi_1", type: "eu_vat", value: "DE123456789" }],
        has_more: false,
        url: path,
      })
    }
    if (method === "GET" && path === "/v1/customers/cus_known") {
      return json(200, {
        id: "cus_known",
        email: "billing@example.com",
        name: "Example GmbH",
        address: {
          line1: "1 Main",
          line2: null,
          city: "Berlin",
          state: null,
          postal_code: "10115",
          country: "DE",
        },
        invoice_settings: { default_payment_method: paymentMethodState.customerDefault },
      })
    }
    if (method === "GET" && path === "/v1/customers/cus_known/payment_methods") {
      const type = url.searchParams.get("type")
      return json(200, {
        object: "list",
        data: paymentMethodState.listed.filter((entry) => entry.type === type),
        has_more: false,
        url: path,
      })
    }
    if (method === "GET" && path === "/v1/payment_methods/pm_link") {
      return json(200, linkMethod("pm_link", "ada@example.com"))
    }
    if (method === "GET" && path === "/v1/payment_methods/pm_1") {
      return json(200, {
        id: "pm_1",
        card: { brand: "visa", last4: "4242", exp_month: 7, exp_year: 2031 },
      })
    }
    if (method === "GET" && path === "/v1/invoices") {
      return json(200, {
        object: "list",
        has_more: false,
        url: path,
        data: [
          {
            id: "in_1",
            number: "AKT-0001",
            period_start: 1_788_000_000,
            period_end: 1_790_592_000,
            total: 2750,
            currency: "usd",
            status: "paid",
            invoice_pdf: "https://pay.stripe.test/in_1.pdf",
            hosted_invoice_url: "https://pay.stripe.test/in_1",
          },
        ],
      })
    }
    if (method === "GET" && path === "/v1/subscriptions") {
      if (url.searchParams.get("customer") === "cus_missing")
        return stripeError(404, "invalid_request_error", "resource_missing")
      if (subscriptionState.paginated && url.searchParams.get("starting_after") === null) {
        return json(200, {
          object: "list",
          has_more: true,
          url: path,
          data: [subscription("sub_newer_canceled", "cus_known", "canceled")],
        })
      }
      return json(200, {
        object: "list",
        has_more: false,
        url: path,
        data: subscriptionState.active
          ? [
              subscription("sub_1", "cus_known", subscriptionState.status),
              ...(subscriptionState.multiple ? [subscription("sub_2", "cus_known", "active")] : []),
            ]
          : [],
      })
    }
    const found = path.match(/^\/v1\/subscriptions\/(.+)$/)
    if (method === "GET" && found !== null) {
      return found[1] === "sub_missing"
        ? stripeError(404, "invalid_request_error", "resource_missing")
        : json(
            200,
            subscription(
              found[1]!,
              "cus_known",
              found[1] === "sub_canceled" ? "canceled" : "active",
              subscriptionState.tierId,
            ),
          )
    }
    if (method === "POST" && found !== null) {
      const targetPrice = prices.find((price) => price.id === form.get("items[0][price]"))
      const invoicedNow = form.get("proration_behavior") === "always_invoice"
      const heldUntilPaid =
        invoicedNow &&
        form.get("payment_behavior") === "pending_if_incomplete" &&
        subscriptionState.paymentDeclines
      if (!heldUntilPaid) subscriptionState.tierId = targetPrice!.metadata.get("akter_tier")!
      return json(200, subscription(found[1]!, "cus_known", "active", subscriptionState.tierId))
    }
    return stripeError(404, "invalid_request_error", "resource_missing")
  }

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const body =
        request.body instanceof HttpBody.Uint8Array
          ? new TextDecoder().decode(request.body.body)
          : ""
      const recorded: Recorded = {
        method: request.method,
        url,
        authorization: request.headers.authorization ?? "",
        idempotencyKey: request.headers["idempotency-key"] ?? null,
        form: new URLSearchParams(body.startsWith("{") ? "" : body),
        body,
      }
      requests.push(recorded)
      const queued =
        url.host === "meter-events.stripe.com" ? streamFailures.shift() : failures.shift()
      return HttpClientResponse.fromWeb(request, queued ?? route(recorded))
    }),
  )

  return {
    requests,
    failures,
    streamFailures,
    session,
    subscriptionState,
    paymentMethodState,
    checkoutSessions,
    prices,
    meters,
    layer: Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      Stripe.credentials({ apiKey: API_KEY }),
      BunCrypto.layer,
    ),
    posts: (path: string) =>
      requests.filter((entry) => entry.method === "POST" && entry.url.pathname === path),
  }
}

const subscription = (id: string, customer: string, status: string, tierId = "pro") => ({
  id,
  customer,
  status,
  cancel_at_period_end: false,
  metadata: { akter_tier: tierId },
  automatic_tax: { enabled: true },
  items: {
    object: "list",
    has_more: false,
    data: [
      {
        id: "si_usage",
        current_period_end: 1_790_000_000,
        price: {
          id: "price_u",
          product: `akter_${tierId}`,
          metadata: { akter_tier: tierId, akter_component: "commands" },
        },
      },
      {
        id: "si_base",
        current_period_end: 1_790_592_000,
        price: {
          id: "price_b",
          product: `akter_${tierId}`,
          metadata: { akter_tier: tierId, akter_component: "base" },
        },
      },
      {
        id: "si_storage",
        current_period_end: 1_790_592_000,
        price: {
          id: "price_s",
          product: `akter_${tierId}`,
          metadata: { akter_tier: tierId, akter_component: "storageGb" },
        },
      },
    ],
  },
})

const fastRetry: Stripe.Retry.Policy = {
  while: (error) => Predicate.isTagged(error, "ApiError"),
  schedule: Schedule.recurs(2),
}

const run = <A, E>(
  stripe: ReturnType<typeof makeStripe>,
  program: Effect.Effect<A, E, StripeBilling>,
  overrides: Partial<DistilledBillingConfig> = {},
) =>
  Effect.scoped(
    Layer.build(
      StripeBillingDistilled({
        tiers,
        webhookSecret: SECRET,
        retry: fastRetry,
        ...overrides,
      }).pipe(Layer.provide(stripe.layer)),
    ).pipe(Effect.flatMap((context) => program.pipe(Effect.provideContext(context)))),
  )

const fail = <A, E>(
  stripe: ReturnType<typeof makeStripe>,
  program: Effect.Effect<A, E, StripeBilling>,
  overrides: Partial<DistilledBillingConfig> = {},
) => run(stripe, Effect.flip(program), overrides)

const usage = (
  at: DateTime.Utc,
  count: number,
  key: (index: number) => string = (index) => `k${index}`,
) =>
  Array.from({ length: count }, (_, index): UsageEvent => ({
    meter: "commands",
    customerId: "cus_known",
    key: key(index),
    value: index + 1,
    occurredAt: at,
  }))

describe("catalog setup", () => {
  it.live("creates products, meters and graduated prices once, then reuses them", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const first = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const created = stripe.requests.filter((entry) => entry.method === "POST").length
      const second = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )

      expect(second).toEqual(first)
      expect(stripe.requests.filter((entry) => entry.method === "POST")).toHaveLength(created)
      expect(first.tiers).toHaveLength(1)
      expect(first.tiers[0]!.usage.map((entry) => entry.meter)).toEqual(["commands", "storageGb"])
      expect(stripe.posts("/v1/products")).toHaveLength(1)
      expect(stripe.posts("/v1/products")[0]!.form.get("id")).toBe("akter_pro")
      expect(stripe.posts("/v1/billing/meters")).toHaveLength(2)
      expect(stripe.posts("/v1/prices")).toHaveLength(3)
      expect(stripe.posts("/v1/billing_portal/configurations")).toHaveLength(1)
    }),
  )

  it.live(
    "sends allowance as a free first tier and keys every create with an idempotency key",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        yield* run(
          stripe,
          StripeBilling.use((billing) => billing.ensureCatalog),
        )
        const [base, commands, storage] = stripe.posts("/v1/prices")

        expect(base!.form.get("unit_amount")).toBe("2500")
        expect(base!.form.get("recurring[interval]")).toBe("month")
        expect(base!.form.get("tax_behavior")).toBe("exclusive")
        expect(commands!.form.get("billing_scheme")).toBe("tiered")
        expect(commands!.form.get("tiers_mode")).toBe("graduated")
        expect(commands!.form.get("tiers[0][up_to]")).toBe("25000000")
        expect(commands!.form.get("tiers[0][unit_amount]")).toBe("0")
        expect(commands!.form.get("tiers[1][up_to]")).toBe("inf")
        expect(commands!.form.get("tiers[1][unit_amount_decimal]")).toBe("0.0001")
        expect(commands!.form.get("recurring[usage_type]")).toBe("metered")
        expect(storage!.form.get("billing_scheme")).toBe("per_unit")
        expect(storage!.form.get("unit_amount_decimal")).toBe("30")
        for (const entry of [...stripe.posts("/v1/prices"), ...stripe.posts("/v1/products")]) {
          expect(entry.idempotencyKey).toMatch(/^akter:(price|product):/)
        }
      }),
  )

  it.live("replaces a price whose configuration changed and moves its lookup key", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const changed = tiers.map((tier) => ({ ...tier, basePriceCents: 3000 }))
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
        { tiers: changed },
      )
      const creates = stripe.posts("/v1/prices")

      expect(creates).toHaveLength(4)
      expect(creates[3]!.form.get("unit_amount")).toBe("3000")
      expect(creates[3]!.form.get("transfer_lookup_key")).toBe("true")
      expect(creates[3]!.idempotencyKey).not.toBe(creates[0]!.idempotencyKey)
    }),
  )
})

describe("customers, checkout and portal", () => {
  it.live(
    "recovers a customer by stable organization metadata across pages after an email change",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        const ensure = (organizationId: string, email: string) =>
          run(
            stripe,
            StripeBilling.use((billing) => billing.ensureCustomer({ organizationId, email })),
          )
        yield* ensure("org_first", "first@example.com")
        const original = yield* ensure("org_later", "old@example.com")
        const recovered = yield* ensure("org_later", "new@example.com")
        expect(recovered).toEqual(original)
        expect(stripe.posts("/v1/customers")).toHaveLength(2)
        expect(
          stripe.requests.some(
            (entry) =>
              entry.url.pathname === "/v1/customers" &&
              entry.url.searchParams.get("starting_after") !== null,
          ),
        ).toBe(true)
      }),
  )
  it.live("ignores a customer checkout with missing provider metadata", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.checkoutSessions.push({
        id: "cs_foreign",
        customer: "cus_known",
        url: "https://other.test/checkout",
        status: "open",
        metadata: null,
      })
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const created = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.startCheckout({
            organizationId: "org_1",
            customerId: "cus_known",
            tierId: "pro",
            idempotencyKey: "request-mine",
            successUrl: "https://app.test/ok",
            cancelUrl: "https://app.test/no",
          }),
        ),
      )
      expect(created.id).toBe("cs_test_1")
      expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(1)
    }),
  )
  it.live(
    "recovers the same completed checkout by durable request metadata before checking active subscriptions",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        const checkout = StripeBilling.use((billing) =>
          billing.startCheckout({
            organizationId: "org_1",
            customerId: "cus_known",
            tierId: "pro",
            successUrl: "https://app.test/ok",
            cancelUrl: "https://app.test/no",
            idempotencyKey: "org_1:request_1",
          }),
        )
        yield* run(
          stripe,
          StripeBilling.use((billing) => billing.ensureCatalog),
        )
        const first = yield* run(stripe, checkout)
        stripe.checkoutSessions[0]!.status = "complete"
        stripe.subscriptionState.active = true
        const replay = yield* run(stripe, checkout)
        expect(replay).toEqual(first)
        expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(1)
      }),
  )

  it.live(
    "proves an expired checkout for the same identity instead of replaying the cached session",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        const checkout = (idempotencyKey: string) =>
          StripeBilling.use((billing) =>
            billing.startCheckout({
              organizationId: "org_1",
              customerId: "cus_known",
              tierId: "pro",
              successUrl: "https://app.test/ok",
              cancelUrl: "https://app.test/no",
              idempotencyKey,
            }),
          )
        yield* run(
          stripe,
          StripeBilling.use((billing) => billing.ensureCatalog),
        )
        const first = yield* run(stripe, checkout("org_1:lost"))
        stripe.checkoutSessions[0]!.status = "expired"
        const subscriptionReads = () =>
          stripe.requests.filter((entry) => entry.url.pathname === "/v1/subscriptions").length
        const readsBefore = subscriptionReads()
        expect(yield* fail(stripe, checkout("org_1:lost"))).toEqual(
          CheckoutExpired.make({ sessionId: first.id }),
        )
        expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(1)
        expect(subscriptionReads()).toBe(readsBefore)
        const next = yield* run(stripe, checkout("org_1:next"))
        expect(next.id).not.toBe(first.id)
        expect(stripe.posts("/v1/checkout/sessions").map((entry) => entry.idempotencyKey)).toEqual([
          "org_1:lost",
          "org_1:next",
        ])
      }),
  )

  it.live("ignores an expired session from another identity, organization or tier", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      for (const metadata of [
        { akter_request: "org_1:other", akter_organization_id: "org_1", akter_tier: "pro" },
        { akter_request: "org_1:mine", akter_organization_id: "org_2", akter_tier: "pro" },
        { akter_request: "org_1:mine", akter_organization_id: "org_1", akter_tier: "team" },
      ])
        stripe.checkoutSessions.push({
          id: `cs_expired_${stripe.checkoutSessions.length}`,
          customer: "cus_known",
          url: "https://checkout.stripe.test/expired",
          status: "expired",
          metadata: new Map(Object.entries(metadata)),
        })
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const created = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.startCheckout({
            organizationId: "org_1",
            customerId: "cus_known",
            tierId: "pro",
            successUrl: "https://app.test/ok",
            cancelUrl: "https://app.test/no",
            idempotencyKey: "org_1:mine",
          }),
        ),
      )
      expect(created.id).toBe("cs_test_1")
      expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(1)
    }),
  )

  it.live("refuses a new checkout for any existing billable subscription", () =>
    Effect.gen(function* () {
      for (const status of ["incomplete", "active", "trialing", "past_due", "unpaid", "paused"]) {
        const stripe = makeStripe()
        stripe.subscriptionState.active = true
        stripe.subscriptionState.status = status
        const failure = yield* fail(
          stripe,
          StripeBilling.use((billing) =>
            billing.startCheckout({
              organizationId: "org_1",
              customerId: "cus_known",
              tierId: "pro",
              successUrl: "https://app.test/ok",
              cancelUrl: "https://app.test/no",
              idempotencyKey: "org_1:new_request",
            }),
          ),
        )
        expect(failure).toMatchObject({ operation: "startCheckout", retryable: false })
        expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(0)
      }
    }),
  )
  it.live(
    "manages only supported portal features and reuses its durable configuration across layers",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        const portal = StripeBilling.use((billing) =>
          billing.openPortal({
            customerId: "cus_known",
            returnUrl: "https://app.test/billing",
          }),
        )
        yield* run(stripe, portal)
        yield* run(stripe, portal)
        const [created] = stripe.posts("/v1/billing_portal/configurations")
        expect(stripe.posts("/v1/billing_portal/configurations")).toHaveLength(1)
        expect(created!.idempotencyKey).toBe("akter:portal:akter_billing_management_v1")
        expect(created!.form.get("features[subscription_update][enabled]")).toBe("false")
        expect(created!.form.get("features[subscription_cancel][enabled]")).toBe("true")
        expect(created!.form.get("features[subscription_cancel][mode]")).toBe("at_period_end")
        expect(created!.form.get("features[subscription_cancel][proration_behavior]")).toBe("none")
        expect(created!.form.get("features[invoice_history][enabled]")).toBe("true")
        expect(created!.form.get("features[payment_method_update][enabled]")).toBe("true")
        expect(created!.form.get("features[customer_update][allowed_updates][3]")).toBe("tax_id")
        const configurations = stripe
          .posts("/v1/billing_portal/sessions")
          .map((entry) => entry.form.get("configuration"))
        expect(configurations[0]).toMatch(/^bpc_/)
        expect(configurations[0]).not.toBe("bpc_unrelated")
        expect(configurations[1]).toBe(configurations[0])
      }),
  )
  it.live("finds the organization's existing customer before creating one", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const program = StripeBilling.use((billing) =>
        billing.ensureCustomer({ organizationId: "org_1", email: "a@example.com", name: "A" }),
      )
      const first = yield* run(stripe, program)
      const second = yield* run(stripe, program)
      const other = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.ensureCustomer({ organizationId: "org_2", email: "a@example.com" }),
        ),
      )

      expect(second).toEqual(first)
      expect(other.customerId).not.toBe(first.customerId)
      expect(stripe.posts("/v1/customers")).toHaveLength(2)
      expect(stripe.posts("/v1/customers")[0]!.idempotencyKey).toBe("akter:customer:org_1")
    }),
  )

  it.live("creates a subscription checkout with Stripe Tax enabled", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const session = yield* run(
        stripe,
        Effect.gen(function* () {
          const billing = yield* StripeBilling
          yield* billing.ensureCatalog
          return yield* billing.startCheckout({
            organizationId: "org_1",
            customerId: "cus_known",
            tierId: "pro",
            successUrl: "https://app.test/ok",
            cancelUrl: "https://app.test/no",
            idempotencyKey: "checkout-1",
          })
        }),
      )
      const [request] = stripe.posts("/v1/checkout/sessions")
      const form = request!.form

      expect(session).toEqual({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" })
      expect(request!.authorization).toBe(`Bearer ${API_KEY}`)
      expect(request!.idempotencyKey).toBe("checkout-1")
      expect(form.get("mode")).toBe("subscription")
      expect(form.get("customer")).toBe("cus_known")
      expect(form.get("client_reference_id")).toBe("org_1")
      expect(form.get("automatic_tax[enabled]")).toBe("true")
      expect(form.get("customer_update[address]")).toBe("auto")
      expect(form.get("customer_update[name]")).toBe("auto")
      expect(form.get("tax_id_collection[enabled]")).toBe("true")
      expect(form.get("billing_address_collection")).toBe("required")
      expect(form.get("success_url")).toBe("https://app.test/ok")
      expect(form.get("cancel_url")).toBe("https://app.test/no")
      expect(form.get("line_items[0][quantity]")).toBe("1")
      expect(form.get("line_items[1][quantity]")).toBeNull()
      expect(form.get("line_items[2][price]")).not.toBeNull()
      expect(form.get("subscription_data[metadata][akter_tier]")).toBe("pro")
      expect(form.get("subscription_data[metadata][akter_organization_id]")).toBe("org_1")
      expect(form.get("subscription_data[billing_cycle_anchor_config][day_of_month]")).toBe("1")
      expect(form.get("subscription_data[billing_cycle_anchor_config][hour]")).toBe("0")
      expect(form.get("subscription_data[billing_cycle_anchor_config][minute]")).toBe("0")
      expect(form.get("subscription_data[billing_cycle_anchor_config][second]")).toBe("0")
      expect(form.get("subscription_data[proration_behavior]")).toBe("none")
      expect(form.get("metadata[akter_request]")).toBe("checkout-1")
    }),
  )

  it.live("rejects an unknown tier, an unprepared catalog and an unknown customer", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const checkout = (tierId: string, customerId = "cus_known") =>
        StripeBilling.use((billing) =>
          billing.startCheckout({
            organizationId: "org_1",
            customerId,
            tierId,
            successUrl: "https://app.test/ok",
            cancelUrl: "https://app.test/no",
          }),
        )

      expect(yield* fail(stripe, checkout("gold"))).toEqual(UnknownTier.make({ tierId: "gold" }))
      expect(yield* fail(stripe, checkout("pro"))).toEqual(CatalogNotReady.make({ tierId: "pro" }))
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      expect(yield* fail(stripe, checkout("pro", "cus_missing"))).toEqual(
        UnknownCustomer.make({ customerId: "cus_missing" }),
      )
    }),
  )

  it.live("opens the billing portal for a customer", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const portal = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.openPortal({ customerId: "cus_known", returnUrl: "https://app.test/billing" }),
        ),
      )

      expect(portal).toEqual({ id: "bps_1", url: "https://portal.stripe.test/bps_1" })
      expect(stripe.posts("/v1/billing_portal/sessions")[0]!.form.get("return_url")).toBe(
        "https://app.test/billing",
      )
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) =>
            billing.openPortal({
              customerId: "cus_missing",
              returnUrl: "https://app.test/billing",
            }),
          ),
        ),
      ).toEqual(UnknownCustomer.make({ customerId: "cus_missing" }))
    }),
  )
})

describe("refusing catalog drift", () => {
  const repriced = (change: (tier: Tier) => Tier) => ({ tiers: tiers.map(change) })
  const checkout = StripeBilling.use((billing) =>
    billing.startCheckout({
      organizationId: "org_1",
      customerId: "cus_known",
      tierId: "pro",
      idempotencyKey: "org_1:checkout_drift",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    }),
  )
  const change = StripeBilling.use((billing) =>
    billing.changeSubscription({
      customerId: "cus_known",
      subscriptionId: "sub_1",
      tierId: "pro",
      idempotencyKey: "org_1:change_drift",
    }),
  )
  const refusesWithoutMutation = (
    stripe: ReturnType<typeof makeStripe>,
    overrides: Partial<DistilledBillingConfig> = {},
  ) =>
    Effect.gen(function* () {
      const pricesBefore = stripe.posts("/v1/prices").length
      expect(yield* fail(stripe, checkout, overrides)).toEqual(
        CatalogNotReady.make({ tierId: "pro" }),
      )
      expect(yield* fail(stripe, change, overrides)).toEqual(
        CatalogNotReady.make({ tierId: "pro" }),
      )
      expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(0)
      expect(stripe.posts("/v1/subscriptions/sub_1")).toHaveLength(0)
      expect(stripe.posts("/v1/prices")).toHaveLength(pricesBefore)
      expect(stripe.posts("/v1/billing/meters")).toHaveLength(2)
    })

  it.live("refuses a base price set up for a different base amount than the configuration", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      yield* refusesWithoutMutation(
        stripe,
        repriced((tier) => ({ ...tier, basePriceCents: 2900 })),
      )
    }),
  )

  it.live("refuses a stale usage price even when the base price still matches", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      yield* refusesWithoutMutation(
        stripe,
        repriced((tier) => ({
          ...tier,
          usage: tier.usage.map((usage) =>
            usage.meter === "commands" ? { ...usage, unitAmountDecimal: "0.00006" } : usage,
          ),
        })),
      )
    }),
  )

  it.live("refuses a usage price bound to a meter that is no longer the active one", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const commands = stripe.meters.findIndex((meter) => meter.event_name === "commands")
      stripe.meters[commands] = { id: "mtr_replacement", event_name: "commands" }
      yield* refusesWithoutMutation(stripe)
    }),
  )

  it.live("refuses a fingerprinted price whose tax behavior, product or meter was changed", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const storage = stripe.prices.find((price) => price.lookup_key === "akter_pro_storageGb")!
      storage.tax_behavior = "inclusive"
      yield* refusesWithoutMutation(stripe)
      storage.tax_behavior = "exclusive"
      storage.product = "akter_team"
      yield* refusesWithoutMutation(stripe)
      storage.product = "akter_pro"
      const commands = stripe.prices.find((price) => price.lookup_key === "akter_pro_commands")!
      commands.meter = "mtr_unrelated"
      yield* refusesWithoutMutation(stripe)
      commands.meter = stripe.meters.find((meter) => meter.event_name === "commands")!.id
      yield* run(stripe, checkout)
      expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(1)
    }),
  )

  it.live("sells exactly the new prices once setup has run for the changed configuration", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const changed = repriced((tier) => ({ ...tier, basePriceCents: 2900 }))
      const stale = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
      )
      const current = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
        changed,
      )
      expect(current.tiers[0]!.basePriceId).not.toBe(stale.tiers[0]!.basePriceId)
      expect(current.tiers[0]!.usage).toEqual(stale.tiers[0]!.usage)
      expect(yield* fail(stripe, checkout)).toEqual(CatalogNotReady.make({ tierId: "pro" }))
      yield* run(stripe, checkout, changed)
      const [form] = stripe.posts("/v1/checkout/sessions").map((entry) => entry.form)
      expect([0, 1, 2].map((index) => form!.get(`line_items[${index}][price]`))).toEqual([
        current.tiers[0]!.basePriceId,
        current.tiers[0]!.usage.find((entry) => entry.meter === "commands")!.priceId,
        current.tiers[0]!.usage.find((entry) => entry.meter === "storageGb")!.priceId,
      ])
      expect(form!.get("line_items[0][quantity]")).toBe("1")
      expect(form!.get("line_items[1][quantity]")).toBeNull()
      expect(form!.get("line_items[3][price]")).toBeNull()
    }),
  )
})

describe("changing an existing subscription", () => {
  const plans = [...tiers, { ...tiers[0]!, id: "team", name: "Team", basePriceCents: 24900 }]
  const change = (tierId: string, customerId = "cus_known", idempotencyKey = "org_1:change_1") =>
    StripeBilling.use((billing) =>
      billing.changeSubscription({
        customerId,
        subscriptionId: "sub_1",
        tierId,
        idempotencyKey,
      }),
    )

  it.live(
    "replaces all managed item prices by existing IDs in one request, preserving tax and the period",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        const catalog = yield* run(
          stripe,
          StripeBilling.use((billing) => billing.ensureCatalog),
          { tiers: plans },
        )
        const upgraded = yield* run(stripe, change("team"), { tiers: plans })
        const downgraded = yield* run(stripe, change("pro", "cus_known", "org_1:change_2"), {
          tiers: plans,
        })
        expect(upgraded.tierId).toBe("team")
        expect(downgraded.tierId).toBe("pro")
        expect(upgraded.subscriptionId).toBe("sub_1")
        expect(DateTime.toEpochMillis(upgraded.currentPeriodEnd!)).toBe(1_790_592_000_000)
        const [request] = stripe.posts("/v1/subscriptions/sub_1")
        expect(request!.idempotencyKey).toBe("org_1:change_1")
        expect([0, 1, 2].map((index) => request!.form.get(`items[${index}][id]`))).toEqual([
          "si_base",
          "si_usage",
          "si_storage",
        ])
        expect(
          new Set([0, 1, 2].map((index) => request!.form.get(`items[${index}][price]`))).size,
        ).toBe(3)
        const target = catalog.tiers.find((tier) => tier.tierId === "team")!
        expect([0, 1, 2].map((index) => request!.form.get(`items[${index}][price]`))).toEqual([
          target.basePriceId,
          target.usage.find((price) => price.meter === "commands")!.priceId,
          target.usage.find((price) => price.meter === "storageGb")!.priceId,
        ])
        expect(request!.form.get("items[3][price]")).toBeNull()
        expect(request!.form.get("items[0][quantity]")).toBe("1")
        expect(request!.form.get("items[1][quantity]")).toBeNull()
        expect(request!.form.get("billing_cycle_anchor")).toBe("unchanged")
        expect(request!.form.get("payment_behavior")).toBe("pending_if_incomplete")
        expect(request!.form.get("proration_behavior")).toBe("always_invoice")
        expect(request!.form.get("automatic_tax[enabled]")).toBeNull()
        expect(stripe.posts("/v1/subscriptions")).toHaveLength(0)
      }),
  )

  it.live("returns the old canonical tier when the immediate change invoice is declined", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.ensureCatalog),
        { tiers: plans },
      )
      stripe.subscriptionState.paymentDeclines = true
      const canonical = yield* run(stripe, change("team"), { tiers: plans })
      expect(canonical.tierId).toBe("pro")
      expect(canonical.subscriptionId).toBe("sub_1")
    }),
  )

  it.live("refuses customer mismatch or an unprepared target catalog before updating", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      expect(yield* fail(stripe, change("team", "cus_other"), { tiers: plans })).toEqual(
        UnknownSubscription.make({ subscriptionId: "sub_1" }),
      )
      expect(yield* fail(stripe, change("team"), { tiers: plans })).toEqual(
        CatalogNotReady.make({ tierId: "team" }),
      )
      expect(stripe.posts("/v1/subscriptions/sub_1")).toHaveLength(0)
    }),
  )

  it.live("refuses unmanaged, duplicate, incomplete, or tax-disabled subscription items", () =>
    Effect.gen(function* () {
      const valid = subscription("sub_1", "cus_known", "active")
      const invalid = [
        { ...valid, automatic_tax: { enabled: false } },
        { ...valid, items: { ...valid.items, has_more: true } },
        { ...valid, items: { ...valid.items, data: valid.items.data.slice(0, 1) } },
        {
          ...valid,
          items: {
            ...valid.items,
            data: [valid.items.data[0]!, valid.items.data[0]!, valid.items.data[1]!],
          },
        },
        {
          ...valid,
          items: {
            ...valid.items,
            data: valid.items.data.map((item) => ({
              ...item,
              price: { ...item.price, product: "prod_not_ours" },
            })),
          },
        },
      ]
      for (const snapshot of invalid) {
        const stripe = makeStripe()
        stripe.failures.push(json(200, snapshot))
        expect(yield* fail(stripe, change("team"), { tiers: plans })).toBeInstanceOf(
          BillingProviderError,
        )
        expect(stripe.posts("/v1/subscriptions/sub_1")).toHaveLength(0)
      }
    }),
  )
})

describe("reading billing state", () => {
  it.live("keeps a pending initial-payment subscription canonical until it expires", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.subscriptionState.active = true
      stripe.subscriptionState.status = "incomplete"
      const pending = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.billingDetails("cus_known")),
      )
      expect(pending.subscription?.status).toBe("incomplete")
      stripe.subscriptionState.status = "incomplete_expired"
      const expired = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.billingDetails("cus_known")),
      )
      expect(expired.subscription).toBeNull()
    }),
  )
  it.live(
    "finds an active subscription beyond newer canceled subscriptions and blocks duplicate checkout",
    () =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        stripe.subscriptionState.active = true
        stripe.subscriptionState.paginated = true
        const details = yield* run(
          stripe,
          StripeBilling.use((billing) => billing.billingDetails("cus_known")),
        )
        expect(details.subscription?.subscriptionId).toBe("sub_1")
        expect(
          stripe.requests.some(
            (entry) =>
              entry.url.pathname === "/v1/subscriptions" &&
              entry.url.searchParams.get("starting_after") === "sub_newer_canceled",
          ),
        ).toBe(true)
        const failure = yield* fail(
          stripe,
          StripeBilling.use((billing) =>
            billing.startCheckout({
              organizationId: "org_1",
              customerId: "cus_known",
              tierId: "pro",
              idempotencyKey: "new-checkout",
              successUrl: "https://app.test/ok",
              cancelUrl: "https://app.test/no",
            }),
          ),
        )
        expect(failure).toMatchObject({ operation: "startCheckout", retryable: false })
        expect(stripe.posts("/v1/checkout/sessions")).toHaveLength(0)
      }),
  )

  it.live("refuses multiple current managed subscriptions rather than picking one", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.subscriptionState.active = true
      stripe.subscriptionState.multiple = true
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.billingDetails("cus_known")),
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
  it.live("returns details, the payment method and invoices", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.subscriptionState.active = true
      const state = yield* run(
        stripe,
        Effect.gen(function* () {
          const billing = yield* StripeBilling
          return {
            details: yield* billing.billingDetails("cus_known"),
            method: yield* billing.paymentMethod("cus_known"),
            invoices: yield* billing.invoices("cus_known", 5),
          }
        }),
      )

      expect(state.details.email).toBe("billing@example.com")
      expect(state.details.address?.postalCode).toBe("10115")
      expect(state.details.taxIds).toEqual([{ type: "eu_vat", value: "DE123456789" }])
      expect(state.details.subscription).toMatchObject({
        subscriptionId: "sub_1",
        tierId: "pro",
        status: "active",
      })
      expect(DateTime.toEpochMillis(state.details.subscription!.currentPeriodEnd!)).toBe(
        1_790_592_000_000,
      )
      expect(state.method).toEqual(
        CardPaymentMethod.make({
          id: "pm_1",
          brand: "visa",
          lastFour: "4242",
          expiryMonth: 7,
          expiryYear: 2031,
        }),
      )
      expect(state.invoices).toHaveLength(1)
      expect(state.invoices[0]).toMatchObject({
        id: "in_1",
        number: "AKT-0001",
        amountCents: 2750,
        status: "paid",
        pdfUrl: "https://pay.stripe.test/in_1.pdf",
      })
      expect(
        stripe.requests
          .find((entry) => entry.url.pathname === "/v1/invoices")!
          .url.searchParams.get("limit"),
      ).toBe("5")
    }),
  )

  describe("payment method", () => {
    const method = (setup: (stripe: ReturnType<typeof makeStripe>) => void) =>
      Effect.gen(function* () {
        const stripe = makeStripe()
        setup(stripe)
        return yield* run(
          stripe,
          StripeBilling.use((billing) => billing.paymentMethod("cus_known")),
        )
      })

    it.live("reports a Link account, with its email, when the customer's default is Link", () =>
      Effect.gen(function* () {
        expect(
          yield* method((stripe) => {
            stripe.paymentMethodState.customerDefault = "pm_link"
          }),
        ).toEqual(LinkPaymentMethod.make({ id: "pm_link", email: "ada@example.com" }))
      }),
    )

    it.live(
      "reports the Link account a customer has on file when Checkout set no customer default, as it does for Link",
      () =>
        Effect.gen(function* () {
          expect(
            yield* method((stripe) => {
              stripe.paymentMethodState.customerDefault = null
              stripe.paymentMethodState.listed = [linkMethod("pm_listed_link", "grace@example.com")]
            }),
          ).toEqual(LinkPaymentMethod.make({ id: "pm_listed_link", email: "grace@example.com" }))
        }),
    )

    it.live("reports a Link account without an email as such, not as no payment method", () =>
      Effect.gen(function* () {
        expect(
          yield* method((stripe) => {
            stripe.paymentMethodState.customerDefault = null
            stripe.paymentMethodState.listed = [linkMethod("pm_listed_link", null)]
          }),
        ).toEqual(LinkPaymentMethod.make({ id: "pm_listed_link", email: null }))
      }),
    )

    it.live("prefers a card on file to a Link account when there is no customer default", () =>
      Effect.gen(function* () {
        expect(
          yield* method((stripe) => {
            stripe.paymentMethodState.customerDefault = null
            stripe.paymentMethodState.listed = [
              linkMethod("pm_listed_link", "grace@example.com"),
              cardMethod("pm_listed_card"),
            ]
          }),
        ).toEqual(
          CardPaymentMethod.make({
            id: "pm_listed_card",
            brand: "visa",
            lastFour: "4242",
            expiryMonth: 7,
            expiryYear: 2031,
          }),
        )
      }),
    )

    it.live("reports none when the customer has neither a default nor a card or Link account", () =>
      Effect.gen(function* () {
        expect(
          yield* method((stripe) => {
            stripe.paymentMethodState.customerDefault = null
          }),
        ).toBeNull()
      }),
    )
  })

  it.live("reports an unknown customer", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.billingDetails("cus_missing")),
        ),
      ).toEqual(UnknownCustomer.make({ customerId: "cus_missing" }))
    }),
  )

  it.live("reconciles a subscription only for its own customer", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const canonical = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.reconcileSubscription("cus_known", "sub_canceled")),
      )

      expect(canonical).toMatchObject({
        subscriptionId: "sub_canceled",
        customerId: "cus_known",
        tierId: "pro",
        status: "canceled",
        cancelAtPeriodEnd: false,
      })
      expect(DateTime.toEpochMillis(canonical.currentPeriodEnd!)).toBe(1_790_592_000_000)
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.reconcileSubscription("cus_other", "sub_1")),
        ),
      ).toEqual(UnknownSubscription.make({ subscriptionId: "sub_1" }))
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.reconcileSubscription("cus_known", "sub_missing")),
        ),
      ).toEqual(UnknownSubscription.make({ subscriptionId: "sub_missing" }))
    }),
  )
})

describe("meter event streams", () => {
  const streamRequests = (stripe: ReturnType<typeof makeStripe>) =>
    stripe.requests.filter((entry) => entry.url.pathname === "/v2/billing/meter_event_stream")

  const StreamBody = Schema.fromJsonString(
    Schema.Struct({
      events: Schema.Array(
        Schema.Struct({
          identifier: Schema.String,
          event_name: Schema.String,
          timestamp: Schema.String,
          payload: Schema.Struct({ stripe_customer_id: Schema.String, value: Schema.String }),
        }),
      ),
    }),
  )

  const batchesOf = (stripe: ReturnType<typeof makeStripe>) =>
    Effect.forEach(streamRequests(stripe), (entry) => Schema.decodeEffect(StreamBody)(entry.body))

  it.live("splits 250 events into batches of 100 sent with the session token", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const at = yield* DateTime.now
      const receipt = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.recordUsage(usage(at, 250))),
      )
      const batches = yield* batchesOf(stripe)

      expect(receipt.batches).toBe(3)
      expect(receipt.identifiers).toHaveLength(250)
      expect(new Set(receipt.identifiers).size).toBe(250)
      expect(streamRequests(stripe)).toHaveLength(3)
      for (const entry of streamRequests(stripe)) {
        expect(entry.url.host).toBe(new URL(DEFAULT_METER_EVENTS_BASE_URL).host)
        expect(entry.authorization).toBe(`Bearer ${SESSION_TOKEN}`)
        expect(entry.authorization).not.toContain(API_KEY)
      }
      expect(stripe.posts("/v2/billing/meter_event_session")).toHaveLength(1)
      expect(stripe.posts("/v2/billing/meter_event_session")[0]!.authorization).toBe(
        `Bearer ${API_KEY}`,
      )
      expect(batches.map((batch) => batch.events.length)).toEqual([100, 100, 50])
      expect(batches.flatMap((batch) => batch.events.map((event) => event.identifier))).toEqual(
        receipt.identifiers,
      )
      expect(batches[0]!.events[0]).toMatchObject({
        event_name: "commands",
        timestamp: DateTime.formatIso(at),
        payload: { stripe_customer_id: "cus_known", value: "1" },
      })
    }),
  )

  it.live("derives identifiers from meter, customer and key alone", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const events = usage(yield* DateTime.now, 3, (index) => `period-${index}`)
      const first = yield* run(
        stripe,
        StripeBilling.use((billing) => billing.recordUsage(events)),
      )
      const replay = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.recordUsage(events.map((event) => ({ ...event, value: 999 }))),
        ),
      )
      const expected = yield* sha256("8:commands9:cus_knownperiod-0")

      expect(first.identifiers[0]).toBe(`akter_${expected}`)
      expect(replay.identifiers).toEqual(first.identifiers)
    }),
  )

  it.live("drops repeats of the same identifier within one report", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const at = yield* DateTime.now
      const receipt = yield* run(
        stripe,
        StripeBilling.use((billing) =>
          billing.recordUsage(usage(at, 150, (index) => `k${index % 50}`)),
        ),
      )

      expect(receipt.identifiers).toHaveLength(50)
      expect(receipt.batches).toBe(1)
    }),
  )

  it.live("preserves reads and tiny values while quantizing storage wire precision", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const at = yield* DateTime.now
      const [event] = usage(at, 1)
      const report = [
        { ...event!, key: "reads", value: 12.4 },
        { ...event!, meter: "storageGb", key: "storage", value: 0.21345 },
        { ...event!, key: "tiny", value: 0.0000001 },
        { ...event!, key: "whole", value: 3 },
        { ...event!, meter: "storageGb", key: "storage-hour", value: 53 / (1_000_000_000 * 744) },
        { ...event!, key: "very-tiny", value: 1e-20 },
      ]
      yield* run(
        stripe,
        StripeBilling.use((billing) => billing.recordUsage(report)),
      )
      const [batch] = yield* batchesOf(stripe)

      expect(batch!.events.map((entry) => [entry.event_name, entry.payload.value])).toEqual([
        ["commands", "12.4"],
        ["storageGb", "0.21345"],
        ["commands", "0.0000001"],
        ["commands", "3"],
        ["storageGb", "0.0000000000712365591397849"],
        ["commands", "0.00000000000000000001"],
      ])
    }),
  )

  it.live("refuses events outside the 35-day and 5-minute window, keeping the edges", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const now = yield* DateTime.now
      const [event] = usage(now, 1)
      const submit = (occurredAt: DateTime.Utc) =>
        run(
          stripe,
          StripeBilling.use((billing) => billing.recordUsage([{ ...event!, occurredAt }])),
        )
      const tooOld = DateTime.subtract(now, { days: 36 })
      const tooNew = DateTime.add(now, { minutes: 10 })

      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.recordUsage([{ ...event!, occurredAt: tooOld }])),
        ),
      ).toBeInstanceOf(BillingProviderError)
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.recordUsage([{ ...event!, occurredAt: tooNew }])),
        ),
      ).toBeInstanceOf(BillingProviderError)
      expect(streamRequests(stripe)).toHaveLength(0)
      expect((yield* submit(DateTime.subtract(now, { days: 34 }))).batches).toBe(1)
      expect((yield* submit(DateTime.add(now, { minutes: 2 }))).batches).toBe(1)
    }),
  )

  it.live("reuses a session while it is valid and replaces one that is about to expire", () =>
    Effect.gen(function* () {
      const twoCalls = (stripe: ReturnType<typeof makeStripe>) =>
        run(
          stripe,
          Effect.gen(function* () {
            const billing = yield* StripeBilling
            const at = yield* DateTime.now
            yield* billing.recordUsage(usage(at, 1, () => "a"))
            yield* billing.recordUsage(usage(at, 1, () => "b"))
          }),
        )
      const valid = makeStripe()
      const expiring = makeStripe()
      expiring.session.expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { seconds: 30 }),
      )
      yield* twoCalls(valid)
      yield* twoCalls(expiring)

      expect(valid.posts("/v2/billing/meter_event_session")).toHaveLength(1)
      expect(expiring.posts("/v2/billing/meter_event_session")).toHaveLength(2)
    }),
  )

  it.live("renews a rejected cached session once and resubmits the batch", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const receipt = yield* run(
        stripe,
        Effect.gen(function* () {
          const billing = yield* StripeBilling
          const at = yield* DateTime.now
          yield* billing.recordUsage(usage(at, 1, () => "a"))
          stripe.streamFailures.push(stripeError(401, "invalid_request_error", "expired"))
          return yield* billing.recordUsage(usage(at, 1, () => "b"))
        }),
      )
      const [, rejected, retried] = yield* batchesOf(stripe)

      expect(receipt.identifiers).toHaveLength(1)
      expect(stripe.posts("/v2/billing/meter_event_session")).toHaveLength(2)
      expect(streamRequests(stripe)).toHaveLength(3)
      expect(rejected!.events[0]!.identifier).toBe(receipt.identifiers[0])
      expect(retried!.events[0]!.identifier).toBe(receipt.identifiers[0])
    }),
  )

  it.live("does not retry a rejection of a brand-new session and drops it", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const outcome = yield* run(
        stripe,
        Effect.gen(function* () {
          const billing = yield* StripeBilling
          const at = yield* DateTime.now
          stripe.streamFailures.push(stripeError(400, "invalid_request_error", "bad_payload"))
          const failure = yield* Effect.flip(billing.recordUsage(usage(at, 1)))
          yield* billing.recordUsage(usage(at, 1))
          return failure
        }),
      )

      expect(outcome).toEqual(
        BillingProviderError.make({
          operation: "recordUsage",
          message: "Stripe InvalidRequestError",
          retryable: false,
        }),
      )
      expect(stripe.posts("/v2/billing/meter_event_session")).toHaveLength(2)
      expect(streamRequests(stripe)).toHaveLength(2)
    }),
  )

  it.live("refuses unknown meters and invalid values before calling Stripe", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      const [event] = usage(yield* DateTime.now, 1)

      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.recordUsage([{ ...event!, meter: "mystery" }])),
        ),
      ).toEqual(UnknownMeter.make({ meter: "mystery" }))
      expect(
        yield* fail(
          stripe,
          StripeBilling.use((billing) => billing.recordUsage([{ ...event!, value: -1 }])),
        ),
      ).toBeInstanceOf(BillingProviderError)
      expect(stripe.requests).toHaveLength(0)
      for (const value of [Number.MAX_SAFE_INTEGER + 1, 1_000_000_000_000_001]) {
        expect(
          yield* fail(
            stripe,
            StripeBilling.use((billing) => billing.recordUsage([{ ...event!, value }])),
          ),
        ).toMatchObject({ retryable: false })
      }
      expect(stripe.requests).toHaveLength(0)
    }),
  )
})

describe("webhooks", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.updated",
    created: 1_790_000_000,
    livemode: false,
    data: { object: { id: "sub_1", customer: "cus_known" } },
  })
  const verifyProgram = (payload: string, signature: string | null) =>
    StripeBilling.use((billing) => billing.verifyWebhook(payload, signature))
  const verify = (payload: string, signature: string | null) =>
    run(makeStripe(), verifyProgram(payload, signature))
  const rejection = (payload: string, signature: string | null) =>
    fail(makeStripe(), verifyProgram(payload, signature))
  const now = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

  it.live("accepts a correctly signed event", () =>
    Effect.gen(function* () {
      const header = yield* hmacHeader(Redacted.value(SECRET), body, yield* now)
      const result = yield* verify(body, header)

      expect(result).toMatchObject({
        id: "evt_1",
        type: "customer.subscription.updated",
        livemode: false,
        data: { id: "sub_1", customer: "cus_known" },
      })
    }),
  )

  it.live("produces the same header an independent HMAC does", () =>
    Effect.gen(function* () {
      const timestamp = yield* now
      expect(yield* signWebhook(SECRET, body, timestamp)).toBe(
        yield* hmacHeader(Redacted.value(SECRET), body, timestamp),
      )
    }),
  )

  it.live("rejects forged, tampered, stale and missing signatures", () =>
    Effect.gen(function* () {
      const forged = yield* hmacHeader("whsec_other", body, yield* now)
      const valid = yield* hmacHeader(Redacted.value(SECRET), body, yield* now)
      const stale = yield* hmacHeader(Redacted.value(SECRET), body, (yield* now) - 3600)

      for (const [payload, signature] of [
        [body, forged],
        [`${body} `, valid],
        [body, stale],
        [body, null],
        [body, "t=abc,v1=00"],
      ] as const) {
        expect(yield* rejection(payload, signature)).toBeInstanceOf(WebhookRejected)
      }
    }),
  )

  it.live("rejects a correctly signed body that is not a Stripe event", () =>
    Effect.gen(function* () {
      const notEvent = '{"hello":"world"}'
      const header = yield* hmacHeader(Redacted.value(SECRET), notEvent, yield* now)

      expect(yield* rejection(notEvent, header)).toEqual(
        WebhookRejected.make({ reason: "Payload is not a Stripe event" }),
      )
    }),
  )
})

describe("retry behavior", () => {
  const ensureCustomer = StripeBilling.use((billing) =>
    billing.ensureCustomer({ organizationId: "org_9", email: "r@example.com" }),
  )
  const apiError = () => stripeError(500, "api_error", "internal")

  it.live("retries a transient failure and repeats the same idempotency key", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.failures.push(
        json(200, { object: "list", data: [], has_more: false, url: "/v1/customers" }),
        apiError(),
      )
      const result = yield* run(stripe, ensureCustomer)
      const creates = stripe.posts("/v1/customers")

      expect(result.customerId).toMatch(/^cus_/)
      expect(creates).toHaveLength(2)
      expect(creates[0]!.idempotencyKey).toBe("akter:customer:org_9")
      expect(creates[1]!.idempotencyKey).toBe("akter:customer:org_9")
    }),
  )

  it.live("gives up after the policy is exhausted and reports a retryable provider error", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.failures.push(
        json(200, { object: "list", data: [], has_more: false, url: "/v1/customers" }),
        apiError(),
        apiError(),
        apiError(),
      )
      const result = yield* fail(stripe, ensureCustomer)

      expect(stripe.posts("/v1/customers")).toHaveLength(3)
      expect(result).toEqual(
        BillingProviderError.make({
          operation: "ensureCustomer",
          message: "Stripe ApiError",
          retryable: true,
        }),
      )
    }),
  )

  it.live("does not retry a rejected request", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.failures.push(
        json(200, { object: "list", data: [], has_more: false, url: "/v1/customers" }),
        stripeError(400, "invalid_request_error", "parameter_invalid_empty"),
      )
      const result = yield* fail(stripe, ensureCustomer)

      expect(stripe.posts("/v1/customers")).toHaveLength(1)
      expect(result).toEqual(
        BillingProviderError.make({
          operation: "ensureCustomer",
          message: "Stripe InvalidRequestError",
          retryable: false,
        }),
      )
    }),
  )

  it.live("applies Distilled's default policy when none is configured", () =>
    Effect.gen(function* () {
      const stripe = makeStripe()
      stripe.failures.push(
        json(200, { object: "list", data: [], has_more: false, url: "/v1/customers" }),
        apiError(),
      )
      const result = yield* run(stripe, ensureCustomer, { retry: undefined })

      expect(result.customerId).toMatch(/^cus_/)
      expect(stripe.posts("/v1/customers")).toHaveLength(2)
    }),
  )
})
