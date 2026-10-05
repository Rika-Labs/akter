import {
  defaultPricingConfig,
  organizationCaps,
  type UnknownPlan,
  Pricing,
  storageLimitBytes,
  PricingLive,
  StripeBilling,
  StripeBillingDistilled,
  StripeBillingLocal,
  stripeTiers,
} from "@akter/billing"
import * as Cloud from "@akter/cloud-api"
import * as Stripe from "@distilled.cloud/stripe"
import { BunCrypto } from "@effect/platform-bun"
import {
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { Access } from "./access.ts"
import { BillingActor, BillingActorLive, deliverWebhook, RequestId } from "./billing-actor.ts"
import { BillingRepository } from "./billing-repository.ts"
import { type ApiOptions, localBillingWebhookSecret } from "./config.ts"
import { currentPeriod, latestStorageSample, usageReport } from "./usage.ts"
import { UsageActorLive } from "./metering-actor.ts"
import { CollectorLive, startCollectors } from "./collector.ts"

export const BillingReturnUrl = Context.Reference<string>("@akter/api/BillingReturnUrl", {
  defaultValue: () => "http://localhost:3001/settings/billing",
})

/** Whether checkout and plan changes refuse a paid plan whose price is still provisional. */
export const ProvisionalPlansRefused = Context.Reference<boolean>(
  "@akter/api/ProvisionalPlansRefused",
  { defaultValue: () => false },
)

export const billingInfrastructure = (options: ApiOptions) => {
  const pricing = options.pricing ?? defaultPricingConfig
  const config = {
    tiers: stripeTiers(pricing),
    webhookSecret: options.billingWebhookSecret ?? Redacted.make(localBillingWebhookSecret),
  }
  const provider =
    options.billingMode === "stripe"
      ? StripeBillingDistilled(config).pipe(
          Layer.provide(Stripe.credentials({ apiKey: Redacted.value(options.stripeApiKey!) })),
          Layer.provide(FetchHttpClient.layer),
        )
      : StripeBillingLocal({ ...config, hostedBaseUrl: options.origin })
  const catalog =
    options.billingMode === "stripe"
      ? Layer.empty
      : Layer.effectDiscard(StripeBilling.use((billing) => billing.ensureCatalog)).pipe(
          Layer.provide(provider),
        )
  const cells = options.meterCells ?? []
  const runtime = Layer.mergeAll(BillingActorLive(), UsageActorLive(), CollectorLive(cells)).pipe(
    Layer.provideMerge(Layer.mergeAll(provider, catalog, PricingLive(pricing))),
    Layer.provideMerge(BunCrypto.layer),
    Layer.merge(
      Layer.succeed(
        BillingReturnUrl,
        `${options.consoleOrigin ?? options.origin}/settings/billing`,
      ),
    ),
    Layer.merge(Layer.succeed(ProvisionalPlansRefused, options.provisionalPlansRefused === true)),
  )
  return Layer.mergeAll(runtime, startCollectors(cells).pipe(Layer.provide(runtime)))
}

const refused = () =>
  Cloud.Conflict.make({
    message: "Billing is temporarily unavailable; retry with the same request identity",
  })

const initialized = Effect.fn("Billing.initialize")(function* (organizationId: string) {
  const sql = yield* SqlClient.SqlClient
  const actor = yield* BillingActor.get(organizationId)
  const existing = yield* actor.GetAccount().pipe(Effect.mapError(refused))
  if (existing !== undefined && existing.customerId !== null) return { actor, account: existing }
  const [owner] = yield* sql<{ readonly email: string; readonly name: string }>`
    SELECT u.email, o.name FROM member m JOIN "user" u ON u.id = m."userId"
    JOIN organization o ON o.id = m."organizationId"
    WHERE m."organizationId" = ${organizationId} AND m.role = 'owner'
    ORDER BY m.id LIMIT 1
  `.pipe(Effect.orDie)
  if (owner === undefined) return yield* refused()
  return {
    actor,
    account: yield* actor.InitializeAccount(owner).pipe(Effect.mapError(refused)),
  }
})

const bound = Effect.fn("Billing.bound")(function* (organizationId: string) {
  const { actor } = yield* initialized(organizationId)
  const deadline = (yield* Clock.currentTimeMillis) + 15_000
  for (;;) {
    const account = yield* actor.GetAccount().pipe(Effect.mapError(refused))
    if (account?.customerId !== null && account?.customerId !== undefined) return actor
    if ((yield* Clock.currentTimeMillis) >= deadline) return yield* refused()
    yield* Effect.sleep("25 millis")
  }
})

const requestIdentity = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const identity = request.headers["idempotency-key"]
  if (identity !== undefined)
    return yield* Schema.decodeEffect(RequestId)(identity).pipe(Effect.mapError(refused))
  return yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)
})

