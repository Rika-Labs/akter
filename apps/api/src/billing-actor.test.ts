import {
  BillingProviderError,
  CatalogNotReady,
  CheckoutExpired,
  type BillingDetails,
  type BillingEvent,
  type HostedSession,
  PricingLive,
  type Subscription,
  StripeBilling,
  UnknownTier,
} from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@rikalabs/akter/testing"
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import {
  AccountNotInitialized,
  BillingActor,
  BillingActorLive,
  CheckoutBlocked,
  CustomerMismatch,
  CustomerNotBound,
  RequestConflict,
  NoActiveSubscription,
  UnboundCustomer,
  deliverWebhook,
} from "./billing-actor.ts"

/** A fresh database on the server at TEST_DATABASE_URL, dropped with the scope. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `api_billing_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

/**
 * The provider's side of the conversation, held by the test: what a customer
 * subscribes to and how calls fail, and every call the executors made. The
 * production actor keeps none of this in memory; only the provider fake does.
 */
const provider = {
  subscriptions: new Map<string, Subscription | null>(),
  sessions: new Map<string, string>(),
  changes: new Map<string, Subscription>(),
  changeStatus: "active" as Subscription["status"],
  failChange: false,
  failRead: false,
  failEnsure: false,
  failCheckout: undefined as
    | "retryable"
    | "unknown_tier"
    | "catalog_not_ready"
    | "expired"
    | undefined,
  checkoutGate: undefined as Deferred.Deferred<void> | undefined,
  customerFor: new Map<string, string>(),
  calls: {
    ensureCustomer: [] as Array<{
      organizationId: string
      email: string
      name?: string | undefined
    }>,
    startCheckout: [] as Array<{
      customerId: string
      tierId: string
      idempotencyKey?: string | undefined
    }>,
    openPortal: [] as Array<{ customerId: string; idempotencyKey?: string | undefined }>,
    billingDetails: [] as Array<string>,
    changeSubscription: [] as Array<{
      customerId: string
      subscriptionId: string
      tierId: string
      idempotencyKey?: string | undefined
    }>,
  },
}

const unused = Effect.die("not used by billing actor tests")

const FakeBilling = Layer.succeed(
  StripeBilling,
  StripeBilling.of({
    ensureCatalog: unused,
    ensureCustomer: (input) =>
      Effect.suspend(() => {
        provider.calls.ensureCustomer.push({
          organizationId: input.organizationId,
          email: input.email,
          name: input.name,
        })

        return provider.failEnsure
          ? Effect.fail(
              BillingProviderError.make({
                operation: "ensureCustomer",
                message: "provider down",
                retryable: true,
              }),
            )
          : Effect.succeed({
              customerId:
                provider.customerFor.get(input.organizationId) ?? `cus_${input.organizationId}`,
            })
      }),
    startCheckout: (input) =>
      Effect.suspend(
        (): Effect.Effect<
          HostedSession,
          BillingProviderError | UnknownTier | CatalogNotReady | CheckoutExpired
        > => {
          provider.calls.startCheckout.push({
            customerId: input.customerId,
            tierId: input.tierId,
            idempotencyKey: input.idempotencyKey,
          })

          if (provider.failCheckout === "unknown_tier")
            return Effect.fail(UnknownTier.make({ tierId: input.tierId }))

          if (provider.failCheckout === "catalog_not_ready")
            return Effect.fail(CatalogNotReady.make({ tierId: input.tierId }))

          if (provider.failCheckout === "expired")
            return Effect.fail(CheckoutExpired.make({ sessionId: `cs_${input.idempotencyKey}` }))

          if (provider.failCheckout === "retryable")
            return Effect.fail(
              BillingProviderError.make({
                operation: "startCheckout",
                message: "provider down",
                retryable: true,
              }),
            )

          const key = input.idempotencyKey ?? "none"
          const url = provider.sessions.get(key) ?? `https://pay.test/${key}`
          provider.sessions.set(key, url)

          return (provider.checkoutGate === undefined
            ? Effect.void
            : Deferred.await(provider.checkoutGate)
          ).pipe(Effect.as({ id: `cs_${key}`, url }))
        },
      ),
    openPortal: (input) =>
      Effect.sync(() => {
        provider.calls.openPortal.push({
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
        })

        return { id: "bps_1", url: `https://portal.test/${input.idempotencyKey}` }
      }),
    reconcileSubscription: () => unused,
    changeSubscription: (input) =>
      Effect.suspend(() => {
        provider.calls.changeSubscription.push(input)
        const key = input.idempotencyKey ?? "none"
        const changed = provider.changes.get(key) ?? {
          ...subscription(input.customerId, input.tierId, provider.changeStatus),
          subscriptionId: input.subscriptionId,
        }

        provider.changes.set(key, changed)
        provider.subscriptions.set(input.customerId, changed)

        return provider.failChange
          ? Effect.fail(
              BillingProviderError.make({
                operation: "changeSubscription",
                message: "reply lost after provider update",
                retryable: true,
              }),
            )
          : Effect.succeed(changed)
      }),
    billingDetails: (customerId) =>
      Effect.suspend(() => {
        provider.calls.billingDetails.push(customerId)

        if (provider.failRead)
          return Effect.fail(
            BillingProviderError.make({
              operation: "billingDetails",
              message: "provider read unavailable",
              retryable: true,
            }),
          )

        const details: BillingDetails = {
          customerId,
          email: null,
          name: null,
          address: null,
          taxIds: [],
          subscription: provider.subscriptions.get(customerId) ?? null,
        }

        return Effect.succeed(details)
      }),
    paymentMethod: () => unused,
    invoices: () => unused,
    recordUsage: () => unused,
    verifyWebhook: () => unused,
  }),
)

