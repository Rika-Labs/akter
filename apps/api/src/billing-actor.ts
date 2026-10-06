import {
  type BillingEvent,
  type BillingProviderError,
  type CatalogNotReady,
  type CheckoutExpired,
  type HostedSession,
  type PlanId,
  Pricing,
  StripeBilling,
  type UnknownCustomer,
  type UnknownTier,
  UnknownPlan,
} from "@akter/billing"
import { Actor } from "@rikalabs/akter"
import { Actors, Database, type Options } from "@rikalabs/akter/runtime"
import { bigint, boolean, pgTable, text } from "drizzle-orm/pg-core"
import { DateTime, Effect, Layer, Match, Option, Predicate, type Redacted, Schema } from "effect"
import { BillingRepository, BillingRepositoryLive, customerIdOf } from "./billing-repository.ts"

const PLANS = ["free", "pro", "team", "enterprise"] as const

const PAYMENT_STATUSES = ["free", "active", "past_due", "unpaid", "canceled", "incomplete"] as const

/** An organization id: the `BillingActor` key and the account's primary key. */
export const OrganizationId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/u))

/** A caller-chosen identity for a checkout or portal request, stable across retries. */
export const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/u))

const Plan = Schema.Literals(PLANS)

/** The plans checkout sells; `free` is reached by cancelling. */
const PaidPlan = Schema.Literals(["pro", "team", "enterprise"])

const PaymentStatus = Schema.Literals(PAYMENT_STATUSES)

const Url = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u))

const Email = Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/u))

const Cents = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const SubscriptionState = Schema.Struct({
  subscriptionId: Schema.String,
  tierId: Schema.String,
  status: Schema.Literals([
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "paused",
  ]),
})

/**
 * The actor's authority over one organization's billing: one row per actor.
 * The migration's trigger copies each change into the relational
 * `cloud_billing_account` the edge and API read, in the same transaction.
 * `plan` is the plan whose entitlements apply and `subscribedPlan` the one the
 * provider subscription is for; they differ while payment has failed.
 * `reconcileSeq` numbers the reconcile jobs the actor enqueued and `appliedSeq`
 * the newest whose result it applied, so a late result never overwrites a
 * newer one.
 */
export const billingState = Actor.table(
  pgTable("cloud_billing_state", {
    singleton: text("singleton").primaryKey(),
    organizationId: text("organization_id").notNull(),
    customerId: text("customer_id"),
    customerPending: boolean("customer_pending").notNull().default(false),
    billingEmail: text("billing_email"),
    billingName: text("billing_name"),
    subscriptionId: text("subscription_id"),
    subscribedPlan: text("subscribed_plan", { enum: PLANS }).notNull().default("free"),
    plan: text("plan", { enum: PLANS }).notNull().default("free"),
    spendLimitCents: bigint("spend_limit_cents", { mode: "number" }),
    paymentStatus: text("payment_status", { enum: PAYMENT_STATUSES }).notNull().default("free"),
    providerUpdatedAt: bigint("provider_updated_at", { mode: "number" }).notNull().default(0),
    reconcileSeq: bigint("reconcile_seq", { mode: "number" }).notNull().default(0),
    appliedSeq: bigint("applied_seq", { mode: "number" }).notNull().default(0),
  }),
)

/** Checkout and portal requests by their caller-chosen identity, with the job's durable outcome. */
export const billingRequest = Actor.table(
  pgTable("cloud_billing_request", {
    requestId: text("request_id").primaryKey(),
    kind: text("kind", { enum: ["checkout", "portal", "plan-change"] }).notNull(),
    input: text("input").notNull(),
    status: text("status", { enum: ["pending", "ready", "failed", "completed", "expired"] })
      .notNull()
      .default("pending"),
    url: text("url"),
    sessionId: text("session_id"),
    failure: text("failure"),
    ambiguous: boolean("ambiguous").notNull().default(false),
  }),
)

/** The provider events the actor has taken, by event id: a retried delivery finds its row. */
export const billingEvent = Actor.table(
  pgTable("cloud_billing_event", {
    eventId: text("event_id").primaryKey(),
    eventType: text("event_type").notNull(),
    customerId: text("customer_id").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
  }),
)

/** The account has no actor state yet: `InitializeAccount` has not run. */
export class AccountNotInitialized extends Schema.TaggedError<AccountNotInitialized>()(
  "AccountNotInitialized",
  { organizationId: Schema.String },
) {}

/** The account has no provider customer yet; `InitializeAccount` starts creating one. */
export class CustomerNotBound extends Schema.TaggedError<CustomerNotBound>()("CustomerNotBound", {
  organizationId: Schema.String,
}) {}

/** The request id was used before with different input. */
export class RequestConflict extends Schema.TaggedError<RequestConflict>()("RequestConflict", {
  requestId: Schema.String,
}) {}

