import { DateTime, Effect, Schema } from "effect"
import { InvalidWebhook, Subscription, verifyWebhook } from "@durable-actors/billing/webhook"
import type { Config } from "../config.ts"
import { applySubscription } from "./repository.ts"

/**
 * Verifies a Polar webhook and applies a `subscription.*` event for the
 * configured product: `active` and `trialing` are the pro plan, any other
 * status free.
 */
export const processWebhook = Effect.fn("Billing.processWebhook")(function* (
  body: string,
  headers: Headers,
  polar: NonNullable<Config["polar"]>,
) {
  const event = yield* verifyWebhook(body, headers, polar.webhookSecret)

  if (!event.type.startsWith("subscription.")) return

  const subscription = yield* Schema.decodeUnknownEffect(Subscription)(event.data).pipe(
    Effect.mapError(() => InvalidWebhook.make({ message: "Invalid subscription" })),
  )

  if (subscription.product_id !== polar.productId || subscription.customer.external_id === null)
    return

  yield* applySubscription({
    id: event.id,
    organizationId: subscription.customer.external_id,
    subscriptionId: subscription.id,
    customerId: subscription.customer_id,
    plan: ["active", "trialing"].includes(subscription.status) ? "pro" : "free",
    status: subscription.status,
    renewalDate:
      subscription.current_period_end !== null
        ? DateTime.toDate(subscription.current_period_end)
        : null,
    eventAt: DateTime.toDate(event.timestamp),
  })
})