class DatabaseUrl extends Context.Service<DatabaseUrl, Redacted.Redacted<string>>()(
  "@akter/api/billing-actor.test/DatabaseUrl",
) {}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* database

    return Layer.mergeAll(BillingActorLive(), Layer.succeed(DatabaseUrl, url)).pipe(
      Layer.provide(Layer.merge(PricingLive(), FakeBilling)),
      Layer.provideMerge(ActorTest.layer({ database: url })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

afterEach(() => {
  provider.failEnsure = false
  if (provider.checkoutGate !== undefined) Deferred.doneUnsafe(provider.checkoutGate, Effect.void)
  provider.checkoutGate = undefined
  provider.failCheckout = undefined
  provider.customerFor.clear()
  provider.changeStatus = "active"
  provider.failChange = false
  provider.failRead = false
})

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

interface AccountRow {
  readonly plan: string
  readonly subscribed_plan: string
  readonly spend_limit_cents: number | null
  readonly customer_id: string | null
  readonly billing_email: string | null
  readonly subscription_id: string | null
  readonly payment_status: string
  readonly provider_updated_at: number
}

const accountRow = (organizationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<AccountRow>`
      SELECT plan, subscribed_plan, spend_limit_cents::float8 AS spend_limit_cents, customer_id, billing_email,
        subscription_id, payment_status, provider_updated_at::float8 AS provider_updated_at
      FROM cloud_billing_account WHERE organization_id = ${organizationId}
    `

    return rows[0]
  }).pipe(Effect.orDie)

const eventRows = (organizationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    return yield* sql<{ readonly event_id: string }>`
      SELECT event_id FROM cloud_billing_event WHERE actor_id = ${organizationId} ORDER BY event_id
    `
  }).pipe(Effect.orDie)

const onlyRefresh = (ref: {
  readonly tenant: string
  readonly actor: string
  readonly id: string
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const obligations = yield* sql<{
      readonly kind: string
      readonly command: string
      readonly timer_key: string | null
    }>`
      SELECT kind, command, timer_key FROM actor_outbox
      WHERE tenant_id = ${ref.tenant} AND actor_type = ${ref.actor} AND actor_id = ${ref.id}
    `

    expect(obligations).toEqual([
      { kind: "intent", command: "Refresh", timer_key: "$cron:@every 3600000ms" },
    ])
  }).pipe(Effect.orDie)

/** Moves the outbox clock past every retry backoff a job with three retries can wait. */
const exhaust = ActorTest.use((test) =>
  Effect.forEach([1, 2, 3, 4, 5], () => test.advance("1 minute"), { discard: true }),
)

/** An organization whose account exists and whose customer binding has committed. */
const bound = (organizationId: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const actor = yield* BillingActor.get(organizationId)

    yield* actor.InitializeAccount({ email: `${organizationId}@example.test` })
    yield* test.advance(0)

    return { actor, test, customerId: `cus_${organizationId}` }
  })

const subscription = (
  customerId: string,
  tierId: string,
  status: Subscription["status"],
): Subscription => ({
  subscriptionId: "sub_1",
  customerId,
  tierId,
  status,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
})

const event = (
  id: string,
  type: string,
  customerId: string,
  data: BillingEvent["data"] = {},
): BillingEvent => ({
  id,
  type,
  createdAt: DateTime.makeUnsafe(1_700_000_000_000),
  livemode: false,
  data: Object.assign({ object: "subscription", customer: customerId }, data),
})