/** A checkout cannot create another subscription while an earlier checkout or subscription is live. */
export class CheckoutBlocked extends Schema.TaggedError<CheckoutBlocked>()("CheckoutBlocked", {
  organizationId: Schema.String,
  reason: Schema.Literals(["active_subscription", "pending_checkout", "ambiguous_checkout"]),
  requestId: Schema.NullOr(Schema.String),
}) {}

/** A plan change requires a canonically observed subscription. */
export class NoActiveSubscription extends Schema.TaggedError<NoActiveSubscription>()(
  "NoActiveSubscription",
  { organizationId: Schema.String },
) {}

/** The event names a customer other than the one bound to this organization. */
export class CustomerMismatch extends Schema.TaggedError<CustomerMismatch>()("CustomerMismatch", {
  customerId: Schema.String,
}) {}

/** The event names a customer no organization is bound to. */
export class UnboundCustomer extends Schema.TaggedError<UnboundCustomer>()("UnboundCustomer", {
  customerId: Schema.String,
}) {}

/** One organization's billing account, as the actor holds it. */
export const Account = Schema.Struct({
  organizationId: Schema.String,
  plan: Plan,
  subscribedPlan: Plan,
  customerId: Schema.NullOr(Schema.String),
  subscriptionId: Schema.NullOr(Schema.String),
  billingEmail: Schema.NullOr(Schema.String),
  spendLimitCents: Schema.NullOr(Schema.Int),
  paymentStatus: PaymentStatus,
  providerUpdatedAt: Schema.Int,
})

/** A checkout or portal request: `url` is set once `ready`, `failure` once `failed`. */
export const RequestView = Schema.Struct({
  requestId: Schema.String,
  kind: Schema.Literals(["checkout", "portal", "plan-change"]),
  status: Schema.Literals(["pending", "ready", "failed", "completed", "expired"]),
  url: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  ambiguous: Schema.Boolean,
})

/** What `RecordWebhook` did with an event. */
export const WebhookOutcome = Schema.Literals(["queued", "duplicate", "ignored"])

const AccountErrors = Schema.Union([AccountNotInitialized])

/**
 * Creates the account on first use (plan `free`, no spend limit) and, until a
 * provider customer is bound, starts the job that creates one. Calling it
 * again returns the account and, if no customer job is outstanding, restarts it.
 */
export const InitializeAccount = Actor.command("InitializeAccount", {
  payload: { email: Email, name: Schema.optionalKey(Schema.String) },
  success: Account,
})

/** Sets the monthly spend limit in cents, or removes it with `null`. */
export const SetSpendLimit = Actor.command("SetSpendLimit", {
  payload: { cents: Schema.NullOr(Cents) },
  success: Account,
  error: AccountErrors,
})

/**
 * Records a checkout request and enqueues the job that asks the provider for
 * the hosted page; the outcome is read with `GetRequest`. The same `requestId`
 * and input returns the existing request. A failed ambiguous checkout can be
 * retried under that same identity; provider lookups and idempotency recover
 * its session without permitting a second initial checkout.
 */
export const StartCheckout = Actor.command("StartCheckout", {
  payload: { requestId: RequestId, tierId: PaidPlan, successUrl: Url, cancelUrl: Url },
  success: RequestView,
  error: Schema.Union([
    AccountNotInitialized,
    CustomerNotBound,
    RequestConflict,
    UnknownPlan,
    CheckoutBlocked,
  ]),
})

/** Changes the existing provider subscription, then reads canonical state before changing entitlements. */
export const ChangePlan = Actor.command("ChangePlan", {
  payload: { requestId: RequestId, tierId: PaidPlan },
  success: RequestView,
  error: Schema.Union([
    AccountNotInitialized,
    CustomerNotBound,
    RequestConflict,
    UnknownPlan,
    NoActiveSubscription,
  ]),
})

/** Records a customer-portal request, like `StartCheckout`. */
export const OpenPortal = Actor.command("OpenPortal", {
  payload: { requestId: RequestId, returnUrl: Url },
  success: RequestView,
  error: Schema.Union([AccountNotInitialized, CustomerNotBound, RequestConflict]),
})

/**
 * Takes a verified provider event for the bound customer. The event is only a
 * trigger: it is recorded once by id, and a job then reads the customer's
 * subscription from the provider and applies that.
 */
export const RecordWebhook = Actor.command("RecordWebhook", {
  payload: {
    eventId: Schema.String,
    eventType: Schema.String,
    customerId: Schema.String,
    occurredAt: Schema.Int,
    sessionId: Schema.optionalKey(Schema.String),
  },
  success: WebhookOutcome,
  error: Schema.Union([AccountNotInitialized, CustomerMismatch]),
})

/** The account, or undefined before `InitializeAccount`. */
export const GetAccount = Actor.query("GetAccount", { success: Schema.UndefinedOr(Account) })

/** A checkout or portal request, or undefined when this id was never requested. */
export const GetRequest = Actor.query("GetRequest", {
  payload: { requestId: RequestId },
  success: Schema.UndefinedOr(RequestView),
})

