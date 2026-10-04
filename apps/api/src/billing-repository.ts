import type { BillingEvent } from "@akter/billing"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

/**
 * An organization's billing account as the relational read model holds it.
 * `plan` is the plan whose entitlements apply now, which is `free` while a
 * paid subscription's payment has failed; `providerUpdatedAt` is the
 * milliseconds timestamp of the provider reading it was last derived from.
 */
export interface BillingAccount {
  readonly organizationId: string
  readonly plan: string
  readonly subscribedPlan: string
  readonly spendLimitCents: number | null
  readonly customerId: string | null
  readonly billingEmail: string | null
  readonly subscriptionId: string | null
  readonly providerUpdatedAt: number
  readonly paymentStatus: string
}

/**
 * Serializes concurrent starts across the API and the edge, which create
 * `cloud_billing_account` too: `CREATE TABLE IF NOT EXISTS` alone races when
 * two processes create the same table at once. It is the edge's lock.
 */
const SCHEMA_LOCK = 7_243_001

/**
 * The billing tables in creation order. `cloud_billing_account` repeats the
 * edge's definition so either process may start first, and each column added
 * after its first release is also added to a table an older release made.
 *
 * `cloud_billing_state`, `cloud_billing_request` and `cloud_billing_event` are
 * the `BillingActor`'s owned tables: their first three columns and the primary
 * key prefix are the ownership scope the framework requires, and none has a
 * foreign key. `cloud_billing_state` carries the account's authority, and its
 * trigger writes the account row in the same statement's transaction, so a turn
 * commits the plan and the actor receipt together or neither.
 */
const migrations: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS cloud_billing_account (
    organization_id text PRIMARY KEY,
    plan text NOT NULL DEFAULT 'free',
    subscribed_plan text NOT NULL DEFAULT 'free',
    spend_limit_cents bigint,
    customer_id text,
    billing_email text,
    subscription_id text,
    provider_updated_at bigint NOT NULL DEFAULT 0,
    payment_status text NOT NULL DEFAULT 'free'
  )`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'cloud_billing_account'
        AND column_name = 'subscribed_plan') THEN
      ALTER TABLE cloud_billing_account ADD COLUMN subscribed_plan text;
      UPDATE cloud_billing_account SET subscribed_plan = plan;
      ALTER TABLE cloud_billing_account ALTER COLUMN subscribed_plan SET DEFAULT 'free';
      ALTER TABLE cloud_billing_account ALTER COLUMN subscribed_plan SET NOT NULL;
    END IF;
  END $$`,
  `ALTER TABLE cloud_billing_account ADD COLUMN IF NOT EXISTS customer_id text`,
  `ALTER TABLE cloud_billing_account ADD COLUMN IF NOT EXISTS billing_email text`,
  `ALTER TABLE cloud_billing_account ADD COLUMN IF NOT EXISTS subscription_id text`,
  `ALTER TABLE cloud_billing_account ADD COLUMN IF NOT EXISTS provider_updated_at bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE cloud_billing_account ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'free'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cloud_billing_account_customer
    ON cloud_billing_account (customer_id) WHERE customer_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS cloud_billing_state (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    singleton text NOT NULL CHECK (singleton = 'account'),
    organization_id text NOT NULL CHECK (organization_id <> '' AND organization_id = actor_id),
    customer_id text,
    customer_pending boolean NOT NULL DEFAULT false,
    billing_email text,
    billing_name text,
    subscription_id text,
    subscribed_plan text NOT NULL DEFAULT 'free'
      CHECK (subscribed_plan IN ('free', 'pro', 'team', 'enterprise')),
    plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
    spend_limit_cents bigint CHECK (spend_limit_cents >= 0),
    payment_status text NOT NULL DEFAULT 'free'
      CHECK (payment_status IN ('free', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete')),
    provider_updated_at bigint NOT NULL DEFAULT 0,
    reconcile_seq bigint NOT NULL DEFAULT 0,
    applied_seq bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (routing_key, tenant_id, actor_id, singleton)
  )`,
  `CREATE TABLE IF NOT EXISTS cloud_billing_request (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    request_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('checkout', 'portal', 'plan-change')),
    input text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'completed', 'expired')),
    url text,
    session_id text,
    failure text,
    ambiguous boolean NOT NULL DEFAULT false,
    PRIMARY KEY (routing_key, tenant_id, actor_id, request_id)
  )`,
  `ALTER TABLE cloud_billing_request ADD COLUMN IF NOT EXISTS session_id text`,
  `ALTER TABLE cloud_billing_request DROP CONSTRAINT IF EXISTS cloud_billing_request_kind_check`,
  `ALTER TABLE cloud_billing_request ADD CONSTRAINT cloud_billing_request_kind_check
    CHECK (kind IN ('checkout', 'portal', 'plan-change'))`,
  `ALTER TABLE cloud_billing_request DROP CONSTRAINT IF EXISTS cloud_billing_request_status_check`,
  `ALTER TABLE cloud_billing_request ADD CONSTRAINT cloud_billing_request_status_check
    CHECK (status IN ('pending', 'ready', 'failed', 'completed', 'expired'))`,
  `CREATE TABLE IF NOT EXISTS cloud_billing_event (
    routing_key bigint NOT NULL,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    customer_id text NOT NULL,
    occurred_at bigint NOT NULL,
    PRIMARY KEY (routing_key, tenant_id, actor_id, event_id)
  )`,
  `CREATE OR REPLACE FUNCTION cloud_billing_project() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO cloud_billing_account (
      organization_id, plan, subscribed_plan, spend_limit_cents, customer_id, billing_email,
      subscription_id, provider_updated_at, payment_status
    ) VALUES (
      NEW.organization_id, NEW.plan, NEW.subscribed_plan, NEW.spend_limit_cents, NEW.customer_id, NEW.billing_email,
      NEW.subscription_id, NEW.provider_updated_at, NEW.payment_status
    )
    ON CONFLICT (organization_id) DO UPDATE SET
      plan = EXCLUDED.plan,
      subscribed_plan = EXCLUDED.subscribed_plan,
      spend_limit_cents = EXCLUDED.spend_limit_cents,
      customer_id = EXCLUDED.customer_id,
      billing_email = EXCLUDED.billing_email,
      subscription_id = EXCLUDED.subscription_id,
      provider_updated_at = EXCLUDED.provider_updated_at,
      payment_status = EXCLUDED.payment_status;
    RETURN NULL;
  END;
  $$`,
  `CREATE OR REPLACE TRIGGER cloud_billing_project
    AFTER INSERT OR UPDATE ON cloud_billing_state
    FOR EACH ROW EXECUTE FUNCTION cloud_billing_project()`,
]