describe("BillingActor account", () => {
  it("creates the account and binds the provider's customer from a job, once", () =>
    run(
      Effect.gen(function* () {
        const org = "org-init"
        const test = yield* ActorTest
        const actor = yield* BillingActor.get(org)

        const created = yield* actor.InitializeAccount({ email: "ops@acme.test", name: "Acme" })

        expect(created).toMatchObject({
          organizationId: org,
          plan: "free",
          customerId: null,
          spendLimitCents: null,
          paymentStatus: "free",
        })

        yield* test.advance(0)

        expect(yield* accountRow(org)).toEqual({
          plan: "free",
          subscribed_plan: "free",
          spend_limit_cents: null,
          customer_id: `cus_${org}`,
          billing_email: "ops@acme.test",
          subscription_id: null,
          payment_status: "free",
          provider_updated_at: 0,
        })

        yield* actor.InitializeAccount({ email: "other@acme.test" })
        yield* test.advance("1 minute")

        expect(provider.calls.ensureCustomer.filter((call) => call.organizationId === org)).toEqual(
          [{ organizationId: org, email: "ops@acme.test", name: "Acme" }],
        )
        expect((yield* accountRow(org))?.billing_email).toBe("ops@acme.test")
        expect((yield* actor.GetAccount())?.customerId).toBe(`cus_${org}`)
      }),
    ))

  it("starts another customer job after a failed one is dead-lettered, and never before", () =>
    run(
      Effect.gen(function* () {
        const org = "org-retry"
        const test = yield* ActorTest
        const actor = yield* BillingActor.get(org)

        provider.failEnsure = true
        yield* actor.InitializeAccount({ email: "ops@retry.test" })
        yield* test.advance(0)
        yield* actor.InitializeAccount({ email: "ops@retry.test" })
        yield* test.advance(0)

        expect((yield* accountRow(org))?.customer_id).toBe(null)

        yield* exhaust
        expect(
          provider.calls.ensureCustomer.filter((call) => call.organizationId === org).length,
        ).toBe(4)
        expect((yield* accountRow(org))?.customer_id).toBe(null)

        provider.failEnsure = false
        yield* actor.InitializeAccount({ email: "ops@retry.test" })
        yield* test.advance(0)

        expect((yield* accountRow(org))?.customer_id).toBe(`cus_${org}`)
      }),
    ))

  it("sets and clears the spend limit, and refuses an account that was never initialized", () =>
    run(
      Effect.gen(function* () {
        const { actor } = yield* bound("org-limit")

        expect((yield* actor.SetSpendLimit({ cents: 12_345 })).spendLimitCents).toBe(12_345)
        expect((yield* accountRow("org-limit"))?.spend_limit_cents).toBe(12_345)
        expect((yield* actor.SetSpendLimit({ cents: null })).spendLimitCents).toBe(null)
        expect((yield* accountRow("org-limit"))?.spend_limit_cents).toBe(null)

        const stranger = yield* BillingActor.get("org-never")

        expect(yield* stranger.SetSpendLimit({ cents: 1 }).pipe(Effect.exit)).toEqual(
          Exit.fail(AccountNotInitialized.make({ organizationId: "org-never" })),
        )
        expect(yield* accountRow("org-never")).toBe(undefined)
      }),
    ))

  it("commits the plan projection and the receipt together, or neither", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* bound("org-atomic")
        const sql = yield* SqlClient.SqlClient
        const before = (yield* test.inspect(actor.ref)).receipts

        yield* sql`ALTER TABLE cloud_billing_account
          ADD CONSTRAINT refuse_666 CHECK (spend_limit_cents IS DISTINCT FROM 666)`.pipe(
          Effect.orDie,
        )

        const refused = yield* actor.SetSpendLimit({ cents: 666 }).pipe(Effect.exit)

        yield* sql`ALTER TABLE cloud_billing_account DROP CONSTRAINT refuse_666`.pipe(Effect.orDie)

        expect(Exit.isFailure(refused)).toBe(true)
        expect((yield* test.inspect(actor.ref)).receipts).toBe(before)
        expect((yield* actor.GetAccount())?.spendLimitCents).toBe(null)
        expect((yield* accountRow("org-atomic"))?.spend_limit_cents).toBe(null)

        yield* test.crashNext("beforeCommit")
        yield* actor.SetSpendLimit({ cents: 700 })

        expect((yield* test.inspect(actor.ref)).receipts).toBe(before + 1)
        expect((yield* actor.GetAccount())?.spendLimitCents).toBe(700)
        expect((yield* accountRow("org-atomic"))?.spend_limit_cents).toBe(700)
      }),
    ))

  it("leaves a customer bound to one organization when a second would take it", () =>
    run(
      Effect.gen(function* () {
        const first = yield* bound("org-first")
        const test = yield* ActorTest
        const second = yield* BillingActor.get("org-second")

        provider.customerFor.set("org-second", first.customerId)
        yield* second.InitializeAccount({ email: "second@example.test" })
        yield* test.advance("1 minute")

        expect((yield* accountRow("org-first"))?.customer_id).toBe(first.customerId)
        expect((yield* accountRow("org-second"))?.customer_id).toBe(null)
        expect((yield* second.GetAccount())?.customerId).toBe(null)
      }),
    ))
})

describe("BillingActor checkout and portal requests", () => {
  it("refuses a request before the customer is bound, then runs it as a job with a stable identity", () =>
    run(
      Effect.gen(function* () {
        const org = "org-checkout"
        const test = yield* ActorTest
        const actor = yield* BillingActor.get(org)
        const input = {
          requestId: "req-1",
          tierId: "pro" as const,
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
        }

        provider.failEnsure = true
        yield* actor.InitializeAccount({ email: "ops@checkout.test" })
        yield* test.advance(0)

        expect(yield* actor.StartCheckout(input).pipe(Effect.exit)).toEqual(
          Exit.fail(CustomerNotBound.make({ organizationId: org })),
        )

        provider.failEnsure = false
        yield* test.advance("1 minute")

        const pending = yield* actor.StartCheckout(input)

        expect(pending).toMatchObject({ requestId: "req-1", kind: "checkout", url: null })
        yield* test.advance(0)

        const ready = yield* actor.GetRequest({ requestId: "req-1" })

        expect(ready).toEqual({
          requestId: "req-1",
          kind: "checkout",
          status: "ready",
          url: `https://pay.test/${org}:req-1`,
          sessionId: `cs_${org}:req-1`,
          failure: null,
          ambiguous: false,
        })
        expect(yield* actor.StartCheckout(input)).toEqual(ready)
        expect(
          provider.calls.startCheckout.filter((call) => call.idempotencyKey === `${org}:req-1`),
        ).toEqual([{ customerId: `cus_${org}`, tierId: "pro", idempotencyKey: `${org}:req-1` }])
        expect(yield* actor.StartCheckout({ ...input, tierId: "team" }).pipe(Effect.exit)).toEqual(
          Exit.fail(RequestConflict.make({ requestId: "req-1" })),
        )
        expect(yield* actor.GetRequest({ requestId: "never" })).toBe(undefined)
      }),
    ))

  it("returns the same hosted page when the provider call succeeded but the result was never recorded", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* bound("org-crash")
        const input = {
          requestId: "req-crash",
          tierId: "team" as const,
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
        }

        yield* test.crashNext("afterExecute")
        yield* actor.StartCheckout(input)
        yield* test.advance(0)

        expect((yield* actor.GetRequest({ requestId: "req-crash" }))?.status).toBe("pending")

        yield* test.advance("1 minute")

        const calls = provider.calls.startCheckout.filter(
          (call) => call.idempotencyKey === "org-crash:req-crash",
        )

        expect(calls.length).toBe(2)
        expect(yield* actor.GetRequest({ requestId: "req-crash" })).toMatchObject({
          status: "ready",
          url: "https://pay.test/org-crash:req-crash",
        })
        expect(yield* test.receiptsFor(actor.ref, "RequestResolved")).toBe(1)
        expect(yield* test.inspect(actor.ref)).toMatchObject({ jobs: 0, outbox: 1 })
        yield* onlyRefresh(actor.ref)
      }),
    ))

  it("fails a request at once on a rejection retrying cannot fix, and after retries on an outage", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* bound("org-fail")
        const base = {
          tierId: "pro" as const,
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
        }
        const calls = () =>
          provider.calls.startCheckout.filter((call) =>
            call.idempotencyKey?.startsWith("org-fail:"),
          )

        provider.failCheckout = "unknown_tier"
        yield* actor.StartCheckout({ ...base, requestId: "rejected" })
        yield* test.advance("1 minute")

        expect(yield* actor.GetRequest({ requestId: "rejected" })).toMatchObject({
          status: "failed",
          failure: "unknown_tier",
          ambiguous: false,
        })
        expect(calls().length).toBe(1)

        provider.failCheckout = "retryable"
        yield* actor.StartCheckout({ ...base, requestId: "outage" })
        yield* exhaust

        const outage = yield* actor.GetRequest({ requestId: "outage" })

        expect(outage).toMatchObject({ status: "failed", ambiguous: true })
        expect(outage?.failure).not.toBe(null)
        expect(calls().length).toBe(5)
      }),
    ))

  it("opens a portal session through a job like checkout", () =>
    run(
      Effect.gen(function* () {
        const { actor, test } = yield* bound("org-portal")

        yield* actor.OpenPortal({ requestId: "p1", returnUrl: "https://app.test/billing" })
        yield* test.advance(0)

        expect(yield* actor.GetRequest({ requestId: "p1" })).toMatchObject({
          kind: "portal",
          status: "ready",
          url: "https://portal.test/org-portal:p1",
        })
        expect(
          yield* actor
            .OpenPortal({ requestId: "p1", returnUrl: "https://elsewhere.test" })
            .pipe(Effect.exit),
        ).toEqual(Exit.fail(RequestConflict.make({ requestId: "p1" })))
      }),
    ))
})