/** Creates the provider customer for the organization; the provider returns the same one on every attempt. */
export const EnsureCustomer = Actor.job("EnsureCustomer", {
  payload: {
    organizationId: Schema.String,
    email: Schema.String,
    name: Schema.NullOr(Schema.String),
  },
  success: Schema.Struct({ customerId: Schema.String }),
})

const SessionResult = Schema.Union([
  Schema.TaggedStruct("Ready", {
    requestId: Schema.String,
    url: Schema.String,
    sessionId: Schema.String,
  }),
  Schema.TaggedStruct("Rejected", {
    requestId: Schema.String,
    reason: Schema.String,
    ambiguous: Schema.Boolean,
  }),
])

/** Replaces the existing subscription's tier using a durable request identity. */
export const UpdateSubscription = Actor.job("UpdateSubscription", {
  payload: {
    requestId: Schema.String,
    organizationId: Schema.String,
    customerId: Schema.String,
    subscriptionId: Schema.String,
    tierId: Schema.String,
  },
  success: Schema.Union([
    Schema.TaggedStruct("Changed", { requestId: Schema.String, customerId: Schema.String }),
    Schema.TaggedStruct("Rejected", {
      requestId: Schema.String,
      reason: Schema.String,
      ambiguous: Schema.Boolean,
    }),
  ]),
})

/** Asks the provider for a hosted checkout page; the provider idempotency key derives from the request id. */
export const CreateCheckout = Actor.job("CreateCheckout", {
  payload: {
    requestId: Schema.String,
    organizationId: Schema.String,
    customerId: Schema.String,
    tierId: Schema.String,
    successUrl: Schema.String,
    cancelUrl: Schema.String,
  },
  success: SessionResult,
})

/** Asks the provider for a customer-portal page, like `CreateCheckout`. */
export const CreatePortal = Actor.job("CreatePortal", {
  payload: {
    requestId: Schema.String,
    organizationId: Schema.String,
    customerId: Schema.String,
    returnUrl: Schema.String,
  },
  success: SessionResult,
})

/** Reads the customer's current subscription from the provider; `seq` orders results. */
export const ReconcileSubscription = Actor.job("ReconcileSubscription", {
  payload: { customerId: Schema.String, seq: Schema.Int },
  success: Schema.Struct({
    customerId: Schema.String,
    seq: Schema.Int,
    observedAt: Schema.Int,
    subscription: Schema.NullOr(SubscriptionState),
  }),
})

const Applied = Schema.Literals(["applied", "stale", "ignored"])

const CustomerBound = Actor.command("CustomerBound", {
  payload: { customerId: Schema.String },
  success: Applied,
})

const EnsureCustomerFailed = Actor.command("EnsureCustomerFailed", {
  payload: Actor.DeadLetter(EnsureCustomer),
})

const RequestResolved = Actor.command("RequestResolved", { payload: SessionResult })

const CheckoutFailed = Actor.command("CheckoutFailed", {
  payload: Actor.DeadLetter(CreateCheckout),
})

const PortalFailed = Actor.command("PortalFailed", { payload: Actor.DeadLetter(CreatePortal) })

const PlanChanged = Actor.command("PlanChanged", { payload: UpdateSubscription.success })

const PlanChangeFailed = Actor.command("PlanChangeFailed", {
  payload: Actor.DeadLetter(UpdateSubscription),
})

const Refresh = Actor.command("Refresh")

const SubscriptionReconciled = Actor.command("SubscriptionReconciled", {
  payload: ReconcileSubscription.success,
  success: Applied,
})

/**
 * The billing authority of one organization, keyed by organization id. Its
 * turns write the account, the request and the event tables; every provider
 * call is a job whose result returns through an internal command. A trigger
 * projects the account into `cloud_billing_account`, so it is
 * authority-placed: its rows commit with that table on one shard.
 */
export const BillingActor = Actor.make("BillingActor", {
  key: OrganizationId,
  placement: "authority",
  tables: [billingState, billingRequest, billingEvent],
  api: {
    InitializeAccount,
    SetSpendLimit,
    StartCheckout,
    ChangePlan,
    OpenPortal,
    RecordWebhook,
    GetAccount,
    GetRequest,
  },
  internal: {
    CustomerBound,
    EnsureCustomerFailed,
    RequestResolved,
    CheckoutFailed,
    PortalFailed,
    PlanChanged,
    PlanChangeFailed,
    Refresh,
    SubscriptionReconciled,
  },
  jobs: {
    EnsureCustomer: {
      job: EnsureCustomer,
      onSuccess: CustomerBound,
      onDeadLetter: EnsureCustomerFailed,
    },
    CreateCheckout: {
      job: CreateCheckout,
      onSuccess: RequestResolved,
      onDeadLetter: CheckoutFailed,
    },
    CreatePortal: { job: CreatePortal, onSuccess: RequestResolved, onDeadLetter: PortalFailed },
    UpdateSubscription: {
      job: UpdateSubscription,
      onSuccess: PlanChanged,
      onDeadLetter: PlanChangeFailed,
    },
    ReconcileSubscription: {
      job: ReconcileSubscription,
      onSuccess: SubscriptionReconciled,
      concurrency: { perActor: 1 },
    },
  },
  schedules: { "@every 1 hour": Refresh },
})