const CustomerObject = Schema.Struct({ object: Schema.Literal("customer"), id: Schema.String })

const CustomerOwned = Schema.Struct({ customer: Schema.String })

/**
 * The customer a verified provider event is about: a customer object is
 * itself the customer, any other object names its customer. Events that name
 * none, or whose `customer` is not a plain id, have none.
 */
export const customerIdOf = (event: BillingEvent): Option.Option<string> =>
  Option.orElse(
    Option.map(Schema.decodeUnknownOption(CustomerObject)(event.data), ({ id }) => id),
    () =>
      Option.map(Schema.decodeUnknownOption(CustomerOwned)(event.data), ({ customer }) => customer),
  )

interface AccountRow {
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

/**
 * Reads of the billing account read model. The model is written only by the
 * `BillingActor`'s state trigger, so a row here is always a committed actor
 * state. A database failure is a defect.
 */
export class BillingRepository extends Context.Service<
  BillingRepository,
  {
    /** The organization's account, or none before its actor was initialized. */
    readonly account: (organizationId: string) => Effect.Effect<Option.Option<BillingAccount>>
    /**
     * The organization a provider customer is durably bound to. A customer with
     * no binding has no organization: provider metadata never names one.
     */
    readonly organizationForCustomer: (customerId: string) => Effect.Effect<Option.Option<string>>
  }
>()("@akter/api/billing-repository/BillingRepository") {}

/**
 * `BillingRepository` over the control-plane database; building it creates or
 * upgrades the billing tables under one advisory transaction lock, so it must
 * be built before any layer of the `BillingActor`.
 */
export const BillingRepositoryLive = Layer.effect(
  BillingRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK})`

          for (const statement of migrations) yield* sql.unsafe(statement)
        }),
      )
      .pipe(Effect.orDie)

    return {
      account: (organizationId) =>
        sql<AccountRow>`
          SELECT organization_id, plan, subscribed_plan, spend_limit_cents::float8 AS spend_limit_cents, customer_id,
            billing_email, subscription_id, provider_updated_at::float8 AS provider_updated_at,
            payment_status
          FROM cloud_billing_account WHERE organization_id = ${organizationId}
        `.pipe(
          Effect.map(([row]) =>
            Option.fromNullishOr(row).pipe(
              Option.map((found) => ({
                organizationId: found.organization_id,
                plan: found.plan,
                subscribedPlan: found.subscribed_plan,
                spendLimitCents: found.spend_limit_cents,
                customerId: found.customer_id,
                billingEmail: found.billing_email,
                subscriptionId: found.subscription_id,
                providerUpdatedAt: found.provider_updated_at,
                paymentStatus: found.payment_status,
              })),
            ),
          ),
          Effect.orDie,
        ),
      organizationForCustomer: (customerId) =>
        sql<{ readonly organization_id: string }>`
          SELECT organization_id FROM cloud_billing_account WHERE customer_id = ${customerId}
        `.pipe(
          Effect.map(([row]) => Option.fromNullishOr(row?.organization_id)),
          Effect.orDie,
        ),
    }
  }),
)