const checkout = (requestId: string) => ({
  requestId,
  tierId: "pro" as const,
  successUrl: "https://app.test/ok",
  cancelUrl: "https://app.test/no",
})

const paid = (organizationId: string) =>
  Effect.gen(function* () {
    const result = yield* bound(organizationId)

    provider.subscriptions.set(result.customerId, subscription(result.customerId, "pro", "active"))
    yield* deliverWebhook(
      event(`evt_${organizationId}`, "customer.subscription.created", result.customerId),
    )
    yield* result.test.advance(0)

    return result
  })

describe("BillingActor subscription lifecycle", () => {
  it("recovers canonically after an exhausted read and a lost recovery webhook on the hourly refresh", () =>
    run(
      Effect.gen(function* () {
        const org = "org-hourly-recovery"
        const { actor, test, customerId } = yield* bound(org)
        provider.subscriptions.set(customerId, subscription(customerId, "team", "active"))
        provider.failRead = true
        yield* deliverWebhook(
          event("evt_hourly_unavailable", "customer.subscription.updated", customerId),
        )
        yield* exhaust
        expect((yield* accountRow(org))?.plan).toBe("free")
        provider.failRead = false
        yield* test.advance("1 hour")
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "team", subscriptionId: "sub_1" })
        expect((yield* accountRow(org))?.plan).toBe("team")
        provider.subscriptions.set(customerId, null)
        yield* test.advance("1 hour")
        expect(yield* accountRow(org)).toMatchObject({
          plan: "free",
          subscription_id: null,
          payment_status: "canceled",
        })
        expect(yield* test.receiptsFor(actor.ref, "Refresh")).toBeGreaterThanOrEqual(2)
      }),
    ))

  it("rejects distinct initial checkout identities concurrently and while a hosted session is ready", () =>
    run(
      Effect.gen(function* () {
        const org = "org-one-checkout"
        const { actor, test, customerId } = yield* bound(org)
        const outcomes = yield* Effect.forEach(
          ["first", "second"],
          (requestId) => actor.StartCheckout(checkout(requestId)).pipe(Effect.exit),
          { concurrency: "unbounded" },
        )

        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
        const winner = Exit.isSuccess(outcomes[0]!) ? "first" : "second"
        expect(outcomes.filter(Exit.isFailure)).toEqual([
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "pending_checkout",
              requestId: winner,
            }),
          ),
        ])
        yield* test.advance(0)
        expect(
          provider.calls.startCheckout.filter((call) => call.customerId === customerId),
        ).toHaveLength(1)
        expect(yield* actor.StartCheckout(checkout("third")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "pending_checkout",
              requestId: winner,
            }),
          ),
        )
        expect((yield* actor.StartCheckout(checkout(winner))).status).toBe("ready")
        expect(yield* actor.GetRequest({ requestId: "third" })).toBeUndefined()
      }),
    ))

  it("only frees an initial checkout after an expiry with the bound customer and exact durable session", () =>
    run(
      Effect.gen(function* () {
        const org = "org-expiry"
        const { actor, test, customerId } = yield* bound(org)
        yield* actor.StartCheckout(checkout("first"))
        yield* test.advance(0)
        const sessionId = (yield* actor.GetRequest({ requestId: "first" }))!.sessionId!

        yield* deliverWebhook(
          event("evt_wrong_session", "checkout.session.expired", customerId, {
            object: "checkout.session",
            id: "cs_other",
          }),
        )
        yield* test.advance(0)
        expect((yield* actor.GetRequest({ requestId: "first" }))?.status).toBe("ready")
        expect(
          yield* actor
            .RecordWebhook({
              eventId: "evt_wrong_customer",
              eventType: "checkout.session.expired",
              customerId: "cus_other",
              occurredAt: 1,
              sessionId,
            })
            .pipe(Effect.exit),
        ).toEqual(Exit.fail(CustomerMismatch.make({ customerId: "cus_other" })))
        expect(yield* actor.StartCheckout(checkout("second")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "pending_checkout",
              requestId: "first",
            }),
          ),
        )
        yield* deliverWebhook(
          event("evt_right_session", "checkout.session.expired", customerId, {
            object: "checkout.session",
            id: sessionId,
          }),
        )
        expect((yield* actor.GetRequest({ requestId: "first" }))?.status).toBe("expired")
        expect((yield* actor.StartCheckout(checkout("second"))).status).toBe("pending")
        yield* test.advance(0)
        expect((yield* actor.StartCheckout(checkout("first"))).status).toBe("expired")
        expect(
          provider.calls.startCheckout.filter((call) => call.customerId === customerId),
        ).toHaveLength(2)
      }),
    ))

  it("blocks a new checkout after ambiguous provider failure despite a canonical read with no subscription", () =>
    run(
      Effect.gen(function* () {
        const org = "org-ambiguous-checkout"
        const { actor, test, customerId } = yield* bound(org)
        provider.failCheckout = "retryable"
        yield* actor.StartCheckout(checkout("lost"))
        yield* exhaust
        provider.failCheckout = undefined

        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "failed",
          ambiguous: true,
        })
        yield* deliverWebhook(event("evt_no_subscription", "invoice.created", customerId))
        yield* test.advance(0)
        expect(yield* actor.StartCheckout(checkout("new")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "ambiguous_checkout",
              requestId: "lost",
            }),
          ),
        )
        provider.failCheckout = "catalog_not_ready"
        expect((yield* actor.StartCheckout(checkout("lost"))).status).toBe("pending")
        yield* test.advance(0)
        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "failed",
          ambiguous: true,
          failure: "catalog_not_ready",
        })
        expect(yield* actor.StartCheckout(checkout("new")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "ambiguous_checkout",
              requestId: "lost",
            }),
          ),
        )
        provider.failCheckout = undefined
        const checkoutGate = yield* Deferred.make<void>()
        provider.checkoutGate = checkoutGate
        expect((yield* actor.StartCheckout(checkout("lost"))).status).toBe("pending")
        expect(
          yield* actor.StartCheckout({ ...checkout("lost"), tierId: "team" }).pipe(Effect.exit),
        ).toEqual(Exit.fail(RequestConflict.make({ requestId: "lost" })))
        expect((yield* actor.StartCheckout(checkout("lost"))).status).toBe("pending")
        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "pending",
          ambiguous: true,
          sessionId: null,
          url: null,
        })
        yield* Deferred.succeed(checkoutGate, undefined)
        provider.checkoutGate = undefined
        yield* test.advance(0)
        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "ready",
          ambiguous: false,
          sessionId: `cs_${org}:lost`,
          url: `https://pay.test/${org}:lost`,
        })
        expect(
          provider.calls.startCheckout.filter((call) => call.customerId === customerId),
        ).toHaveLength(6)
        expect(
          new Set(
            provider.calls.startCheckout
              .filter((call) => call.customerId === customerId)
              .map((call) => call.idempotencyKey),
          ),
        ).toEqual(new Set([`${org}:lost`]))
        expect(yield* actor.StartCheckout(checkout("new")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "pending_checkout",
              requestId: "lost",
            }),
          ),
        )
      }),
    ))

  it("releases an ambiguous checkout fence only after the provider proves its session expired", () =>
    run(
      Effect.gen(function* () {
        const org = "org-recovered-expiry"
        const { actor, test, customerId } = yield* bound(org)
        provider.failCheckout = "retryable"
        yield* actor.StartCheckout(checkout("lost"))
        yield* exhaust
        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "failed",
          ambiguous: true,
        })
        provider.failCheckout = "expired"
        expect((yield* actor.StartCheckout(checkout("lost"))).status).toBe("pending")
        yield* test.advance(0)
        expect(yield* actor.GetRequest({ requestId: "lost" })).toMatchObject({
          status: "expired",
          ambiguous: false,
          failure: "checkout_expired",
        })
        provider.failCheckout = undefined
        expect((yield* actor.StartCheckout(checkout("new"))).status).toBe("pending")
        yield* test.advance(0)
        expect((yield* actor.GetRequest({ requestId: "new" }))?.status).toBe("ready")
        expect(
          provider.calls.startCheckout
            .filter((call) => call.customerId === customerId)
            .map((call) => call.idempotencyKey),
        ).toEqual([
          `${org}:lost`,
          `${org}:lost`,
          `${org}:lost`,
          `${org}:lost`,
          `${org}:lost`,
          `${org}:new`,
        ])
      }),
    ))

  it("keeps an incomplete subscription fenced, then permits a new checkout only after canonical cancellation", () =>
    run(
      Effect.gen(function* () {
        const org = "org-cancel-checkout"
        const { actor, test, customerId } = yield* bound(org)
        yield* actor.StartCheckout(checkout("initial"))
        yield* test.advance(0)
        provider.subscriptions.set(customerId, subscription(customerId, "pro", "incomplete"))
        yield* deliverWebhook(event("evt_incomplete", "checkout.session.completed", customerId))
        yield* test.advance(0)
        expect(yield* actor.GetAccount()).toMatchObject({
          plan: "free",
          subscriptionId: "sub_1",
          paymentStatus: "incomplete",
        })
        expect((yield* actor.GetRequest({ requestId: "initial" }))?.status).toBe("completed")
        expect(yield* actor.StartCheckout(checkout("second")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "active_subscription",
              requestId: null,
            }),
          ),
        )
        provider.subscriptions.set(customerId, subscription(customerId, "pro", "active"))
        yield* deliverWebhook(event("evt_initial_paid", "invoice.paid", customerId))
        yield* test.advance(0)
        expect(yield* actor.StartCheckout(checkout("second")).pipe(Effect.exit)).toEqual(
          Exit.fail(
            CheckoutBlocked.make({
              organizationId: org,
              reason: "active_subscription",
              requestId: null,
            }),
          ),
        )
        provider.subscriptions.set(customerId, subscription(customerId, "pro", "canceled"))
        yield* deliverWebhook(
          event("evt_initial_cancel", "customer.subscription.deleted", customerId),
        )
        yield* test.advance(0)
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "free", subscriptionId: null })
        expect((yield* actor.StartCheckout(checkout("second"))).status).toBe("pending")
        yield* test.advance(0)
      }),
    ))

  it("uses the existing subscription and one request identity across a provider-change crash and rejects stale reconciliation", () =>
    run(
      Effect.gen(function* () {
        const org = "org-change-crash"
        const { actor, test, customerId } = yield* paid(org)
        const input = { requestId: "upgrade", tierId: "team" as const }
        yield* test.crashNext("afterExecute")
        expect((yield* actor.ChangePlan(input)).status).toBe("pending")
        yield* test.advance(0)
        expect((yield* actor.GetAccount())?.plan).toBe("pro")
        expect(provider.subscriptions.get(customerId)?.tierId).toBe("team")
        expect((yield* actor.ChangePlan(input)).status).toBe("pending")
        expect(
          yield* actor.ChangePlan({ ...input, tierId: "enterprise" }).pipe(Effect.exit),
        ).toEqual(Exit.fail(RequestConflict.make({ requestId: "upgrade" })))
        yield* test.advance("1 minute")
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "team", subscriptionId: "sub_1" })
        expect((yield* actor.ChangePlan(input)).status).toBe("completed")
        expect(
          provider.calls.changeSubscription.filter((call) => call.customerId === customerId),
        ).toEqual([
          { customerId, subscriptionId: "sub_1", tierId: "team", idempotencyKey: `${org}:upgrade` },
          { customerId, subscriptionId: "sub_1", tierId: "team", idempotencyKey: `${org}:upgrade` },
        ])
        expect(yield* test.receiptsFor(actor.ref, "PlanChanged")).toBe(1)
        const internal = yield* test.actor(BillingActor, org)
        expect(
          yield* internal.system.SubscriptionReconciled({
            customerId,
            seq: 1,
            observedAt: 1,
            subscription: { subscriptionId: "sub_1", tierId: "enterprise", status: "active" },
          }),
        ).toBe("stale")
        expect((yield* accountRow(org))?.plan).toBe("team")
        expect(yield* test.inspect(actor.ref)).toMatchObject({ jobs: 0, outbox: 1 })
        yield* onlyRefresh(actor.ref)
      }),
    ))

  it.each(["incomplete_expired", "canceled"] as const)(
    "permits a new initial checkout after an incomplete subscription becomes canonically %s",
    (terminal) =>
      run(
        Effect.gen(function* () {
          const org = `org-pending-${terminal}`
          const { actor, test, customerId } = yield* bound(org)
          yield* actor.StartCheckout(checkout("initial"))
          yield* test.advance(0)
          provider.subscriptions.set(customerId, subscription(customerId, "team", "incomplete"))
          yield* deliverWebhook(
            event(`evt_${org}_pending`, "checkout.session.completed", customerId),
          )
          yield* test.advance(0)
          expect(yield* actor.GetAccount()).toMatchObject({
            plan: "free",
            subscribedPlan: "team",
            subscriptionId: "sub_1",
            paymentStatus: "incomplete",
          })
          expect((yield* actor.GetRequest({ requestId: "initial" }))?.status).toBe("completed")
          expect(yield* actor.StartCheckout(checkout("replacement")).pipe(Effect.exit)).toEqual(
            Exit.fail(
              CheckoutBlocked.make({
                organizationId: org,
                reason: "active_subscription",
                requestId: null,
              }),
            ),
          )
          provider.subscriptions.set(customerId, subscription(customerId, "team", terminal))
          yield* deliverWebhook(
            event(`evt_${org}_ended`, "customer.subscription.updated", customerId),
          )
          yield* test.advance(0)
          expect(yield* actor.GetAccount()).toMatchObject({
            plan: "free",
            subscribedPlan: "free",
            subscriptionId: null,
            paymentStatus: "canceled",
          })
          expect((yield* actor.StartCheckout(checkout("replacement"))).status).toBe("pending")
          yield* test.advance(0)
          expect(
            provider.calls.startCheckout.filter((call) => call.customerId === customerId),
          ).toHaveLength(2)
        }),
      ),
  )

  it("retains the current entitlement plan while a replacement tier is canonically incomplete", () =>
    run(
      Effect.gen(function* () {
        const org = "org-change-incomplete"
        const { actor, test, customerId } = yield* paid(org)
        provider.changeStatus = "incomplete"
        yield* actor.ChangePlan({ requestId: "upgrade", tierId: "enterprise" })
        yield* test.advance(0)
        expect(yield* actor.GetAccount()).toMatchObject({
          plan: "pro",
          subscribedPlan: "enterprise",
          subscriptionId: "sub_1",
          paymentStatus: "incomplete",
        })
        expect(yield* accountRow(org)).toMatchObject({ plan: "pro", subscribed_plan: "enterprise" })
        provider.subscriptions.set(customerId, subscription(customerId, "enterprise", "active"))
        yield* deliverWebhook(event("evt_incomplete_upgrade_paid", "invoice.paid", customerId))
        yield* test.advance(0)
        expect(yield* actor.GetAccount()).toMatchObject({
          plan: "enterprise",
          subscribedPlan: "enterprise",
          paymentStatus: "active",
        })
      }),
    ))

  it("does not grant the requested tier when canonical payment is pending and retries a lost provider reply with the same identity", () =>
    run(
      Effect.gen(function* () {
        const org = "org-change-payment"
        const { actor, test, customerId } = yield* paid(org)
        provider.changeStatus = "past_due"
        provider.failChange = true
        yield* actor.ChangePlan({ requestId: "upgrade", tierId: "enterprise" })
        yield* test.advance(0)
        expect((yield* actor.GetAccount())?.plan).toBe("pro")
        provider.failChange = false
        yield* test.advance("1 minute")
        expect(yield* accountRow(org)).toMatchObject({
          plan: "free",
          subscription_id: "sub_1",
          payment_status: "past_due",
          subscribed_plan: "enterprise",
        })
        expect(yield* actor.GetAccount()).toMatchObject({
          subscribedPlan: "enterprise",
          plan: "free",
        })
        expect(
          provider.calls.changeSubscription.filter((call) => call.customerId === customerId),
        ).toHaveLength(2)
        expect(provider.changes.get(`${org}:upgrade`)?.tierId).toBe("enterprise")
      }),
    ))

  it("requires a canonical subscription before plan changes and commits the plan-change request and job atomically", () =>
    run(
      Effect.gen(function* () {
        const org = "org-change-atomic"
        const { actor, test, customerId } = yield* bound(org)
        expect(
          yield* actor.ChangePlan({ requestId: "absent", tierId: "team" }).pipe(Effect.exit),
        ).toEqual(Exit.fail(NoActiveSubscription.make({ organizationId: org })))
        expect(yield* actor.GetRequest({ requestId: "absent" })).toBeUndefined()
        provider.subscriptions.set(customerId, subscription(customerId, "pro", "active"))
        yield* deliverWebhook(event("evt_atomic_paid", "customer.subscription.created", customerId))
        yield* test.advance(0)
        const sql = yield* SqlClient.SqlClient
        yield* sql`ALTER TABLE cloud_billing_request ADD CONSTRAINT refuse_change_request
        CHECK (request_id <> 'rollback')`.pipe(Effect.orDie)
        const before = yield* test.inspect(actor.ref)
        const failed = yield* actor
          .ChangePlan({ requestId: "rollback", tierId: "team" })
          .pipe(Effect.exit)
        yield* sql`ALTER TABLE cloud_billing_request DROP CONSTRAINT refuse_change_request`.pipe(
          Effect.orDie,
        )
        expect(Exit.isFailure(failed)).toBe(true)
        expect((yield* test.inspect(actor.ref)).receipts).toBe(before.receipts)
        yield* test.advance(0)
        expect(
          provider.calls.changeSubscription.filter((call) => call.customerId === customerId),
        ).toHaveLength(0)
        expect(yield* actor.GetRequest({ requestId: "rollback" })).toBeUndefined()
        yield* actor.ChangePlan({ requestId: "rollback", tierId: "team" })
        yield* test.advance(0)
        expect((yield* accountRow(org))?.plan).toBe("team")
      }),
    ))
})