type Owned = "routing_key" | "tenant_id" | "actor_id"

type State = Omit<typeof billingState.$inferSelect, Owned>

type Request = Omit<typeof billingRequest.$inferSelect, Owned>

const account = (state: State): typeof Account.Type => ({
  organizationId: state.organizationId,
  plan: state.plan,
  subscribedPlan: state.subscribedPlan,
  customerId: state.customerId,
  subscriptionId: state.subscriptionId,
  billingEmail: state.billingEmail,
  spendLimitCents: state.spendLimitCents,
  paymentStatus: state.paymentStatus,
  providerUpdatedAt: state.providerUpdatedAt,
})

const requestView = (request: Request): typeof RequestView.Type => ({
  requestId: request.requestId,
  kind: request.kind,
  status: request.status,
  url: request.url,
  sessionId: request.sessionId,
  failure: request.failure,
  ambiguous: request.ambiguous,
})

const SINGLETON = "account"

const CheckoutInputText = Schema.fromJsonString(
  Schema.Struct({ tierId: PaidPlan, successUrl: Url, cancelUrl: Url }),
)

const PortalInputText = Schema.fromJsonString(Schema.Struct({ returnUrl: Url }))

const PlanChangeInputText = Schema.fromJsonString(Schema.Struct({ tierId: PaidPlan }))

const checkoutInput = (input: typeof CheckoutInputText.Type) =>
  Schema.encodeEffect(CheckoutInputText)(input).pipe(Effect.orDie)

const portalInput = (input: typeof PortalInputText.Type) =>
  Schema.encodeEffect(PortalInputText)(input).pipe(Effect.orDie)

/** Provider event types that can change a subscription or its payment state. */
const changesSubscription = (type: string) =>
  type.startsWith("customer.subscription.") ||
  type.startsWith("invoice.") ||
  type.startsWith("checkout.session.")

const changesEntitlements = (status: (typeof SubscriptionState.Type)["status"]) =>
  status !== "canceled" && status !== "incomplete_expired"

interface Settled {
  readonly plan: PlanId
  readonly subscribedPlan: PlanId
  readonly subscriptionId: string | null
  readonly paymentStatus: (typeof PAYMENT_STATUSES)[number]
}

/**
 * The account fields a provider subscription implies. No subscription, or one
 * that is canceled or expired, is the free plan. An unpaid or paused one is the
 * free plan too, and a past-due one is while `revokeOnPastDue` holds; an
 * incomplete one keeps its subscription identity and the current entitlements.
 */
const settle = (
  state: State,
  subscription: typeof SubscriptionState.Type | null,
  tier: PlanId | undefined,
  revokeOnPastDue: boolean,
): Settled => {
  const current: Settled = {
    plan: state.plan,
    subscribedPlan: state.subscribedPlan,
    subscriptionId: state.subscriptionId,
    paymentStatus: state.paymentStatus,
  }
  const ended: Settled = {
    plan: "free",
    subscribedPlan: "free",
    subscriptionId: null,
    paymentStatus:
      state.subscriptionId !== null || state.paymentStatus === "canceled" ? "canceled" : "free",
  }

  if (subscription === null || !changesEntitlements(subscription.status)) return ended

  if (tier === undefined) return current

  const subscribed = { subscribedPlan: tier, subscriptionId: subscription.subscriptionId }

  switch (subscription.status) {
    case "active":
    case "trialing":
      return { ...subscribed, plan: tier, paymentStatus: "active" }
    case "past_due":
      return { ...subscribed, plan: revokeOnPastDue ? "free" : tier, paymentStatus: "past_due" }
    case "unpaid":
    case "paused":
      return { ...subscribed, plan: "free", paymentStatus: "unpaid" }
    case "incomplete":
      return { ...subscribed, plan: state.plan, paymentStatus: "incomplete" }
  }
}

export interface BillingActorOptions {
  /**
   * Whether a failed payment (`past_due`) removes the paid plan's entitlements
   * at once. Default true; set false to keep them through the provider's
   * retries, after which the subscription is `unpaid` and they are removed.
   */
  readonly revokeOnPastDue?: boolean
}

/**
 * Command handlers of `BillingActor`. Each turn writes its tables and
 * stages jobs; nothing here calls the provider.
 */
