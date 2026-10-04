import {
  completeLocalCheckout,
  defaultPricingConfig,
  type PricingConfig,
  signWebhook,
} from "@akter/billing"
import * as Cloud from "@akter/cloud-api"
import { expect, it } from "@effect/vitest"
import { Clock, Crypto, DateTime, Effect, Exit, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { localBillingWebhookSecret } from "./config.ts"
import { isolatedLive, read, signupWith, testServer, type Requester } from "./fixtures.ts"
import {
  EventConflict,
  type MeterEvent,
  TenantUnbound,
  UsageActor,
  usageKey,
} from "./metering-actor.ts"

/** Pro's allowances are small enough for a few imported events to cross them, with overage priced at 50 cents per command. */
const pricing: PricingConfig = {
  ...defaultPricingConfig,
  tiers: defaultPricingConfig.tiers.map((tier) =>
    tier.id === "pro"
      ? {
          ...tier,
          includedCommands: 10,
          commandOverageCentsPerMillion: 50_000_000,
          includedStorageGb: 1,
        }
      : tier,
  ),
}

/** A billing summary of an organization with a billing account, whose plan has an id. */
const BoundSummary = Schema.Struct({ ...Cloud.BillingSummary.fields, plan: Cloud.Plan })

const webhookSecret = Redacted.make(localBillingWebhookSecret)

const PlanChange = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literals(["pending", "completed", "failed"]),
})

type Json = Schema.Json

interface AccountRow {
  readonly plan: string
  readonly subscribed_plan: string
  readonly payment_status: string
  readonly subscription_id: string | null
  readonly customer_id: string | null
  readonly spend_limit_cents: number | null
}

const eventually = <A, E, R>(step: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    let value = yield* step
    for (let attempt = 0; attempt < 300 && !done(value); attempt++) {
      yield* Effect.sleep("50 millis")
      value = yield* step
    }
    return value
  })

const sessionIdOf = (url: string) => url.slice(url.lastIndexOf("/") + 1)

const world = Effect.gen(function* () {
  const { request } = yield* testServer
  const sql = yield* SqlClient.SqlClient
  const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)
  const signup = signupWith({ request, sql, suffix })
  let counter = 0

  const status = (input: Parameters<Requester>[0]) =>
    request(input).pipe(Effect.map((response) => response.status))

  const organization = Effect.fn(function* (owner: { readonly cookie: string }, name: string) {
    const created = yield* request({
      path: "/api/organizations",
      method: "POST",
      cookie: owner.cookie,
      body: { name, slug: `${name.toLowerCase().replaceAll(" ", "-")}-${suffix}` },
    })
    expect(created.status).toBe(200)
    return (yield* read(created, Cloud.OrganizationMembership)).organization.id
  })

  const join = Effect.fn(function* (
    org: string,
    owner: { readonly cookie: string },
    member: { readonly email: string; readonly cookie: string },
  ) {
    const invited = yield* request({
      path: `/api/organizations/${org}/invitations`,
      method: "POST",
      cookie: owner.cookie,
      body: { email: member.email, role: "member" },
    })
    expect(invited.status).toBe(200)
    const accepted = yield* request({
      path: `/api/invitations/${(yield* read(invited, Cloud.Invitation)).id}/accept`,
      method: "POST",
      cookie: member.cookie,
    })
    expect(accepted.status).toBe(200)
  })

  const project = Effect.fn(function* (
    org: string,
    owner: { readonly cookie: string },
    slug: string,
  ) {
    const created = yield* request({
      path: `/api/organizations/${org}/projects`,
      method: "POST",
      cookie: owner.cookie,
      body: { name: slug, slug, homeRegion: "us-west-2" },
    })
    expect(created.status).toBe(200)
    return yield* read(created, Cloud.Project)
  })

  const readerKey = Effect.fn(function* (org: string, owner: { readonly cookie: string }) {
    const created = yield* request({
      path: `/api/organizations/${org}/api-keys`,
      method: "POST",
      cookie: owner.cookie,
      body: { name: "billing reader", permission: "read" },
    })
    expect(created.status).toBe(200)
    return (yield* read(created, Cloud.CreatedApiKey)).secret
  })

  const summary = Effect.fn(function* (org: string, cookie: string) {
    const response = yield* request({ path: `/api/organizations/${org}/billing`, cookie })
    expect(response.status).toBe(200)
    return yield* read(response, BoundSummary)
  })

  const membershipPlan = Effect.fn(function* (org: string, cookie: string) {
    const response = yield* request({ path: `/api/organizations/${org}`, cookie })
    expect(response.status).toBe(200)
    return (yield* read(response, Cloud.OrganizationMembership)).organization.plan
  })

  const account = (org: string) =>
    sql<AccountRow>`
      SELECT a.plan, s.subscribed_plan, a.payment_status, a.subscription_id, a.customer_id,
        a.spend_limit_cents::float8 AS spend_limit_cents
      FROM cloud_billing_account a
      JOIN cloud_billing_state s ON s.organization_id = a.organization_id
      WHERE a.organization_id = ${org}
    `.pipe(
      Effect.map(([row]) => row),
      Effect.orDie,
    )

  const providerCustomer = (org: string) =>
    sql<{
      readonly customer_id: string
      readonly email: string
      readonly name: string | null
    }>`SELECT customer_id, email, name FROM cloud_billing_customer WHERE organization_id = ${org}`.pipe(
      Effect.map(([row]) => row!),
      Effect.orDie,
    )

  const sessions = (org: string) =>
    sql<{
      readonly id: string
      readonly kind: string
      readonly tier_id: string | null
      readonly organization_id: string | null
      readonly customer_id: string
    }>`
      SELECT id, kind, tier_id, organization_id, customer_id FROM cloud_billing_session
      WHERE customer_id = (SELECT customer_id FROM cloud_billing_customer WHERE organization_id = ${org})
      ORDER BY created_at, id
    `.pipe(Effect.orDie)

  const events = (org: string) =>
    sql<{ readonly event_id: string; readonly event_type: string }>`
      SELECT event_id, event_type FROM cloud_billing_event WHERE actor_id = ${org} ORDER BY event_id
    `.pipe(Effect.orDie)

  const sequence = (org: string) =>
    sql<{ readonly reconcile: number; readonly applied: number }>`
      SELECT reconcile_seq::float8 AS reconcile, applied_seq::float8 AS applied
      FROM cloud_billing_state WHERE organization_id = ${org}
    `.pipe(
      Effect.map(([row]) => row!),
      Effect.orDie,
    )

  const stripeEvent = (
    id: string,
    type: string,
    object: { readonly [key: string]: Json },
    created: number,
  ) => JSON.stringify({ id, object: "event", type, created, livemode: false, data: { object } })

  const unixSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

  const post = (payload: string, signature: string | null) =>
    request({
      path: "/api/billing/webhook",
      method: "POST",
      raw: payload,
      headers: signature === null ? {} : { "stripe-signature": signature },
    })

  const signedPost = Effect.fn(function* (payload: string, timestamp?: number) {
    return yield* post(
      payload,
      yield* signWebhook(webhookSecret, payload, timestamp ?? (yield* unixSeconds)),
    )
  })

  const eventId = () => `evt_${suffix}_${(counter += 1)}`

  const deliver = Effect.fn(function* (
    org: string,
    type: string,
    object: { readonly [key: string]: Json },
    created?: number,
  ) {
    const id = eventId()
    const response = yield* signedPost(
      stripeEvent(id, type, object, created ?? (yield* unixSeconds)),
    )
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ received: true })
    const queued = (yield* sequence(org)).reconcile
    const settled = yield* eventually(sequence(org), (row) => row.applied >= queued)
    expect(settled.applied).toBeGreaterThanOrEqual(queued)
    return id
  })

  const checkout = Effect.fn(function* (
    org: string,
    cookie: string,
    plan: "pro" | "team",
    key: string,
  ) {
    const response = yield* request({
      path: `/api/organizations/${org}/billing/checkout`,
      method: "POST",
      cookie,
      headers: { "idempotency-key": key },
      body: { plan },
    })
    expect(response.status).toBe(200)
    return (yield* read(response, Cloud.HostedSession)).url
  })

  const subscribe = Effect.fn(function* (
    org: string,
    cookie: string,
    plan: "pro" | "team",
    key: string,
  ) {
    const sessionId = sessionIdOf(yield* checkout(org, cookie, plan, key))
    const path = `/billing/checkout/${sessionId}`
    const page = yield* request({ path })
    expect(page.status).toBe(200)
    expect(yield* page.json).toEqual({
      mode: "local",
      id: sessionId,
      plan,
      automaticTax: true,
      complete: "POST this session URL to complete the local checkout",
    })
    const completed = yield* request({ path, method: "POST" })
    expect(completed.status).toBe(200)
    const completion = yield* read(
      completed,
      Schema.Struct({
        completed: Schema.Literal(true),
        subscriptionId: Schema.String,
        returnUrl: Schema.String,
      }),
    )
    expect(completion.returnUrl).toBe("http://localhost:3001/settings/billing")
    expect((yield* eventually(account(org), (row) => row?.plan === plan))?.plan).toBe(plan)
    const [stored] = yield* sql<{ readonly subscription_id: string; readonly customer_id: string }>`
      SELECT subscription_id, customer_id FROM cloud_billing_subscription
      WHERE customer_id = (SELECT customer_id FROM cloud_billing_customer WHERE organization_id = ${org})
        AND status = 'active'
    `.pipe(Effect.orDie)
    expect(stored).toBeDefined()
    expect(completion.subscriptionId).toBe(stored!.subscription_id)
    const subscription = {
      subscriptionId: stored!.subscription_id,
      customerId: stored!.customer_id,
    }
    return { sessionId, subscription }
  })

  return {
    request,
    sql,
    suffix,
    signup,
    status,
    organization,
    join,
    project,
    readerKey,
    summary,
    membershipPlan,
    account,
    providerCustomer,
    sessions,
    events,
    sequence,
    stripeEvent,
    unixSeconds,
    post,
    signedPost,
    eventId,
    deliver,
    checkout,
    subscribe,
  }
})