describe("BillingActor webhooks", () => {
  it("follows the provider through upgrade, downgrade, payment failure, recovery and cancellation", () =>
    run(
      Effect.gen(function* () {
        const org = "org-sync"
        const { actor, test, customerId } = yield* bound(org)
        let sequence = 0

        const deliver = (status: Subscription | null, type = "customer.subscription.updated") =>
          Effect.gen(function* () {
            provider.subscriptions.set(customerId, status)
            sequence += 1
            const outcome = yield* deliverWebhook(event(`evt_sync_${sequence}`, type, customerId))
            yield* test.advance(0)

            return outcome
          })

        expect(
          yield* deliver(
            subscription(customerId, "pro", "active"),
            "customer.subscription.created",
          ),
        ).toBe("queued")
        expect(yield* accountRow(org)).toMatchObject({
          plan: "pro",
          subscription_id: "sub_1",
          payment_status: "active",
        })
        expect((yield* accountRow(org))!.provider_updated_at).toBeGreaterThan(0)

        yield* deliver(subscription(customerId, "team", "active"))
        expect((yield* accountRow(org))?.plan).toBe("team")

        yield* deliver(subscription(customerId, "pro", "active"))
        expect((yield* accountRow(org))?.plan).toBe("pro")

        yield* deliver(subscription(customerId, "pro", "past_due"), "invoice.payment_failed")
        expect(yield* accountRow(org)).toMatchObject({
          plan: "free",
          subscribed_plan: "pro",
          subscription_id: "sub_1",
          payment_status: "past_due",
        })
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "free", subscribedPlan: "pro" })

        yield* deliver(subscription(customerId, "pro", "active"), "invoice.paid")
        expect(yield* accountRow(org)).toMatchObject({ plan: "pro", payment_status: "active" })

        yield* deliver(subscription(customerId, "pro", "unpaid"))
        expect(yield* accountRow(org)).toMatchObject({ plan: "free", payment_status: "unpaid" })

        yield* deliver(null, "customer.subscription.deleted")
        expect(yield* accountRow(org)).toMatchObject({
          plan: "free",
          subscription_id: null,
          payment_status: "canceled",
        })
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "free", subscribedPlan: "free" })
      }),
    ))

  it("takes an event id once, ignores events that cannot change a subscription, and rejects a subscription tier it does not price", () =>
    run(
      Effect.gen(function* () {
        const org = "org-dup"
        const { test, customerId } = yield* bound(org)
        const reads = () => provider.calls.billingDetails.filter((id) => id === customerId).length

        provider.subscriptions.set(customerId, subscription(customerId, "pro", "active"))

        expect(
          yield* deliverWebhook(event("evt_dup", "customer.subscription.created", customerId)),
        ).toBe("queued")
        yield* test.advance(0)
        expect(
          yield* deliverWebhook(event("evt_dup", "customer.subscription.created", customerId)),
        ).toBe("duplicate")
        yield* test.advance("1 minute")
        expect(reads()).toBe(1)

        expect(yield* deliverWebhook(event("evt_other", "price.created", customerId))).toBe(
          "ignored",
        )
        yield* test.advance("1 minute")
        expect(reads()).toBe(1)
        expect((yield* eventRows(org)).map((row) => row.event_id)).toEqual(["evt_dup", "evt_other"])

        provider.subscriptions.set(customerId, subscription(customerId, "platinum", "active"))
        yield* deliverWebhook(
          event("evt_unknown_tier", "customer.subscription.updated", customerId),
        )
        yield* test.advance(0)
        expect((yield* accountRow(org))?.plan).toBe("pro")
      }),
    ))

  it("records one of several concurrent deliveries of the same event", () =>
    run(
      Effect.gen(function* () {
        const org = "org-race"
        const { test, customerId } = yield* bound(org)

        provider.subscriptions.set(customerId, subscription(customerId, "pro", "active"))

        const outcomes = yield* Effect.forEach(
          Array.from({ length: 6 }),
          () => deliverWebhook(event("evt_race", "customer.subscription.created", customerId)),
          { concurrency: "unbounded" },
        )

        yield* test.advance(0)

        expect(outcomes.filter((outcome) => outcome === "queued").length).toBe(1)
        expect(outcomes.filter((outcome) => outcome === "duplicate").length).toBe(5)
        expect(provider.calls.billingDetails.filter((id) => id === customerId).length).toBe(1)
        expect((yield* accountRow(org))?.plan).toBe("pro")
      }),
    ))

  it("reads the provider instead of trusting a stale or replayed event", () =>
    run(
      Effect.gen(function* () {
        const org = "org-stale"
        const { actor, test, customerId } = yield* bound(org)

        provider.subscriptions.set(customerId, subscription(customerId, "team", "active"))
        yield* deliverWebhook(event("evt_new", "customer.subscription.created", customerId))
        yield* test.advance(0)
        expect((yield* accountRow(org))?.plan).toBe("team")

        provider.subscriptions.set(customerId, null)
        yield* deliverWebhook(event("evt_cancel", "customer.subscription.deleted", customerId))
        yield* test.advance(0)

        yield* deliverWebhook(
          event("evt_old", "customer.subscription.updated", customerId, {
            status: "active",
            items: { data: [{ price: { lookup_key: "akter_team_base" } }] },
          }),
        )
        yield* test.advance(0)
        expect(yield* accountRow(org)).toMatchObject({ plan: "free", payment_status: "canceled" })

        const applied = (yield* accountRow(org))!.provider_updated_at
        const late = yield* test.actor(BillingActor, org)
        const result = yield* late.system.SubscriptionReconciled({
          customerId,
          seq: 1,
          observedAt: applied - 1_000,
          subscription: { subscriptionId: "sub_1", tierId: "team", status: "active" },
        })

        expect(result).toBe("stale")
        expect(yield* accountRow(org)).toMatchObject({ plan: "free", provider_updated_at: applied })
        expect(yield* actor.GetAccount()).toMatchObject({ plan: "free" })
      }),
    ))

  it("applies a subscription result once when the job crashes after the provider answered", () =>
    run(
      Effect.gen(function* () {
        const org = "org-reconcile-crash"
        const { actor, test, customerId } = yield* bound(org)

        provider.subscriptions.set(customerId, subscription(customerId, "pro", "active"))
        yield* test.crashNext("afterExecute")
        yield* deliverWebhook(event("evt_crash", "customer.subscription.created", customerId))
        yield* test.advance(0)
        expect((yield* accountRow(org))?.plan).toBe("free")

        yield* test.advance("1 minute")

        expect((yield* accountRow(org))?.plan).toBe("pro")
        expect(yield* test.receiptsFor(actor.ref, "SubscriptionReconciled")).toBe(1)
        expect(yield* test.inspect(actor.ref)).toMatchObject({ jobs: 0, outbox: 1 })
        yield* onlyRefresh(actor.ref)
      }),
    ))

  it("rejects an event for another organization's customer and never selects an organization from metadata", () =>
    run(
      Effect.gen(function* () {
        const mine = yield* bound("org-mine")
        const theirs = yield* bound("org-theirs")

        provider.subscriptions.set(
          theirs.customerId,
          subscription(theirs.customerId, "enterprise", "active"),
        )

        expect(
          yield* mine.actor
            .RecordWebhook({
              eventId: "evt_forged",
              eventType: "customer.subscription.updated",
              customerId: theirs.customerId,
              occurredAt: 1,
            })
            .pipe(Effect.exit),
        ).toEqual(Exit.fail(CustomerMismatch.make({ customerId: theirs.customerId })))
        expect(yield* eventRows("org-mine")).toEqual([])

        const unbound = event("evt_meta", "customer.subscription.updated", "cus_nobody", {
          metadata: { organization_id: "org-mine" },
        })

        expect(yield* deliverWebhook(unbound).pipe(Effect.exit)).toEqual(
          Exit.fail(UnboundCustomer.make({ customerId: "cus_nobody" })),
        )
        expect(yield* eventRows("org-mine")).toEqual([])

        yield* deliverWebhook(
          event("evt_theirs", "customer.subscription.updated", theirs.customerId, {
            metadata: { organization_id: "org-mine" },
          }),
        )
        yield* mine.test.advance(0)

        expect(yield* accountRow("org-theirs")).toMatchObject({ plan: "enterprise" })
        expect(yield* accountRow("org-mine")).toMatchObject({
          plan: "free",
          payment_status: "free",
        })
        expect(yield* eventRows("org-mine")).toEqual([])
        expect((yield* eventRows("org-theirs")).map((row) => row.event_id)).toEqual(["evt_theirs"])
      }),
    ))

  it("ignores an event that names no customer", () =>
    run(
      Effect.gen(function* () {
        const outcome = yield* deliverWebhook({
          id: "evt_none",
          type: "product.created",
          createdAt: DateTime.makeUnsafe(1),
          livemode: false,
          data: { object: "product", id: "prod_1" },
        })

        expect(outcome).toBe("ignored")
      }),
    ))
})