export const BillingActorCommands = (options: BillingActorOptions = {}) =>
  BillingActor.toLayer(
    Effect.gen(function* () {
      const pricing = yield* Pricing
      const revokeOnPastDue = options.revokeOnPastDue ?? true

      const loadState = Effect.gen(function* () {
        const turn = yield* BillingActor.Turn
        const state = yield* turn.rows(billingState).one()

        if (Option.isNone(state))
          return yield* AccountNotInitialized.make({ organizationId: turn.id })

        return state.value
      })

      const request = Effect.fnUntraced(function* <E, R>(
        requestId: string,
        kind: "checkout" | "portal" | "plan-change",
        input: string,
        stage: (state: State) => Effect.Effect<void, E, R>,
      ) {
        const turn = yield* BillingActor.Turn
        const state = yield* loadState

        if (state.customerId === null)
          return yield* CustomerNotBound.make({ organizationId: turn.id })

        const requests = turn.rows(billingRequest)
        const existing = yield* requests.one({ where: { requestId } })

        if (Option.isSome(existing)) {
          if (existing.value.kind !== kind || existing.value.input !== input)
            return yield* RequestConflict.make({ requestId })

          if (
            kind === "checkout" &&
            existing.value.status === "failed" &&
            existing.value.ambiguous
          ) {
            yield* stage(state)
            yield* requests.update({ status: "pending", failure: null }).where({ requestId })
            return requestView({ ...existing.value, status: "pending", failure: null })
          }

          return requestView(existing.value)
        }

        yield* stage(state)
        yield* requests.insert({ requestId, kind, input })

        return requestView({
          requestId,
          kind,
          input,
          status: "pending",
          url: null,
          sessionId: null,
          failure: null,
          ambiguous: false,
        })
      })

      const settleRequest = Effect.fnUntraced(function* (
        requestId: string,
        outcome: {
          readonly status: "ready" | "failed"
          readonly url?: string
          readonly sessionId?: string
          readonly failure?: string
          readonly ambiguous?: boolean
        },
      ) {
        const turn = yield* BillingActor.Turn
        const requests = turn.rows(billingRequest)
        const existing = yield* requests.one({ where: { requestId } })

        if (Option.isNone(existing)) return

        if (existing.value.status !== "pending") {
          if (
            existing.value.status === "completed" &&
            outcome.status === "ready" &&
            existing.value.sessionId === null
          )
            yield* requests
              .update({ url: outcome.url, sessionId: outcome.sessionId })
              .where({ requestId })

          return
        }

        if (existing.value.kind === "checkout" && outcome.failure === "checkout_expired") {
          yield* requests
            .update({ ...outcome, status: "expired", ambiguous: false })
            .where({ requestId })
          return
        }

        yield* requests
          .update({
            ...outcome,
            ambiguous:
              existing.value.kind === "checkout" &&
              existing.value.ambiguous &&
              outcome.status === "failed"
                ? true
                : (outcome.ambiguous ?? existing.value.ambiguous),
          })
          .where({ requestId })
      })

      const refresh = Effect.gen(function* () {
        const turn = yield* BillingActor.Turn
        const rows = turn.rows(billingState)
        const found = yield* rows.one()

        if (Option.isNone(found) || found.value.customerId === null) return

        const seq = found.value.reconcileSeq + 1

        yield* rows.update({ reconcileSeq: seq }).where({})
        yield* turn.enqueue(ReconcileSubscription.make({ customerId: found.value.customerId, seq }))
      })

      return {
        InitializeAccount: Effect.fnUntraced(function* ({ email, name }) {
          const turn = yield* BillingActor.Turn
          const rows = turn.rows(billingState)
          const existing = yield* rows.one()

          const current: State = Option.isSome(existing)
            ? existing.value
            : {
                singleton: SINGLETON,
                organizationId: turn.id,
                customerId: null,
                customerPending: false,
                billingEmail: email,
                billingName: name ?? null,
                subscriptionId: null,
                subscribedPlan: "free",
                plan: "free",
                spendLimitCents: null,
                paymentStatus: "free",
                providerUpdatedAt: 0,
                reconcileSeq: 0,
                appliedSeq: 0,
              }

          if (current.customerId !== null || current.customerPending) return account(current)

          const state: State = {
            ...current,
            customerPending: true,
            billingEmail: email,
            billingName: name ?? null,
          }

          if (Option.isSome(existing))
            yield* rows
              .update({
                customerPending: true,
                billingEmail: state.billingEmail,
                billingName: state.billingName,
              })
              .where({})
          else yield* rows.insert(state)

          yield* turn.enqueue(
            EnsureCustomer.make({ organizationId: turn.id, email, name: name ?? null }),
          )

          return account(state)
        }),
        SetSpendLimit: Effect.fnUntraced(function* ({ cents }) {
          const turn = yield* BillingActor.Turn
          const state = yield* loadState

          yield* turn.rows(billingState).update({ spendLimitCents: cents }).where({})

          return account({ ...state, spendLimitCents: cents })
        }),
        StartCheckout: Effect.fnUntraced(function* ({ requestId, tierId, successUrl, cancelUrl }) {
          const turn = yield* BillingActor.Turn

          yield* pricing.tier(tierId)

          return yield* request(
            requestId,
            "checkout",
            yield* checkoutInput({ tierId, successUrl, cancelUrl }),
            (state) =>
              Effect.gen(function* () {
                const checkouts = yield* turn
                  .rows(billingRequest)
                  .all({ where: { kind: "checkout" } })

                if (state.subscriptionId !== null)
                  return yield* CheckoutBlocked.make({
                    organizationId: turn.id,
                    reason: "active_subscription",
                    requestId: null,
                  })

                const outstanding = checkouts.find(
                  (found) =>
                    found.requestId !== requestId &&
                    (found.status === "pending" ||
                      found.status === "ready" ||
                      (found.status === "failed" && found.ambiguous)),
                )

                if (outstanding !== undefined)
                  return yield* CheckoutBlocked.make({
                    organizationId: turn.id,
                    reason: outstanding.ambiguous ? "ambiguous_checkout" : "pending_checkout",
                    requestId: outstanding.requestId,
                  })

                yield* turn.enqueue(
                  CreateCheckout.make({
                    requestId,
                    organizationId: turn.id,
                    customerId: state.customerId ?? "",
                    tierId,
                    successUrl,
                    cancelUrl,
                  }),
                )
              }),
          )
        }),
        ChangePlan: Effect.fnUntraced(function* ({ requestId, tierId }) {
          const turn = yield* BillingActor.Turn

          yield* pricing.tier(tierId)

          return yield* request(
            requestId,
            "plan-change",
            yield* Schema.encodeEffect(PlanChangeInputText)({ tierId }).pipe(Effect.orDie),
            (state) =>
              Effect.gen(function* () {
                if (state.subscriptionId === null)
                  return yield* NoActiveSubscription.make({ organizationId: turn.id })

                yield* turn.enqueue(
                  UpdateSubscription.make({
                    requestId,
                    organizationId: turn.id,
                    customerId: state.customerId ?? "",
                    subscriptionId: state.subscriptionId,
                    tierId,
                  }),
                )
              }),
          )
        }),
        OpenPortal: Effect.fnUntraced(function* ({ requestId, returnUrl }) {
          const turn = yield* BillingActor.Turn

          return yield* request(requestId, "portal", yield* portalInput({ returnUrl }), (state) =>
            turn.enqueue(
              CreatePortal.make({
                requestId,
                organizationId: turn.id,
                customerId: state.customerId ?? "",
                returnUrl,
              }),
            ),
          )
        }),
        RecordWebhook: Effect.fnUntraced(function* ({
          eventId,
          eventType,
          customerId,
          occurredAt,
          sessionId,
        }) {
          const turn = yield* BillingActor.Turn
          const state = yield* loadState

          if (state.customerId === null || state.customerId !== customerId)
            return yield* CustomerMismatch.make({ customerId })

          const events = turn.rows(billingEvent)

          if (Option.isSome(yield* events.one({ where: { eventId } }))) return "duplicate" as const

          yield* events.insert({ eventId, eventType, customerId, occurredAt })

          if (eventType === "checkout.session.expired" && sessionId !== undefined) {
            const requests = turn.rows(billingRequest)
            const expired = yield* requests.one({ where: { kind: "checkout", sessionId } })

            if (
              Option.isSome(expired) &&
              (expired.value.status === "ready" ||
                expired.value.status === "pending" ||
                (expired.value.status === "failed" && expired.value.ambiguous))
            )
              yield* requests
                .update({ status: "expired", ambiguous: false })
                .where({ requestId: expired.value.requestId })
          }

          if (!changesSubscription(eventType)) return "ignored" as const

          const seq = state.reconcileSeq + 1

          yield* turn.rows(billingState).update({ reconcileSeq: seq }).where({})
          yield* turn.enqueue(ReconcileSubscription.make({ customerId, seq }))

          return "queued" as const
        }),
        CustomerBound: Effect.fnUntraced(function* ({ customerId }) {
          const turn = yield* BillingActor.Turn
          const rows = turn.rows(billingState)
          const state = yield* rows.one()

          if (Option.isNone(state)) return "ignored" as const

          if (state.value.customerId !== null)
            return state.value.customerId === customerId
              ? ("applied" as const)
              : ("ignored" as const)

          yield* rows.update({ customerId, customerPending: false }).where({})

          return "applied" as const
        }),
        EnsureCustomerFailed: Effect.fnUntraced(function* () {
          const turn = yield* BillingActor.Turn

          yield* turn.rows(billingState).update({ customerPending: false }).where({})
        }),
        RequestResolved: (result) =>
          Match.value(result).pipe(
            Match.tag("Ready", ({ requestId, url, sessionId }) =>
              settleRequest(requestId, { status: "ready", url, sessionId, ambiguous: false }),
            ),
            Match.tag("Rejected", ({ requestId, reason, ambiguous }) =>
              Effect.gen(function* () {
                yield* settleRequest(requestId, { status: "failed", failure: reason, ambiguous })
                yield* refresh
              }),
            ),
            Match.exhaustive,
          ),
        CheckoutFailed: ({ job, cause }) =>
          Effect.gen(function* () {
            yield* settleRequest(job.requestId, {
              status: "failed",
              failure: cause,
              ambiguous: true,
            })
            yield* refresh
          }),
        PortalFailed: ({ job, cause, ambiguous }) =>
          settleRequest(job.requestId, { status: "failed", failure: cause, ambiguous }),
        PlanChanged: Effect.fnUntraced(function* (result) {
          if (Predicate.isTagged(result, "Rejected")) {
            yield* settleRequest(result.requestId, {
              status: "failed",
              failure: result.reason,
              ambiguous: result.ambiguous,
            })
            return
          }

          const turn = yield* BillingActor.Turn
          const found = yield* turn.rows(billingState).one()

          if (Option.isNone(found)) return

          const state = found.value
          const requests = turn.rows(billingRequest)
          const existing = yield* requests.one({
            where: { requestId: result.requestId, kind: "plan-change" },
          })

          if (
            state.customerId !== result.customerId ||
            Option.isNone(existing) ||
            existing.value.status !== "pending"
          )
            return

          const seq = state.reconcileSeq + 1

          yield* requests.update({ status: "completed" }).where({ requestId: result.requestId })
          yield* turn.rows(billingState).update({ reconcileSeq: seq }).where({})
          yield* turn.enqueue(ReconcileSubscription.make({ customerId: result.customerId, seq }))
        }),
        PlanChangeFailed: ({ job, cause, ambiguous }) =>
          Effect.gen(function* () {
            yield* settleRequest(job.requestId, { status: "failed", failure: cause, ambiguous })
            yield* refresh
          }),
        Refresh: () => refresh,
        SubscriptionReconciled: Effect.fnUntraced(function* (result) {
          const turn = yield* BillingActor.Turn
          const rows = turn.rows(billingState)
          const existing = yield* rows.one()

          if (Option.isNone(existing) || existing.value.customerId !== result.customerId)
            return "ignored" as const

          const state = existing.value

          if (result.seq <= state.appliedSeq || result.seq < state.reconcileSeq)
            return "stale" as const

          const { subscription } = result

          if (
            subscription !== null &&
            state.subscriptionId !== null &&
            subscription.subscriptionId !== state.subscriptionId
          )
            return "ignored" as const

          const tier =
            subscription === null
              ? undefined
              : yield* pricing.tier(subscription.tierId).pipe(
                  Effect.map((found) => found.id),
                  Effect.orElseSucceed(() => undefined),
                )

          if (
            tier === undefined &&
            subscription !== null &&
            changesEntitlements(subscription.status)
          )
            return "ignored" as const

          yield* rows
            .update({
              ...settle(state, subscription, tier, revokeOnPastDue),
              providerUpdatedAt: result.observedAt,
              appliedSeq: result.seq,
            })
            .where({})

          if (subscription !== null) {
            const requests = turn.rows(billingRequest)
            const checkouts = yield* requests.all({ where: { kind: "checkout" } })

            for (const checkout of checkouts)
              if (
                checkout.status === "pending" ||
                checkout.status === "ready" ||
                (checkout.status === "failed" && checkout.ambiguous)
              )
                yield* requests
                  .update({ status: "completed", ambiguous: false })
                  .where({ requestId: checkout.requestId })
          }

          return "applied" as const
        }),
      }
    }),
  )

