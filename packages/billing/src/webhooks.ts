import * as Stripe from "@distilled.cloud/stripe"
import { DateTime, Effect, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"

import {
  type BillingConfig,
  type BillingEvent,
  WebhookRejected,
  type WebhookPayload,
} from "./contract.ts"

const StripeEventBody = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  created: Schema.Finite,
  livemode: Schema.Boolean,
  data: Schema.Struct({ object: Schema.Record(Schema.String, Schema.Json) }),
})

/**
 * Verifies a Stripe webhook with the library's own signature check, so the
 * hosted and local providers accept and reject exactly the same requests: the
 * signature must match the raw body and fall inside the tolerance window.
 */
export const verifyWebhook = (config: BillingConfig) =>
  Effect.fn("verifyWebhook")(function* (payload: WebhookPayload, signature: string | null) {
    return yield* constructBillingEvent(config, payload, signature)
  })

const constructBillingEvent = (
  config: BillingConfig,
  payload: WebhookPayload,
  signature: string | null,
): Effect.Effect<BillingEvent, WebhookRejected> =>
  Stripe.Webhooks.constructEvent({
    payload,
    signature,
    secret: config.webhookSecret,
    toleranceSeconds: config.webhookToleranceSeconds,
  }).pipe(
    Effect.mapError((error) => WebhookRejected.make({ reason: error.message })),
    Effect.flatMap((event) =>
      Schema.decodeUnknownEffect(StripeEventBody)(event).pipe(
        Effect.mapError(() => WebhookRejected.make({ reason: "Payload is not a Stripe event" })),
      ),
    ),
    Effect.map((event) => ({
      id: event.id,
      type: event.type,
      createdAt: DateTime.makeUnsafe(event.created * 1000),
      livemode: event.livemode,
      data: event.data.object,
    })),
  )

/**
 * Produces the `Stripe-Signature` header Stripe would send for `payload`, for
 * the local development stack and for tests that post webhooks to the API.
 */
export const signWebhook = Effect.fn("signWebhook")(function* (
  secret: Redacted.Redacted<string>,
  payload: string,
  timestampSeconds: number,
) {
  const encoder = new TextEncoder()
  const key = yield* Effect.promise(() =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(Redacted.value(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  )
  const mac = yield* Effect.promise(() =>
    crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${payload}`)),
  )
  return `t=${timestampSeconds},v1=${Hex.encode(new Uint8Array(mac))}`
})