const session = Effect.fn("Billing.session")(function* (organizationId: string, requestId: string) {
  const actor = yield* BillingActor.get(organizationId)
  const deadline = (yield* Clock.currentTimeMillis) + 15_000
  for (;;) {
    const request = yield* actor.GetRequest({ requestId }).pipe(Effect.mapError(refused))
    if ((request?.status === "ready" || request?.status === "completed") && request.url !== null)
      return { url: request.url }
    if (
      request?.status === "failed" ||
      request?.status === "expired" ||
      (yield* Clock.currentTimeMillis) >= deadline
    )
      return yield* refused()
    yield* Effect.sleep("25 millis")
  }
})

/**
 * A plan the pricing configuration does not know is an operator fault the
 * edge refuses too, so billing and usage answer a typed `Unavailable` with
 * reason `unknownPlan` rather than a server error, and a client tells it
 * from an outage.
 */
const unknownPlan = ({ tierId }: UnknownPlan) =>
  Cloud.Unavailable.make({
    message: `The organization's plan ${tierId} is not in the pricing configuration`,
    retryAfterSeconds: 60,
    reason: "unknownPlan",
  })

export const BillingLive = HttpApiBuilder.group(Cloud.CloudApi, "billing", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    const repository = yield* BillingRepository
    const provider = yield* StripeBilling
    const pricing = yield* Pricing
    const provisionalRefused = yield* ProvisionalPlansRefused
    const returnUrl = yield* BillingReturnUrl
    return handlers
      .handle("listPlans", () =>
        Effect.succeed({
          plans: pricing.config.tiers
            .toSorted((left, right) => left.basePriceCents - right.basePriceCents)
            .map((tier) => ({
              id: tier.id,
              name: tier.name,
              basePriceCents: tier.basePriceCents,
              currency: "usd" as const,
              allowances: {
                commands: tier.includedCommands,
                commandCap: tier.commandQuota,
                storageGb: tier.includedStorageGb,
                concurrentConnections: tier.concurrentConnections,
              },
              overage: {
                commandCentsPerMillion: tier.commandOverageCentsPerMillion,
                storageCentsPerGbMonth: tier.storageCentsPerGbMonth,
              },
              features: [
                ...(tier.commandQuota === null ? [] : (["command-cap"] as const)),
                ...(tier.commandOverageCentsPerMillion > 0 ? (["command-overage"] as const) : []),
                ...(tier.storageCentsPerGbMonth > 0 ? (["storage-overage"] as const) : []),
                ...(storageLimitBytes(tier) === null ? [] : (["storage-cap"] as const)),
                ...(tier.basePriceCents > 0 ? (["checkout"] as const) : []),
              ],
              provisional: tier.provisional,
            })),
          readCommandWeight: pricing.config.readCommandWeight,
          provisional: pricing.config.tiers.some((tier) => tier.provisional),
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId)
          const stored = Option.getOrUndefined(yield* repository.account(params.organizationId))
          const caps = yield* organizationCaps(params.organizationId).pipe(
            Effect.catchTag("SqlError", Effect.die),
          )
          if (stored === undefined)
            return {
              plan: Cloud.UnboundPlan.make({}),
              paymentMethod: null,
              billingEmail: null,
              spendLimit: { limitCents: null, currentSpendCents: 0 },
              caps,
            }
          const tier = yield* pricing.tier(stored.plan)
          const priced = yield* pricing.tier(stored.subscribedPlan)
          const report = yield* usageReport(params.organizationId, priced.id, yield* currentPeriod)
          const estimate =
            priced.basePriceCents +
            report.meters.reduce((total, meter) => total + meter.overageCostCents, 0)
          const customer = stored.customerId
          const paymentMethod =
            customer == null ? null : yield* provider.paymentMethod(customer).pipe(Effect.orDie)
          const details =
            customer == null ? null : yield* provider.billingDetails(customer).pipe(Effect.orDie)
          return yield* Schema.decodeUnknownEffect(Schema.toType(Cloud.BillingSummary))({
            plan: Cloud.Plan.make({
              id: tier.id,
              subscribedId: priced.id,
              paymentStatus: yield* Schema.decodeUnknownEffect(
                Cloud.Plan.fields.paymentStatus.schema,
              )(stored.paymentStatus).pipe(Effect.orDie),
              name: tier.name,
              basePriceCents: priced.basePriceCents,
              currency: "usd",
              renewsAt:
                details?.subscription?.cancelAtPeriodEnd === true
                  ? null
                  : (details?.subscription?.currentPeriodEnd ?? null),
              monthToDateEstimateCents: estimate,
              provisional: priced.provisional,
            }),
            paymentMethod,
            billingEmail: stored.billingEmail,
            spendLimit: {
              limitCents: stored.spendLimitCents,
              currentSpendCents: estimate,
            },
            caps,
          }).pipe(Effect.orDie)
        }).pipe(Effect.catchTag("UnknownPlan", unknownPlan)),
      )
      .handle("listInvoices", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId)
          const account = Option.getOrUndefined(yield* repository.account(params.organizationId))
          if (account?.customerId == null) return []
          const invoices = yield* provider.invoices(account.customerId).pipe(Effect.orDie)
          return yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Array(Cloud.Invoice)))(
            invoices.map((invoice) => ({ ...invoice, number: invoice.number ?? invoice.id })),
          ).pipe(Effect.orDie)
        }),
      )
      .handle("setSpendLimit", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          const stored = Option.getOrUndefined(yield* repository.account(params.organizationId))
          if (stored !== undefined) yield* pricing.tier(stored.plan)
          const tier = yield* pricing.tier(stored?.subscribedPlan ?? "free")
          const { actor } = yield* initialized(params.organizationId)
          yield* actor.SetSpendLimit({ cents: payload.limitCents }).pipe(Effect.mapError(refused))
          const report = yield* usageReport(params.organizationId, tier.id, yield* currentPeriod)
          return {
            limitCents: payload.limitCents,
            currentSpendCents:
              tier.basePriceCents +
              report.meters.reduce((sum, meter) => sum + meter.overageCostCents, 0),
          }
        }).pipe(Effect.catchTag("UnknownPlan", unknownPlan)),
      )
      .handle("startCheckout", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          if (
            provisionalRefused &&
            (yield* pricing.tier(payload.plan).pipe(Effect.orDie)).provisional
          )
            return yield* Cloud.Conflict.make({
              message: "Paid plans are not published until benchmark-backed pricing is configured",
            })
          const actor = yield* bound(params.organizationId)
          const requestId = yield* requestIdentity
          yield* actor
            .StartCheckout({
              requestId,
              tierId: payload.plan,
              successUrl: returnUrl,
              cancelUrl: returnUrl,
            })
            .pipe(
              Effect.catchTags({
                CheckoutBlocked: (error) =>
                  Effect.fail(
                    Cloud.Conflict.make({
                      message: Match.value(error.reason).pipe(
                        Match.when(
                          "active_subscription",
                          () =>
                            "This organization already has a subscription; use the plan-change endpoint",
                        ),
                        Match.when(
                          "pending_checkout",
                          () =>
                            `A checkout is already open; retry with Idempotency-Key ${error.requestId} or wait for it to expire`,
                        ),
                        Match.when(
                          "ambiguous_checkout",
                          () =>
                            `The earlier checkout outcome is unknown; retry with Idempotency-Key ${error.requestId} to recover it before another checkout`,
                        ),
                        Match.exhaustive,
                      ),
                    }),
                  ),
                RequestConflict: () =>
                  Effect.fail(
                    Cloud.Conflict.make({
                      message:
                        "This request identity was already used with different checkout input",
                    }),
                  ),
              }),
              Effect.mapError((error) => (Schema.is(Cloud.Conflict)(error) ? error : refused())),
            )
          return yield* session(params.organizationId, requestId)
        }),
      )
      .handle("openPortal", ({ params }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          const actor = yield* bound(params.organizationId)
          const requestId = yield* requestIdentity
          yield* actor.OpenPortal({ requestId, returnUrl }).pipe(Effect.mapError(refused))
          return yield* session(params.organizationId, requestId)
        }),
      )
      .handle("changePlan", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* access.organization(params.organizationId, "admin")
          if (
            provisionalRefused &&
            (yield* pricing.tier(payload.plan).pipe(Effect.orDie)).provisional
          )
            return yield* Cloud.Conflict.make({
              message: "Paid plans are not published until benchmark-backed pricing is configured",
            })
          const actor = yield* bound(params.organizationId)
          const requestId = yield* requestIdentity
          const changed = yield* actor.ChangePlan({ requestId, tierId: payload.plan }).pipe(
            Effect.catchTags({
              NoActiveSubscription: () =>
                Effect.fail(
                  Cloud.Conflict.make({
                    message: "This organization has no active subscription; start checkout first",
                  }),
                ),
              RequestConflict: () =>
                Effect.fail(
                  Cloud.Conflict.make({
                    message: "This request identity was already used for a different plan change",
                  }),
                ),
            }),
            Effect.mapError((error) => (Schema.is(Cloud.Conflict)(error) ? error : refused())),
          )
          const account = yield* actor.GetAccount().pipe(Effect.mapError(refused))
          const status =
            changed.status === "failed" || changed.status === "expired"
              ? ("failed" as const)
              : account?.plan === payload.plan
                ? ("completed" as const)
                : ("pending" as const)
          return { requestId: changed.requestId, status }
        }),
      )
  }),
)