const HOUR = 3_600_000

const september = (day: number, hour: number) => Date.UTC(2026, 8, day, hour)

const command = (eventId: string, hour: number): typeof MeterEvent.Type => ({
  kind: "command",
  eventId,
  actorType: "Room",
  actorId: "r1",
  commandId: `cmd-${eventId}`,
  requestToken: null,
  hour,
})

const readEvent = (eventId: string, hour: number): typeof MeterEvent.Type => ({
  kind: "read",
  eventId,
  actorType: "Room",
  actorId: "r1",
  commandId: null,
  requestToken: `token-${eventId}`,
  hour,
})

const storageEvent = (
  eventId: string,
  hour: number,
  storageByteHours: number,
): typeof MeterEvent.Type => ({
  kind: "storage",
  eventId,
  hour,
  storageByteHours,
})

it.layer(isolatedLive({ pricing }), { excludeTestServices: true })(
  "billing over the real API, Better Auth sessions and the SQL-backed local Stripe",
  (it) => {
    it.effect(
      "changes plans only from the provider's current state, however the signed webhooks arrive",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const alice = yield* w.signup("alice")
          const bob = yield* w.signup("bob")
          const outsider = yield* w.signup("outsider")
          const org = yield* w.organization(alice, "Billing org")
          yield* w.join(org, alice, bob)
          const base = `/api/organizations/${org}/billing`
          const key = yield* w.readerKey(org, alice)

          const free = yield* w.summary(org, alice.cookie)
          expect(free.plan).toMatchObject({
            id: "free",
            name: "Free",
            basePriceCents: 0,
            renewsAt: null,
            monthToDateEstimateCents: 0,
          })
          expect(free.paymentMethod).toBeNull()
          expect(free.spendLimit).toEqual({ limitCents: null, currentSpendCents: 0 })
          expect((yield* w.summary(org, bob.cookie)).plan.id).toBe("free")
          expect((yield* w.request({ path: base, key })).status).toBe(200)
          expect(yield* w.membershipPlan(org, alice.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "free" }),
          )

          const denied = yield* Effect.forEach(
            [{ cookie: bob.cookie }, { cookie: outsider.cookie }, { key }, {}],
            (who) =>
              Effect.all([
                w.status({
                  path: `${base}/checkout`,
                  method: "POST",
                  body: { plan: "pro" },
                  ...who,
                }),
                w.status({ path: `${base}/portal`, method: "POST", ...who }),
                w.status({
                  path: `${base}/spend-limit`,
                  method: "PUT",
                  body: { limitCents: 1 },
                  ...who,
                }),
                w.status({ path: `${base}/plan`, method: "POST", body: { plan: "team" }, ...who }),
              ]),
          )
          expect(denied).toEqual([
            [403, 403, 403, 403],
            [403, 403, 403, 403],
            [403, 403, 403, 403],
            [401, 401, 401, 401],
          ])
          expect(yield* w.sessions(org)).toEqual([])
          expect((yield* w.account(org))?.spend_limit_cents ?? null).toBeNull()

          const invalid = yield* Effect.all([
            w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              body: { plan: "free" },
            }),
            w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              body: { plan: "gold" },
            }),
            w.status({
              path: `${base}/spend-limit`,
              method: "PUT",
              cookie: alice.cookie,
              body: { limitCents: -1 },
            }),
            w.status({
              path: `${base}/spend-limit`,
              method: "PUT",
              cookie: alice.cookie,
              body: { limitCents: 1.5 },
            }),
          ])
          expect(invalid).toEqual([400, 400, 400, 400])

          const proUrl = yield* w.checkout(org, alice.cookie, "pro", "pro-once")
          expect(proUrl).toMatch(
            /^http:\/\/localhost:3001\/billing\/checkout\/cs_local_[0-9a-f]{32}$/u,
          )
          expect(yield* w.checkout(org, alice.cookie, "pro", "pro-once")).toBe(proUrl)
          expect(
            yield* w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              headers: { "idempotency-key": "pro-twice" },
              body: { plan: "pro" },
            }),
          ).toBe(409)
          expect(
            yield* w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              headers: { "idempotency-key": "pro-once" },
              body: { plan: "team" },
            }),
          ).toBe(409)
          const customer = yield* w.providerCustomer(org)
          expect(customer).toMatchObject({ email: alice.email, name: "Billing org" })
          expect(yield* w.sessions(org)).toEqual([
            {
              id: sessionIdOf(proUrl),
              kind: "checkout",
              tier_id: "pro",
              organization_id: org,
              customer_id: customer.customer_id,
            },
          ])
          const [captured] = yield* w.sql<{
            readonly params: Json
          }>`SELECT params FROM cloud_billing_session WHERE id = ${sessionIdOf(proUrl)}`
          expect(captured?.params).toEqual({
            customer: customer.customer_id,
            success_url: "http://localhost:3001/settings/billing",
            cancel_url: "http://localhost:3001/settings/billing",
            base_price_cents: 2_500,
            currency: "usd",
            automatic_tax: { enabled: true },
            customer_update: { address: "auto", name: "auto" },
            tax_id_collection: { enabled: true },
            subscription_data: {
              billing_cycle_anchor_config: { day_of_month: 1, hour: 0, minute: 0, second: 0 },
              proration_behavior: "none",
            },
            metadata: {
              akter_organization_id: org,
              akter_tier: "pro",
              akter_request: `${org}:pro-once`,
            },
          })
          expect(yield* w.account(org)).toMatchObject({
            plan: "free",
            customer_id: customer.customer_id,
            payment_status: "free",
            subscription_id: null,
          })
          expect((yield* w.summary(org, alice.cookie)).plan.id).toBe("free")

          const completionStartedAt = yield* Clock.currentTimeMillis
          const subscription = yield* completeLocalCheckout(sessionIdOf(proUrl)).pipe(Effect.orDie)
          const completionEndedAt = yield* Clock.currentTimeMillis
          expect(subscription).toMatchObject({
            tierId: "pro",
            status: "active",
            customerId: customer.customer_id,
          })
          yield* Effect.sleep("300 millis")
          expect((yield* w.account(org))?.plan).toBe("free")
          expect((yield* w.summary(org, alice.cookie)).plan.id).toBe("free")

          const claimed = {
            object: "subscription",
            id: subscription.subscriptionId,
            customer: customer.customer_id,
            status: "active",
          }
          const payload = w.stripeEvent(
            "evt_forged",
            "customer.subscription.created",
            claimed,
            yield* w.unixSeconds,
          )
          const tampered = w.stripeEvent(
            "evt_forged",
            "customer.subscription.created",
            { ...claimed, customer: "cus_other" },
            yield* w.unixSeconds,
          )
          const now = yield* w.unixSeconds
          const forged = yield* Effect.all([
            w.post(payload, null),
            w.post(payload, "t=1,v1=00"),
            w.post(
              payload,
              yield* signWebhook(Redacted.make("whsec_forged_by_an_attacker"), payload, now),
            ),
            w.post(tampered, yield* signWebhook(webhookSecret, payload, now)),
            w.post(payload, yield* signWebhook(webhookSecret, payload, now - 3_600)),
          ]).pipe(Effect.map((all) => all.map((response) => response.status)))
          expect(forged).toEqual([400, 400, 400, 400, 400])
          expect((yield* w.post("x".repeat(1_048_577), null)).status).toBe(413)
          const unbound = yield* w.signedPost(
            w.stripeEvent(
              w.eventId(),
              "customer.subscription.created",
              { ...claimed, customer: "cus_local_nobody" },
              now,
            ),
          )
          expect(unbound.status).toBe(503)
          const unrelated = yield* w.signedPost(
            w.stripeEvent(w.eventId(), "product.created", { object: "product", id: "prod_x" }, now),
          )
          expect(unrelated.status).toBe(200)
          yield* Effect.sleep("300 millis")
          expect(yield* w.events(org)).toEqual([])
          expect(yield* w.sequence(org)).toEqual({ reconcile: 0, applied: 0 })
          expect((yield* w.account(org))?.plan).toBe("free")
          expect((yield* w.summary(org, alice.cookie)).plan.id).toBe("free")

          const created = yield* w.deliver(org, "customer.subscription.created", {
            ...claimed,
            status: "canceled",
            plan: "enterprise",
            metadata: { organizationId: "org_someone_else", plan: "enterprise" },
          })
          expect(yield* w.account(org)).toMatchObject({
            plan: "pro",
            subscribed_plan: "pro",
            payment_status: "active",
            subscription_id: subscription.subscriptionId,
          })
          const pro = yield* w.summary(org, alice.cookie)
          expect(pro.plan).toMatchObject({
            id: "pro",
            name: "Pro",
            basePriceCents: 2_500,
            monthToDateEstimateCents: 2_500,
          })
          expect(pro.plan.renewsAt).not.toBeNull()
          expect(pro.paymentMethod).toEqual({
            brand: "visa",
            lastFour: "4242",
            expiryMonth: 7,
            expiryYear: 2036,
          })
          expect(pro.billingEmail).toBe(alice.email)
          yield* w.sql`UPDATE cloud_billing_payment_method SET brand = 'mastercard', last_four = '8675', expiry_month = 11, expiry_year = 2037 WHERE customer_id = ${customer.customer_id}`
          expect((yield* w.summary(org, bob.cookie)).paymentMethod).toEqual({
            brand: "mastercard",
            lastFour: "8675",
            expiryMonth: 11,
            expiryYear: 2037,
          })
          expect(yield* w.membershipPlan(org, bob.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "pro" }),
          )
          expect(yield* w.events(org)).toEqual([
            { event_id: created, event_type: "customer.subscription.created" },
          ])

          const replay = yield* w.signedPost(
            w.stripeEvent(
              created,
              "customer.subscription.created",
              { ...claimed, status: "canceled" },
              now,
            ),
          )
          expect(replay.status).toBe(200)
          yield* Effect.sleep("300 millis")
          expect((yield* w.events(org)).length).toBe(1)
          expect(yield* w.sequence(org)).toEqual({ reconcile: 1, applied: 1 })

          const limit = yield* w.request({
            path: `${base}/spend-limit`,
            method: "PUT",
            cookie: alice.cookie,
            body: { limitCents: 7_000 },
          })
          expect(limit.status).toBe(200)
          expect(yield* read(limit, Cloud.SpendLimit)).toEqual({
            limitCents: 7_000,
            currentSpendCents: 2_500,
          })
          expect((yield* w.account(org))?.spend_limit_cents).toBe(7_000)
          expect((yield* w.summary(org, bob.cookie)).spendLimit.limitCents).toBe(7_000)

          const invoices = yield* w.request({ path: `${base}/invoices`, cookie: alice.cookie })
          expect(invoices.status).toBe(200)
          const invoiceRows = yield* read(invoices, Schema.Array(Cloud.Invoice))
          expect(invoiceRows).toHaveLength(1)
          const hash = Hex.encode(
            yield* (yield* Crypto.Crypto).digest(
              "SHA-256",
              new TextEncoder().encode(sessionIdOf(proUrl)),
            ),
          ).slice(0, 24)
          expect(invoiceRows[0]).toMatchObject({
            id: `in_local_${hash}`,
            number: `LOCAL-${hash}`,
            amountCents: 2_500,
            currency: "usd",
            status: "paid",
            pdfUrl: `http://localhost:3001/billing/invoices/in_local_${hash}/pdf`,
          })
          const pdf = yield* w.request({ path: new URL(invoiceRows[0]!.pdfUrl!).pathname })
          expect(pdf.status).toBe(200)
          expect(pdf.headers["content-type"]).toBe("application/pdf")
          const document = new TextDecoder().decode(yield* pdf.arrayBuffer.pipe(Effect.orDie))
          expect(document.startsWith("%PDF-1.4\n")).toBe(true)
          expect(document).toContain(`(Invoice LOCAL-${hash}) Tj`)
          expect(document).toContain("(Amount 25.00 USD) Tj")
          expect(document.endsWith("%%EOF\n")).toBe(true)
          expect(
            yield* w.status({ path: `/billing/invoices/in_local_${"0".repeat(24)}/pdf` }),
          ).toBe(404)
          const calendarPeriods = [completionStartedAt, completionEndedAt].map((millis) => {
            const completedAt = DateTime.toParts(DateTime.makeUnsafe(millis))
            return [
              Date.UTC(completedAt.year, completedAt.month, 1),
              Date.UTC(completedAt.year, completedAt.month + 1, 1),
            ]
          })
          expect(calendarPeriods).toContainEqual([
            DateTime.toEpochMillis(invoiceRows[0]!.periodStart),
            DateTime.toEpochMillis(invoiceRows[0]!.periodEnd),
          ])
          expect(DateTime.toEpochMillis(pro.plan.renewsAt!)).toBe(
            DateTime.toEpochMillis(invoiceRows[0]!.periodStart),
          )
          yield* w.sql`INSERT INTO cloud_billing_invoice (id, checkout_id, customer_id, number, period_start, period_end, amount_cents, currency)
            VALUES ('in_fixture_' || ${w.suffix}, 'cs_fixture_' || ${w.suffix}, ${customer.customer_id}, 'LOCAL-SEED-781', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 7_813, 'usd')`
          const seededInvoices = yield* read(
            yield* w.request({ path: `${base}/invoices`, cookie: bob.cookie }),
            Schema.Array(Cloud.Invoice),
          )
          expect(seededInvoices).toHaveLength(2)
          const seeded = seededInvoices.find((invoice) => invoice.id === `in_fixture_${w.suffix}`)!
          expect(seeded).toMatchObject({
            number: "LOCAL-SEED-781",
            amountCents: 7_813,
            currency: "usd",
            status: "paid",
            pdfUrl: `http://localhost:3001/billing/invoices/in_fixture_${w.suffix}/pdf`,
          })
          expect(DateTime.formatIso(seeded.periodStart)).toBe("2026-01-01T00:00:00.000Z")
          expect(DateTime.formatIso(seeded.periodEnd)).toBe("2026-02-01T00:00:00.000Z")
          expect(yield* w.status({ path: `${base}/invoices`, cookie: outsider.cookie })).toBe(403)

          const portal = yield* w.request({
            path: `${base}/portal`,
            method: "POST",
            cookie: alice.cookie,
            headers: { "idempotency-key": "portal-once" },
          })
          expect(portal.status).toBe(200)
          const portalUrl = (yield* read(portal, Cloud.HostedSession)).url
          expect(portalUrl).toMatch(
            /^http:\/\/localhost:3001\/billing\/portal\/bps_local_[0-9a-f]{32}$/u,
          )
          const portalPage = yield* w.request({ path: new URL(portalUrl).pathname })
          expect(portalPage.status).toBe(200)
          expect(yield* portalPage.json).toEqual({
            mode: "local",
            id: sessionIdOf(portalUrl),
            features: ["payment-method", "billing-details", "invoices", "cancellation"],
            planChanges: "Use POST /api/organizations/:organizationId/billing/plan",
          })
          const again = yield* w.request({
            path: `${base}/portal`,
            method: "POST",
            cookie: alice.cookie,
            headers: { "idempotency-key": "portal-once" },
          })
          expect((yield* read(again, Cloud.HostedSession)).url).toBe(portalUrl)
          expect((yield* w.sessions(org)).filter((row) => row.kind === "portal")).toEqual([
            {
              id: sessionIdOf(portalUrl),
              kind: "portal",
              tier_id: null,
              organization_id: null,
              customer_id: customer.customer_id,
            },
          ])

          const beforeUpgrade = yield* w.sessions(org)
          expect(
            yield* w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              headers: { "idempotency-key": "team-once" },
              body: { plan: "team" },
            }),
          ).toBe(409)
          expect(yield* w.sessions(org)).toEqual(beforeUpgrade)
          const upgrade = yield* w.request({
            path: `${base}/plan`,
            method: "POST",
            cookie: alice.cookie,
            headers: { "idempotency-key": "upgrade-team" },
            body: { plan: "team" },
          })
          expect(upgrade.status).toBe(200)
          const upgradeRequest = yield* read(upgrade, PlanChange)
          expect(upgradeRequest.requestId).toBe("upgrade-team")
          expect(upgradeRequest.status).not.toBe("failed")
          const providerTier = w.sql<{
            readonly tier_id: string
          }>`SELECT tier_id FROM cloud_billing_subscription WHERE subscription_id = ${subscription.subscriptionId}`.pipe(
            Effect.map(([row]) => row?.tier_id),
            Effect.orDie,
          )
          expect(yield* eventually(providerTier, (tier) => tier === "team")).toBe("team")
          yield* w.deliver(org, "customer.subscription.updated", {
            object: "subscription",
            id: subscription.subscriptionId,
            customer: customer.customer_id,
            status: "canceled",
          })
          expect(yield* w.account(org)).toMatchObject({
            plan: "team",
            subscribed_plan: "team",
            payment_status: "active",
            subscription_id: subscription.subscriptionId,
            spend_limit_cents: 7_000,
          })
          expect((yield* w.summary(org, alice.cookie)).plan).toMatchObject({
            id: "team",
            basePriceCents: 24_900,
          })
          expect(yield* w.membershipPlan(org, alice.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "team" }),
          )
          const upgradeRetry = yield* w.request({
            path: `${base}/plan`,
            method: "POST",
            cookie: alice.cookie,
            headers: { "idempotency-key": "upgrade-team" },
            body: { plan: "team" },
          })
          expect(upgradeRetry.status).toBe(200)
          expect(yield* read(upgradeRetry, PlanChange)).toEqual({
            requestId: "upgrade-team",
            status: "completed",
          })

          expect(
            yield* w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: alice.cookie,
              headers: { "idempotency-key": "downgrade-once" },
              body: { plan: "pro" },
            }),
          ).toBe(409)
          expect(yield* w.sessions(org)).toEqual(beforeUpgrade)
          const downgrade = yield* w.request({
            path: `${base}/plan`,
            method: "POST",
            cookie: alice.cookie,
            headers: { "idempotency-key": "downgrade-pro" },
            body: { plan: "pro" },
          })
          expect(downgrade.status).toBe(200)
          const downgradeRequest = yield* read(downgrade, PlanChange)
          expect(downgradeRequest.requestId).toBe("downgrade-pro")
          expect(downgradeRequest.status).not.toBe("failed")
          expect(yield* eventually(providerTier, (tier) => tier === "pro")).toBe("pro")
          const olderThanEveryEvent = (yield* w.unixSeconds) - 86_400
          yield* w.deliver(
            org,
            "customer.subscription.updated",
            {
              object: "subscription",
              id: subscription.subscriptionId,
              customer: customer.customer_id,
            },
            olderThanEveryEvent,
          )
          expect(yield* w.account(org)).toMatchObject({
            plan: "pro",
            subscribed_plan: "pro",
            subscription_id: subscription.subscriptionId,
            spend_limit_cents: 7_000,
          })

          expect(
            yield* w.sql`SELECT subscription_id FROM cloud_billing_subscription WHERE customer_id = ${customer.customer_id}`,
          ).toEqual([{ subscription_id: subscription.subscriptionId }])

          yield* completeLocalCheckout(sessionIdOf(proUrl), "past_due").pipe(Effect.orDie)
          yield* w.deliver(org, "invoice.payment_failed", {
            object: "invoice",
            id: "in_failed",
            customer: customer.customer_id,
          })
          expect(yield* w.account(org)).toMatchObject({
            plan: "free",
            subscribed_plan: "pro",
            payment_status: "past_due",
            subscription_id: subscription.subscriptionId,
          })
          expect((yield* w.summary(org, alice.cookie)).plan.id).toBe("free")
          expect(yield* w.membershipPlan(org, bob.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "free" }),
          )

          yield* completeLocalCheckout(sessionIdOf(proUrl)).pipe(Effect.orDie)
          yield* w.deliver(org, "invoice.paid", {
            object: "invoice",
            id: "in_paid",
            customer: customer.customer_id,
          })
          expect(yield* w.account(org)).toMatchObject({ plan: "pro", payment_status: "active" })

          yield* completeLocalCheckout(sessionIdOf(proUrl), "canceled").pipe(Effect.orDie)
          yield* w.deliver(org, "customer.subscription.deleted", {
            object: "subscription",
            id: subscription.subscriptionId,
            customer: customer.customer_id,
            status: "active",
          })
          const canceled = yield* w.account(org)
          expect(canceled).toMatchObject({
            plan: "free",
            subscribed_plan: "free",
            payment_status: "canceled",
            subscription_id: null,
            spend_limit_cents: 7_000,
          })
          expect((yield* w.summary(org, alice.cookie)).plan).toMatchObject({
            id: "free",
            renewsAt: null,
          })

          const before = yield* w.sequence(org)
          const replayedGrant = yield* w.signedPost(payload.replace("evt_forged", created))
          expect(replayedGrant.status).toBe(200)
          const freshGrant = yield* w.deliver(org, "customer.subscription.created", claimed)
          expect(freshGrant).not.toBe(created)
          expect((yield* w.sequence(org)).reconcile).toBe(before.reconcile + 1)
          expect(yield* w.account(org)).toMatchObject({
            plan: "free",
            payment_status: "canceled",
            subscription_id: null,
          })
          expect((yield* w.summary(org, alice.cookie)).plan.id).toBe("free")
          expect(yield* w.membershipPlan(org, alice.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "free" }),
          )
        }),
      { timeout: 120_000 },
    )

    it.effect(
      "keeps each organization's customer, plan, spend limit and reads apart",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const alice = yield* w.signup("alice")
          const bob = yield* w.signup("bob")
          const a = yield* w.organization(alice, "Alpha")
          const b = yield* w.organization(bob, "Beta")
          const aKey = yield* w.readerKey(a, alice)
          const proA = yield* w.subscribe(a, alice.cookie, "pro", "alpha-pro")
          const checkoutB = yield* w.checkout(b, bob.cookie, "team", "beta-team")
          const customerA = yield* w.providerCustomer(a)
          const customerB = yield* w.providerCustomer(b)
          expect(customerA.customer_id).not.toBe(customerB.customer_id)
          expect(customerB.email).toBe(bob.email)

          yield* w.deliver(a, "customer.subscription.updated", {
            object: "subscription",
            id: proA.subscription.subscriptionId,
            customer: customerA.customer_id,
            metadata: { organizationId: b, plan: "team" },
          })
          yield* w.deliver(b, "customer.subscription.created", {
            object: "subscription",
            id: proA.subscription.subscriptionId,
            customer: customerB.customer_id,
            status: "active",
            metadata: { organizationId: a },
          })
          expect(yield* w.account(a)).toMatchObject({
            plan: "pro",
            subscription_id: proA.subscription.subscriptionId,
          })
          expect(yield* w.account(b)).toMatchObject({
            plan: "free",
            subscription_id: null,
            customer_id: customerB.customer_id,
          })
          expect((yield* w.summary(b, bob.cookie)).plan.id).toBe("free")
          expect(yield* w.membershipPlan(b, bob.cookie)).toEqual(
            Cloud.KnownPlan.make({ id: "free" }),
          )

          const sessionsB = yield* w.sessions(b)
          const limitBefore = (yield* w.account(b))?.spend_limit_cents ?? null
          const crossed = yield* Effect.forEach([{ cookie: alice.cookie }, { key: aKey }], (who) =>
            Effect.all([
              w.status({ path: `/api/organizations/${b}/billing`, ...who }),
              w.status({ path: `/api/organizations/${b}/billing/invoices`, ...who }),
              w.status({ path: `/api/organizations/${b}/usage`, ...who }),
              w.status({
                path: `/api/organizations/${b}/billing/checkout`,
                method: "POST",
                body: { plan: "pro" },
                ...who,
              }),
              w.status({ path: `/api/organizations/${b}/billing/portal`, method: "POST", ...who }),
              w.status({
                path: `/api/organizations/${b}/billing/spend-limit`,
                method: "PUT",
                body: { limitCents: 1 },
                ...who,
              }),
              w.status({
                path: `/api/organizations/${b}/billing/plan`,
                method: "POST",
                body: { plan: "team" },
                ...who,
              }),
            ]),
          )
          expect(crossed).toEqual([
            [403, 403, 403, 403, 403, 403, 403],
            [403, 403, 403, 403, 403, 403, 403],
          ])
          expect(yield* w.sessions(b)).toEqual(sessionsB)
          expect(sessionsB.map((row) => row.id)).toEqual([sessionIdOf(checkoutB)])
          expect((yield* w.account(b))?.spend_limit_cents ?? null).toBe(limitBefore)
          expect((yield* w.account(a))?.spend_limit_cents ?? null).toBeNull()
        }),
      { timeout: 120_000 },
    )

    it.effect(
      "releases an open checkout only after verified expiry of its bound session",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const owner = yield* w.signup("expiry-owner")
          const org = yield* w.organization(owner, "Expiry org")
          const base = `/api/organizations/${org}/billing`
          const url = yield* w.checkout(org, owner.cookie, "pro", "first-checkout")
          const customer = yield* w.providerCustomer(org)
          const sessionId = sessionIdOf(url)
          const another = () =>
            w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: owner.cookie,
              headers: { "idempotency-key": "replacement-checkout" },
              body: { plan: "team" },
            })
          expect(yield* another()).toBe(409)
          const now = yield* w.unixSeconds
          const forged = w.stripeEvent(
            w.eventId(),
            "checkout.session.expired",
            { object: "checkout.session", id: sessionId, customer: customer.customer_id },
            now,
          )
          expect((yield* w.post(forged, "t=1,v1=00")).status).toBe(400)
          expect(yield* another()).toBe(409)
          yield* w.deliver(org, "checkout.session.expired", {
            object: "checkout.session",
            id: "cs_local_00000000000000000000000000000000",
            customer: customer.customer_id,
          })
          expect(yield* another()).toBe(409)
          expect(yield* w.checkout(org, owner.cookie, "pro", "first-checkout")).toBe(url)
          yield* w.deliver(org, "checkout.session.expired", {
            object: "checkout.session",
            id: sessionId,
            customer: customer.customer_id,
          })
          expect((yield* w.request({ path: new URL(url).pathname, method: "POST" })).status).toBe(
            410,
          )
          expect(
            yield* w.status({
              path: `${base}/checkout`,
              method: "POST",
              cookie: owner.cookie,
              headers: { "idempotency-key": "first-checkout" },
              body: { plan: "pro" },
            }),
          ).toBe(409)
          const replacement = yield* w.checkout(org, owner.cookie, "team", "replacement-checkout")
          expect(replacement).not.toBe(url)
          expect((yield* w.account(org))?.plan).toBe("free")
          expect((yield* w.summary(org, owner.cookie)).plan.id).toBe("free")
          expect(
            yield* w.sql`SELECT subscription_id FROM cloud_billing_subscription WHERE customer_id = ${customer.customer_id}`,
          ).toEqual([])
        }),
      { timeout: 120_000 },
    )

    it.effect(
      "lists every plan from the pricing configuration, cheapest first and marked provisional, to any signed-in caller",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const alice = yield* w.signup("catalog")
          expect(yield* w.status({ path: "/api/billing/plans" })).toBe(401)
          const response = yield* w.request({ path: "/api/billing/plans", cookie: alice.cookie })
          expect(response.status).toBe(200)
          const catalog = yield* read(response, Cloud.PlanCatalog)
          expect(catalog.provisional).toBe(true)
          expect(catalog.readCommandWeight).toBe(0.2)
          expect(catalog.plans.map((plan) => plan.id)).toEqual([
            "free",
            "pro",
            "team",
            "enterprise",
          ])
          expect(catalog.plans[0]).toEqual({
            id: "free",
            name: "Free",
            basePriceCents: 0,
            currency: "usd",
            allowances: {
              commands: 1_000_000,
              commandCap: 1_000_000,
              storageGb: 0.5,
              concurrentConnections: 100,
            },
            overage: { commandCentsPerMillion: 0, storageCentsPerGbMonth: 0 },
            features: ["command-cap", "storage-cap"],
            provisional: false,
          })
          expect(catalog.plans[1]).toEqual({
            id: "pro",
            name: "Pro",
            basePriceCents: 2_500,
            currency: "usd",
            allowances: {
              commands: 10,
              commandCap: null,
              storageGb: 1,
              concurrentConnections: 5_000,
            },
            overage: { commandCentsPerMillion: 50_000_000, storageCentsPerGbMonth: 30 },
            features: ["command-overage", "storage-overage", "checkout"],
            provisional: true,
          })
        }),
      { timeout: 120_000 },
    )

    it.effect(
      "reports the usage the UsageActor imported per project against the organization's plan",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const alice = yield* w.signup("alice")
          const bob = yield* w.signup("bob")
          const outsider = yield* w.signup("outsider")
          const org = yield* w.organization(alice, "Usage org")
          const noise = yield* w.organization(outsider, "Noise org")
          yield* w.join(org, alice, bob)
          const first = yield* w.project(org, alice, "first")
          const second = yield* w.project(org, alice, "second")
          const elsewhere = yield* w.project(noise, outsider, "elsewhere")
          yield* w.subscribe(org, alice.cookie, "pro", "usage-pro")

          yield* w.sql`INSERT INTO deployment (id, primary_region) VALUES ('dep-1', 'us-east-1')`.pipe(
            Effect.orDie,
          )
          yield* Effect.forEach(
            [
              ["t1", org, first.id],
              ["t2", org, second.id],
              ["t3", noise, elsewhere.id],
            ] as const,
            ([tenant, organizationId, projectId]) =>
              w.sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
                VALUES (${"dep-1"}, ${tenant}, ${organizationId}, ${projectId})`,
            { discard: true },
          ).pipe(Effect.orDie)

          const importInto = (tenant: string, batch: ReadonlyArray<typeof MeterEvent.Type>) =>
            Effect.gen(function* () {
              const actor = yield* UsageActor.get(yield* usageKey("dep-1", tenant))
              return yield* actor.Import({ events: batch })
            })

          const day10 = september(10, 3)
          const firstBatch = [
            command("a1", day10),
            command("a2", day10),
            command("a3", day10),
            command("a4", day10 + HOUR),
            command("a5", day10 + HOUR),
            command("a6", september(11, 5)),
            command("a7", september(11, 5)),
            readEvent("a8", september(11, 5)),
            readEvent("a9", september(11, 5)),
          ]
          expect(yield* importInto("t1", firstBatch)).toEqual({
            imported: 9,
            duplicates: 0,
            late: [],
          })
          expect(
            yield* importInto("t2", [
              ...[1, 2, 3, 4, 5].map((n) => command(`b${n}`, day10)),
              storageEvent("b-storage", day10, 2_160_000_000_000),
            ]),
          ).toEqual({ imported: 6, duplicates: 0, late: [] })
          yield* importInto("t3", [
            command("c1", day10),
            command("c2", day10),
            command("c3", day10),
          ])
          expect(yield* importInto("t1", firstBatch)).toEqual({
            imported: 0,
            duplicates: 9,
            late: [],
          })
          expect(
            yield* importInto("t1", [
              command("a1", day10 + 2 * HOUR),
              command("fresh", day10),
            ]).pipe(Effect.exit),
          ).toEqual(Exit.fail(EventConflict.make({ eventId: "a1" })))
          expect(yield* importInto("ghost", [command("g1", day10)]).pipe(Effect.exit)).toEqual(
            Exit.fail(TenantUnbound.make({ deployment: "dep-1", tenant: "ghost" })),
          )

          const rows = yield* w.sql<{
            readonly project_id: string
            readonly commands: number
            readonly reads: number
          }>`SELECT project_id, sum(command_count)::int AS commands, sum(read_count)::int AS reads
            FROM cloud_usage_hour WHERE organization_id = ${org} GROUP BY project_id ORDER BY project_id`.pipe(
            Effect.orDie,
          )
          expect(rows).toHaveLength(2)
          expect(
            Object.fromEntries(rows.map((row) => [row.project_id, [row.commands, row.reads]])),
          ).toEqual({
            [first.id]: [7, 2],
            [second.id]: [5, 0],
          })

          const response = yield* w.request({
            path: `/api/organizations/${org}/usage?period=2026-09`,
            cookie: alice.cookie,
          })
          expect(response.status).toBe(200)
          const usage = yield* read(response, Cloud.Usage)
          expect(usage.period).toBe("2026-09")
          const meter = (name: string) =>
            usage.meters.find((candidate) => candidate.meter === name)!
          expect(meter("commands").used).toBeCloseTo(12.4, 9)
          expect(meter("commands").included).toBe(10)
          expect(meter("commands").overage).toBeCloseTo(2.4, 9)
          expect(meter("commands").overageCostCents).toBe(120)
          expect(meter("reads").used).toBe(2)
          expect(meter("storageGb").used).toBeCloseTo(3, 9)
          expect(meter("storageGb").included).toBe(1)
          expect(meter("storageGb").overageCostCents).toBe(60)
          expect(usage.commandsPerDay).toEqual([
            { day: "2026-09-10", commands: 10 },
            { day: "2026-09-11", commands: 2 },
          ])
          expect(usage.pricing).toMatchObject({ freeCommands: 1_000_000, readCommandWeight: 0.2 })
          const byProject = new Map(usage.byProject.map((entry) => [entry.projectId, entry]))
          expect([...byProject.keys()].sort()).toEqual([first.id, second.id].sort())
          expect(byProject.get(first.id)).toMatchObject({ name: "first", commands: 7, reads: 2 })
          expect(byProject.get(first.id)!.storageGbMonths).toBe(0)
          expect(byProject.get(second.id)).toMatchObject({ name: "second", commands: 5, reads: 0 })
          expect(byProject.get(second.id)!.storageGbMonths).toBeCloseTo(3, 9)
          const costs = [first.id, second.id].map((id) => byProject.get(id)!.estimatedCostCents)
          expect(costs[0]! + costs[1]!).toBe(180)
          const firstCost = first.id < second.id ? 71 : 72
          expect(costs).toEqual([firstCost, 180 - firstCost])

          const asMember = yield* w.status({
            path: `/api/organizations/${org}/usage?period=2026-09`,
            cookie: bob.cookie,
          })
          const asOutsider = yield* w.status({
            path: `/api/organizations/${org}/usage?period=2026-09`,
            cookie: outsider.cookie,
          })
          expect([asMember, asOutsider]).toEqual([200, 403])

          yield* w.sql`SELECT cloud_meter_storage_observe('dep-1', 't1', '2026-09-11T05:00:00Z', 1000)`
          yield* w.sql`SELECT cloud_meter_storage_observe('dep-1', 't3', '2026-09-12T00:00:00Z', 500000000)`
          yield* w.sql`INSERT INTO cloud_usage_account (organization_id, period, command_units, reserved_units)
            VALUES (${org}, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM'), 45, 5)
            ON CONFLICT (organization_id, period) DO UPDATE
            SET command_units = 45, reserved_units = 5`
          yield* w.sql`INSERT INTO cloud_connection_lease
            (lease_id, organization_id, deployment_id, tenant, kind, edge_id, expires_at)
            VALUES ('live-1', ${org}, 'dep-1', 't1', 'socket', 'edge-1', now() + interval '1 minute'),
              ('live-2', ${org}, 'dep-1', 't2', 'sse', 'edge-1', now() + interval '1 minute'),
              ('gone', ${org}, 'dep-1', 't1', 'socket', 'edge-1', now() - interval '1 second'),
              ('noise', ${noise}, 'dep-1', 't3', 'socket', 'edge-1', now() + interval '1 minute')`
          const limited = yield* w.request({
            path: `/api/organizations/${org}/billing/spend-limit`,
            method: "PUT",
            cookie: alice.cookie,
            body: { limitCents: 2_549 },
          })
          expect(limited.status).toBe(200)

          const now = yield* read(
            yield* w.request({
              path: `/api/organizations/${org}/usage?period=2026-08`,
              cookie: bob.cookie,
            }),
            Cloud.Usage,
          )
          expect(now.latestStorageSample).toEqual({
            bytes: 2_160_000_001_000,
            sampledAt: DateTime.makeUnsafe("2026-09-11T05:00:00Z"),
          })
          const caps = [
            {
              cap: "commands",
              limit: null,
              used: 50,
              atCap: false,
              refusing: false,
              unitsPerCommand: 5,
            },
            { cap: "spend", limit: 2_549, used: 2_500, atCap: false, refusing: true },
            { cap: "connections", limit: 5_000, used: 2, atCap: false, refusing: false },
            { cap: "storage", limit: null, used: 2_160_000_000_000, atCap: false, refusing: false },
          ]
          expect(now.caps).toEqual(caps)
          expect((yield* w.summary(org, bob.cookie)).caps).toEqual(caps)
          expect((yield* w.summary(noise, outsider.cookie)).caps).toEqual([
            {
              cap: "commands",
              limit: 5_000_000,
              used: 0,
              atCap: false,
              refusing: false,
              unitsPerCommand: 5,
            },
            { cap: "spend", limit: null, used: 0, atCap: false, refusing: false },
            { cap: "connections", limit: 100, used: 1, atCap: false, refusing: false },
            { cap: "storage", limit: 500_000_000, used: 500_000_000, atCap: true, refusing: true },
          ])

          yield* w.sql`INSERT INTO deployment (id, primary_region) VALUES ('dep-2', 'us-east-1')`
          yield* w.sql`UPDATE deployment SET serving = (id = 'dep-2') WHERE id IN ('dep-1', 'dep-2')`
          yield* w.sql`INSERT INTO cloud_meter_tenant (deployment_id, tenant, organization_id, project_id)
            VALUES ('dep-2', '*', ${noise}, ${elsewhere.id})`
          const storageOf = (organizationId: string, cookie: string) =>
            w
              .summary(organizationId, cookie)
              .pipe(Effect.map((summary) => summary.caps?.find((state) => state.cap === "storage")))
          expect(yield* storageOf(noise, outsider.cookie)).toEqual({
            cap: "storage",
            limit: 500_000_000,
            used: 0,
            atCap: false,
            refusing: false,
          })
          yield* w.sql`SELECT cloud_meter_storage_observe('dep-2', 't3', '2026-09-13T00:00:00Z', 499999999)`
          expect(yield* storageOf(noise, outsider.cookie)).toMatchObject({
            used: 499_999_999,
            refusing: false,
          })
          const redeployed = yield* read(
            yield* w.request({
              path: `/api/organizations/${org}/usage?period=2026-08`,
              cookie: bob.cookie,
            }),
            Cloud.Usage,
          )
          expect(redeployed.latestStorageSample).toBeNull()
          expect(redeployed.caps?.find((state) => state.cap === "storage")).toMatchObject({
            used: 0,
          })

          yield* w.sql`DELETE FROM cloud_billing_account WHERE organization_id = ${noise}`
          const unbound = yield* read(
            yield* w.request({
              path: `/api/organizations/${noise}/billing`,
              cookie: outsider.cookie,
            }),
            Cloud.BillingSummary,
          )
          expect(unbound.plan).toEqual(Cloud.UnboundPlan.make({}))
          const refusedAll = { limit: null, atCap: false, refusing: true, reason: "unbound" }
          expect(unbound.caps).toEqual([
            { cap: "commands", ...refusedAll, used: 0, unitsPerCommand: 5 },
            { cap: "spend", ...refusedAll, used: 0 },
            { cap: "connections", ...refusedAll, used: 1 },
            { cap: "storage", ...refusedAll, used: 499_999_999 },
          ])

          yield* w.sql`UPDATE cloud_billing_account SET plan = 'platinum' WHERE organization_id = ${org}`
          for (const path of [
            `/api/organizations/${org}/usage`,
            `/api/organizations/${org}/billing`,
          ]) {
            const refused = yield* w.request({ path, cookie: alice.cookie })
            expect(refused.status).toBe(503)
            expect(yield* read(refused, Cloud.Unavailable)).toMatchObject({
              message: "The organization's plan platinum is not in the pricing configuration",
            })
          }
          yield* w.sql`UPDATE cloud_billing_account SET plan = 'pro' WHERE organization_id = ${org}`

          const empty = yield* read(
            yield* w.request({
              path: `/api/organizations/${org}/usage?period=2026-08`,
              cookie: alice.cookie,
            }),
            Cloud.Usage,
          )
          expect(empty.byProject).toEqual([])
          expect(empty.meters.find((candidate) => candidate.meter === "commands")).toMatchObject({
            used: 0,
            overageCostCents: 0,
          })
        }),
      { timeout: 120_000 },
    )

    it.effect(
      "keeps org context loading for an unknown or unbound plan, tells an unknown plan from an outage, and refuses its spend limit before storing it",
      () =>
        Effect.gen(function* () {
          const w = yield* world
          const alice = yield* w.signup("plans")
          const org = yield* w.organization(alice, "Legacy plan")
          const other = yield* w.organization(alice, "Unbound plan")
          const base = `/api/organizations/${org}/billing`

          const plans = Effect.gen(function* () {
            const response = yield* w.request({ path: "/api/me", cookie: alice.cookie })
            expect(response.status).toBe(200)
            const me = yield* read(response, Cloud.Me)
            return Object.fromEntries(
              me.organizations.map(({ organization }) => [organization.id, organization.plan]),
            )
          })
          const activate = Effect.fn(function* (organizationId: string) {
            const response = yield* w.request({
              path: "/api/me/active-organization",
              method: "PUT",
              cookie: alice.cookie,
              body: { organizationId },
            })
            expect(response.status).toBe(200)
            return (yield* read(response, Cloud.OrganizationMembership)).organization.plan
          })
          const limit = (limitCents: number | null) =>
            w.request({
              path: `${base}/spend-limit`,
              method: "PUT",
              cookie: alice.cookie,
              body: { limitCents },
            })

          expect(yield* plans).toEqual({
            [org]: Cloud.KnownPlan.make({ id: "free" }),
            [other]: Cloud.KnownPlan.make({ id: "free" }),
          })
          expect((yield* limit(1_234)).status).toBe(200)

          yield* w.sql`UPDATE cloud_billing_account SET plan = 'legacy' WHERE organization_id = ${org}`
          expect((yield* plans)[org]).toEqual(Cloud.UnknownPlan.make({ id: "legacy" }))
          expect(yield* activate(org)).toEqual(Cloud.UnknownPlan.make({ id: "legacy" }))

          for (const path of [base, `/api/organizations/${org}/usage`]) {
            const refused = yield* w.request({ path, cookie: alice.cookie })
            expect(refused.status).toBe(503)
            expect(yield* read(refused, Cloud.Unavailable)).toMatchObject({
              message: "The organization's plan legacy is not in the pricing configuration",
              reason: "unknownPlan",
            })
          }

          for (const cents of [99, null]) {
            const refused = yield* limit(cents)
            expect(refused.status).toBe(503)
            expect(yield* read(refused, Cloud.Unavailable)).toMatchObject({ reason: "unknownPlan" })
          }
          expect(yield* w.account(org)).toMatchObject({ plan: "legacy", spend_limit_cents: 1_234 })
          const [state] = yield* w.sql<{ readonly cents: number | null }>`
            SELECT spend_limit_cents::float8 AS cents FROM cloud_billing_state
            WHERE organization_id = ${org}
          `
          expect(state?.cents).toBe(1_234)

          yield* w.sql`DELETE FROM cloud_billing_account WHERE organization_id = ${other}`
          expect((yield* plans)[other]).toEqual(Cloud.UnboundPlan.make({}))
          expect(yield* activate(other)).toEqual(Cloud.UnboundPlan.make({}))

          const unbound = yield* w.request({
            path: `/api/organizations/${other}/billing`,
            cookie: alice.cookie,
          })
          expect(unbound.status).toBe(200)
          const summary = yield* read(unbound, Cloud.BillingSummary)
          expect(summary.plan).toEqual(Cloud.UnboundPlan.make({}))
          expect(summary.paymentMethod).toBeNull()
          expect(summary.spendLimit).toEqual({ limitCents: null, currentSpendCents: 0 })
          expect(summary.caps?.find((state) => state.cap === "commands")).toEqual({
            cap: "commands",
            limit: null,
            used: 0,
            atCap: false,
            refusing: true,
            reason: "unbound",
            unitsPerCommand: 5,
          })
        }),
      { timeout: 120_000 },
    )
  },
)