/** Query handlers of `BillingActor`, reading committed rows. */
export const BillingActorReads = BillingActor.toQueryLayer({
  GetAccount: Effect.fnUntraced(function* () {
    const read = yield* BillingActor.Read
    const state = yield* read.rows(billingState).one()

    return Option.match(state, { onNone: () => undefined, onSome: account })
  }),
  GetRequest: Effect.fnUntraced(function* ({ requestId }) {
    const read = yield* BillingActor.Read
    const found = yield* read.rows(billingRequest).one({ where: { requestId } })

    return Option.match(found, { onNone: () => undefined, onSome: requestView })
  }),
})

/**
 * The provider calls of `BillingActor`, run after the turn that enqueued them
 * commits and retried by the framework. A typed failure that retrying cannot
 * fix (an unknown tier or customer, a rejected request) is returned as a
 * `Rejected` result so the request fails at once; a retryable failure fails the
 * attempt. Provider idempotency keys derive from the request id, so a repeated
 * or crashed attempt returns the same hosted page.
 */
export const BillingActorJobs = BillingActor.toJobLayer(
  Effect.gen(function* () {
    const billing = yield* StripeBilling

    const rejected = (requestId: string, reason: string, ambiguous = false) =>
      Effect.succeed({ _tag: "Rejected" as const, requestId, reason, ambiguous })

    const session = (
      requestId: string,
      call: Effect.Effect<
        HostedSession,
        BillingProviderError | UnknownTier | UnknownCustomer | CatalogNotReady | CheckoutExpired
      >,
    ) =>
      call.pipe(
        Effect.map(({ id, url }) => ({ _tag: "Ready" as const, requestId, url, sessionId: id })),
        Effect.catchTags({
          UnknownTier: () => rejected(requestId, "unknown_tier"),
          UnknownCustomer: () => rejected(requestId, "unknown_customer"),
          CatalogNotReady: () => rejected(requestId, "catalog_not_ready"),
          CheckoutExpired: () => rejected(requestId, "checkout_expired"),
          BillingProviderError: (error) =>
            error.retryable ? Effect.fail(error) : rejected(requestId, "provider_rejected", true),
        }),
      )

    return {
      EnsureCustomer: ({ organizationId, email, name }) =>
        billing.ensureCustomer({ organizationId, email, name: name ?? undefined }),
      CreateCheckout: ({ requestId, organizationId, customerId, tierId, successUrl, cancelUrl }) =>
        session(
          requestId,
          billing.startCheckout({
            organizationId,
            customerId,
            tierId,
            successUrl,
            cancelUrl,
            idempotencyKey: `${organizationId}:${requestId}`,
          }),
        ),
      CreatePortal: ({ requestId, organizationId, customerId, returnUrl }) =>
        session(
          requestId,
          billing.openPortal({
            customerId,
            returnUrl,
            idempotencyKey: `${organizationId}:${requestId}`,
          }),
        ),
      UpdateSubscription: ({
        requestId,
        organizationId,
        customerId,
        subscriptionId,
        tierId,
      }): Effect.Effect<typeof UpdateSubscription.success.Type, BillingProviderError> =>
        billing
          .changeSubscription({
            customerId,
            subscriptionId,
            tierId,
            idempotencyKey: `${organizationId}:${requestId}`,
          })
          .pipe(
            Effect.map(() => ({ _tag: "Changed" as const, requestId, customerId })),
            Effect.catchTags({
              UnknownSubscription: () => rejected(requestId, "unknown_subscription"),
              UnknownTier: () => rejected(requestId, "unknown_tier"),
              CatalogNotReady: () => rejected(requestId, "catalog_not_ready"),
              BillingProviderError: (error) =>
                error.retryable
                  ? Effect.fail(error)
                  : rejected(requestId, "provider_rejected", true),
            }),
          ),
      ReconcileSubscription: ({ customerId, seq }) =>
        Effect.gen(function* () {
          const details = yield* billing.billingDetails(customerId)
          const observedAt = DateTime.toEpochMillis(yield* DateTime.now)
          const { subscription } = details

          if (
            details.customerId !== customerId ||
            (subscription !== null && subscription.customerId !== customerId)
          )
            return yield* Effect.die("Provider subscription customer mismatch")

          return {
            customerId,
            seq,
            observedAt,
            subscription:
              subscription === null
                ? null
                : {
                    subscriptionId: subscription.subscriptionId,
                    tierId: subscription.tierId,
                    status: subscription.status,
                  },
          }
        }),
    }
  }),
)