export const UsageLive = HttpApiBuilder.group(Cloud.CloudApi, "usage", (handlers) =>
  Effect.gen(function* () {
    const access = yield* Access
    const repository = yield* BillingRepository
    return handlers.handle("get", ({ params, query }) =>
      Effect.gen(function* () {
        yield* access.organization(params.organizationId)
        const account = Option.getOrUndefined(yield* repository.account(params.organizationId))
        const report = yield* usageReport(
          params.organizationId,
          account?.subscribedPlan ?? account?.plan ?? "free",
          query.period ?? (yield* currentPeriod),
        )
        return {
          ...report,
          latestStorageSample: yield* latestStorageSample(params.organizationId),
          caps: yield* organizationCaps(params.organizationId).pipe(
            Effect.catchTag("SqlError", Effect.die),
          ),
        }
      }).pipe(Effect.catchTag("UnknownPlan", unknownPlan)),
    )
  }),
)

export const billingWebhook = HttpRouter.use((router) =>
  router.add(
    "POST",
    "/api/billing/webhook",
    Effect.gen(function* () {
      const provider = yield* StripeBilling
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* request.stream.pipe(
        Stream.runFoldEffect(
          () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
          (collected, chunk) => {
            const size = collected.size + chunk.byteLength
            if (size > 1_048_576) return Effect.fail("too_large" as const)
            collected.chunks.push(chunk)
            return Effect.succeed({ size, chunks: collected.chunks })
          },
        ),
        Effect.result,
      )
      if (Result.isFailure(body))
        return HttpServerResponse.text("Invalid billing webhook body", { status: 413 })
      const bytes = new Uint8Array(body.success.size)
      let offset = 0
      for (const chunk of body.success.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const event = yield* provider
        .verifyWebhook(bytes, request.headers["stripe-signature"] ?? null)
        .pipe(Effect.result)
      if (Result.isFailure(event))
        return HttpServerResponse.text("Invalid billing webhook", { status: 400 })
      const delivered = yield* deliverWebhook(event.success).pipe(Effect.result)
      return Result.isFailure(delivered)
        ? HttpServerResponse.text("Billing synchronization unavailable", { status: 503 })
        : HttpServerResponse.jsonUnsafe({ received: true })
    }),
  ),
)
