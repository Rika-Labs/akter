import { type BillingEvent } from "@akter/billing"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  Crypto,
  DateTime,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { BillingRepository, BillingRepositoryLive, customerIdOf } from "./billing-repository.ts"

/** A fresh database on the server at TEST_DATABASE_URL, dropped with the scope. */
const database = Effect.gen(function* () {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `api_billing_repository_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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

const client = Layer.unwrap(
  Effect.map(database, (url) => PgClient.layer({ url, maxConnections: 12 })),
).pipe(Layer.provideMerge(BunCrypto.layer), Layer.orDie)

const upgrading = ManagedRuntime.make(client)

const migrated = ManagedRuntime.make(BillingRepositoryLive.pipe(Layer.provideMerge(client)))

afterAll(() => Promise.all([upgrading.dispose(), migrated.dispose()]))

const migrate = Layer.build(BillingRepositoryLive).pipe(Effect.scoped, Effect.asVoid)

interface AccountColumns {
  readonly organization_id: string
  readonly plan: string
  readonly subscribed_plan: string
  readonly spend_limit_cents: number | null
  readonly customer_id: string | null
  readonly billing_email: string | null
  readonly subscription_id: string | null
  readonly provider_updated_at: number
  readonly payment_status: string
}

const state = (
  organizationId: string,
  fields: { readonly customer?: string; readonly plan?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`
      INSERT INTO cloud_billing_state (routing_key, tenant_id, actor_id, singleton, organization_id,
        customer_id, plan, subscribed_plan, billing_email, spend_limit_cents)
      VALUES (1, 'default', ${organizationId}, 'account', ${organizationId},
        ${fields.customer ?? null}, ${fields.plan ?? "free"}, ${fields.plan ?? "free"}, 'ops@example.test', 500)
    `
  })

describe("BillingRepository schema", () => {
  it("adds the missing columns to an older account table, keeping its rows, under concurrent starts", () =>
    upgrading.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        yield* sql`CREATE TABLE cloud_billing_account (
          organization_id text PRIMARY KEY,
          plan text NOT NULL DEFAULT 'free',
          spend_limit_cents bigint
        )`
        yield* sql`INSERT INTO cloud_billing_account (organization_id, plan, spend_limit_cents)
          VALUES ('org-old', 'pro', 4200)`
        yield* sql`CREATE TABLE cloud_billing_request (
          routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
          request_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('checkout', 'portal')),
          input text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
          url text, failure text, ambiguous boolean NOT NULL DEFAULT false,
          PRIMARY KEY (routing_key, tenant_id, actor_id, request_id)
        )`
        yield* sql`INSERT INTO cloud_billing_request (routing_key, tenant_id, actor_id, request_id, kind, input)
          VALUES (1, 'default', 'org-old', 'original', 'checkout', '{}')`

        const starts = yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.exit(migrate)),
          { concurrency: "unbounded" },
        )

        expect(starts.every(Exit.isSuccess)).toBe(true)
        yield* sql`INSERT INTO cloud_billing_request
          (routing_key, tenant_id, actor_id, request_id, kind, input, status, session_id)
          VALUES (1, 'default', 'org-old', 'change', 'plan-change', '{"tierId":"team"}', 'completed', NULL)`
        yield* sql`UPDATE cloud_billing_request SET status = 'expired', session_id = 'cs_original'
          WHERE request_id = 'original'`
        const requests = yield* sql`SELECT request_id, kind, status, session_id
          FROM cloud_billing_request ORDER BY request_id`
        expect(requests).toEqual([
          { request_id: "change", kind: "plan-change", status: "completed", session_id: null },
          {
            request_id: "original",
            kind: "checkout",
            status: "expired",
            session_id: "cs_original",
          },
        ])

        const [row] = yield* sql<AccountColumns>`
          SELECT organization_id, plan, subscribed_plan, spend_limit_cents::int AS spend_limit_cents, customer_id,
            billing_email, subscription_id, provider_updated_at::int AS provider_updated_at,
            payment_status
          FROM cloud_billing_account WHERE organization_id = 'org-old'
        `

        expect(row).toEqual({
          organization_id: "org-old",
          plan: "pro",
          subscribed_plan: "pro",
          spend_limit_cents: 4200,
          customer_id: null,
          billing_email: null,
          subscription_id: null,
          provider_updated_at: 0,
          payment_status: "free",
        })
      }),
    ))

  it("projects every state change into the account row in the same transaction", () =>
    migrated.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const repository = yield* BillingRepository

        yield* state("org-a", { customer: "cus_a", plan: "team" })

        expect(yield* repository.account("org-a")).toEqual(
          Option.some({
            organizationId: "org-a",
            plan: "team",
            subscribedPlan: "team",
            spendLimitCents: 500,
            customerId: "cus_a",
            billingEmail: "ops@example.test",
            subscriptionId: null,
            providerUpdatedAt: 0,
            paymentStatus: "free",
          }),
        )

        yield* sql`UPDATE cloud_billing_state SET plan = 'free', payment_status = 'past_due',
          provider_updated_at = 99 WHERE actor_id = 'org-a'`

        expect(yield* repository.account("org-a")).toMatchObject(
          Option.some({
            plan: "free",
            subscribedPlan: "team",
            paymentStatus: "past_due",
            providerUpdatedAt: 99,
          }),
        )

        const aborted = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`UPDATE cloud_billing_state SET plan = 'enterprise' WHERE actor_id = 'org-a'`
              return yield* Effect.die("abort")
            }),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(aborted)).toBe(true)
        expect(yield* repository.account("org-a")).toMatchObject(Option.some({ plan: "free" }))
        yield* migrate
        expect(yield* repository.account("org-a")).toMatchObject(
          Option.some({ plan: "free", subscribedPlan: "team" }),
        )
        expect(yield* repository.account("org-none")).toEqual(Option.none())
      }),
    ))

  it("binds a customer to one organization and refuses state that names another actor's organization", () =>
    migrated.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const repository = yield* BillingRepository

        yield* state("org-b", { customer: "cus_shared" })

        const second = yield* state("org-c", { customer: "cus_shared" }).pipe(Effect.exit)
        const forged = yield* sql`
          INSERT INTO cloud_billing_state (routing_key, tenant_id, actor_id, singleton, organization_id)
          VALUES (1, 'default', 'org-d', 'account', 'org-b')
        `.pipe(Effect.exit)

        expect(Exit.isFailure(second)).toBe(true)
        expect(Exit.isFailure(forged)).toBe(true)
        expect(yield* repository.organizationForCustomer("cus_shared")).toEqual(
          Option.some("org-b"),
        )
        expect(yield* repository.organizationForCustomer("cus_unknown")).toEqual(Option.none())
        expect(yield* repository.account("org-c")).toEqual(Option.none())
      }),
    ))
})

describe("customerIdOf", () => {
  const event = (data: BillingEvent["data"]): BillingEvent => ({
    id: "evt_1",
    type: "any",
    createdAt: DateTime.makeUnsafe(1),
    livemode: false,
    data,
  })

  it("names the customer by the object's own id for a customer and by its customer field otherwise", () => {
    expect(customerIdOf(event({ object: "customer", id: "cus_1", customer: "cus_other" }))).toEqual(
      Option.some("cus_1"),
    )
    expect(customerIdOf(event({ object: "subscription", id: "sub_1", customer: "cus_2" }))).toEqual(
      Option.some("cus_2"),
    )
    expect(
      customerIdOf(
        event({ object: "invoice", customer: "cus_3", metadata: { customer: "cus_4" } }),
      ),
    ).toEqual(Option.some("cus_3"))
    expect(customerIdOf(event({ object: "product", id: "prod_1" }))).toEqual(Option.none())
    expect(customerIdOf(event({ object: "subscription", customer: { id: "cus_5" } }))).toEqual(
      Option.none(),
    )
  })
})