/**
 * The `BillingActor` with its commands, queries and job executors, over the
 * billing schema. Requires `Pricing`, `StripeBilling` and an actor runtime;
 * provides `BillingRepository`.
 */
export const BillingActorLive = (options: BillingActorOptions = {}) =>
  Layer.mergeAll(BillingActorCommands(options), BillingActorReads, BillingActorJobs).pipe(
    Layer.provideMerge(BillingRepositoryLive),
  )

/**
 * The billing actors on a runtime of their own over the control-plane
 * database at `options.databaseUrl`. Requires `Pricing`, `StripeBilling` and `Crypto`.
 */
export const BillingRuntime = (options: {
  readonly databaseUrl: Redacted.Redacted<string>
  readonly actors?: BillingActorOptions
  readonly runtime?: Options
}) =>
  BillingActorLive(options.actors).pipe(
    Layer.provideMerge(Actors.layer(options.runtime)),
    Layer.provideMerge(Database.postgres({ url: options.databaseUrl })),
  )

/**
 * Hands a verified provider event to the organization its customer is durably
 * bound to. An event naming no customer is ignored; one naming a customer with
 * no binding fails `UnboundCustomer`, which the caller should answer with a
 * retryable status, since the binding may still be committing. Provider
 * metadata never selects the organization.
 */
export const deliverWebhook = Effect.fnUntraced(function* (event: BillingEvent) {
  const found = customerIdOf(event)

  if (Option.isNone(found)) return "ignored" as const

  const customerId = found.value

  const repository = yield* BillingRepository
  const organizationId = yield* repository.organizationForCustomer(customerId)

  if (Option.isNone(organizationId)) return yield* UnboundCustomer.make({ customerId })

  const actor = yield* BillingActor.get(organizationId.value)

  const session = Schema.decodeUnknownOption(
    Schema.Struct({ object: Schema.Literal("checkout.session"), id: Schema.String }),
  )(event.data)

  const payload = {
    eventId: event.id,
    eventType: event.type,
    customerId,
    occurredAt: DateTime.toEpochMillis(event.createdAt),
  }

  return yield* actor.RecordWebhook(
    Option.isSome(session) ? { ...payload, sessionId: session.value.id } : payload,
  )
})
