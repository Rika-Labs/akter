import { completeLocalCheckout, signWebhook, StripeBilling } from "@akter/billing"
import { Clock, Context, Effect, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"
import { deliverWebhook } from "./billing-actor.ts"
import { type ApiOptions, localBillingWebhookSecret } from "./config.ts"

export const LocalBillingOptions = Context.Reference<ApiOptions | undefined>(
  "@akter/api/LocalBillingOptions",
  { defaultValue: () => undefined },
)

interface LocalSession {
  readonly id: string
  readonly kind: "checkout" | "portal"
  readonly customer_id: string
  readonly tier_id: string | null
  readonly params: { readonly success_url?: string }
}

/** Development-only hosted pages are opaque session capabilities, just like their provider counterparts, and never mount in Stripe or production mode. */
export const localBillingRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const options = yield* LocalBillingOptions
    if (options === undefined || options.production || options.billingMode === "stripe") return
    const sql = yield* SqlClient.SqlClient
    const provider = yield* StripeBilling
    const secret = options.billingWebhookSecret ?? Redacted.make(localBillingWebhookSecret)

    const session = Effect.gen(function* () {
      const { sessionId } = yield* HttpRouter.params
      if (sessionId === undefined || !/^(?:cs|bps)_local_[0-9a-f]{32}$/u.test(sessionId))
        return Option.none<LocalSession>()
      const [stored] = yield* sql<LocalSession>`
      SELECT id, kind, customer_id, tier_id, params FROM cloud_billing_session WHERE id = ${sessionId}
    `.pipe(Effect.orDie)
      return Option.fromUndefinedOr(stored)
    })

    yield* router.add(
      "GET",
      "/billing/checkout/:sessionId",
      Effect.gen(function* () {
        const stored = yield* session
        if (Option.isNone(stored) || stored.value.kind !== "checkout")
          return HttpServerResponse.empty({ status: 404 })
        return HttpServerResponse.jsonUnsafe({
          mode: "local",
          id: stored.value.id,
          plan: stored.value.tier_id,
          automaticTax: true,
          complete: "POST this session URL to complete the local checkout",
        })
      }),
    )

    yield* router.add(
      "POST",
      "/billing/checkout/:sessionId",
      Effect.gen(function* () {
        const stored = yield* session
        if (Option.isNone(stored) || stored.value.kind !== "checkout")
          return HttpServerResponse.empty({ status: 404 })
        const [request] = yield* sql<{
          readonly status: string
        }>`SELECT status FROM cloud_billing_request WHERE kind = 'checkout' AND session_id = ${stored.value.id}`.pipe(
          Effect.orDie,
        )
        if (request?.status === "expired" || request?.status === "failed")
          return HttpServerResponse.empty({ status: 410 })
        if (request?.status === "completed")
          return HttpServerResponse.jsonUnsafe({
            mode: "local",
            completed: true,
            returnUrl: stored.value.params.success_url ?? null,
          })
        const subscription = yield* completeLocalCheckout(stored.value.id).pipe(Effect.orDie)
        const event = {
          id: `evt_local_${stored.value.id}`,
          type: "checkout.session.completed",
          created: Math.floor((yield* Clock.currentTimeMillis) / 1000),
          livemode: false,
          data: {
            object: {
              id: stored.value.id,
              object: "checkout.session",
              customer: subscription.customerId,
              subscription: subscription.subscriptionId,
            },
          },
        }
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(event).pipe(
          Effect.orDie,
        )
        const signature = yield* signWebhook(secret, body, event.created)
        const verified = yield* provider.verifyWebhook(body, signature).pipe(Effect.orDie)
        yield* deliverWebhook(verified).pipe(Effect.orDie)
        return HttpServerResponse.jsonUnsafe({
          mode: "local",
          completed: true,
          subscriptionId: subscription.subscriptionId,
          returnUrl: stored.value.params.success_url ?? null,
        })
      }),
    )

    yield* router.add(
      "GET",
      "/billing/portal/:sessionId",
      Effect.gen(function* () {
        const stored = yield* session
        if (Option.isNone(stored) || stored.value.kind !== "portal")
          return HttpServerResponse.empty({ status: 404 })
        return HttpServerResponse.jsonUnsafe({
          mode: "local",
          id: stored.value.id,
          features: ["payment-method", "billing-details", "invoices", "cancellation"],
          planChanges: "Use POST /api/organizations/:organizationId/billing/plan",
        })
      }),
    )
  }),
)
