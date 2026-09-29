import { DateTime, Effect, Schema } from "effect"

/** The webhook's headers, signature or body failed verification. */
export class InvalidWebhook extends Schema.TaggedError<InvalidWebhook>()("InvalidWebhook", {
  message: Schema.String,
}) {}

const Envelope = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.DateTimeUtcFromString,
  data: Schema.Unknown,
})

/** Polar subscription payload fields the app reads. */
export const Subscription = Schema.Struct({
  id: Schema.String,
  customer_id: Schema.String,
  product_id: Schema.String,
  customer: Schema.Struct({ external_id: Schema.NullOr(Schema.String) }),
  status: Schema.String,
  current_period_end: Schema.NullOr(Schema.DateTimeUtcFromString),
})

const WebhookHeaders = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  timestamp: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  signature: Schema.String.check(Schema.isMinLength(1)),
})

/**
 * Verifies a Standard Webhooks delivery: headers present, timestamp within
 * five minutes of now, and an HMAC-SHA256 `v1` signature over
 * `id.timestamp.body` matching the secret. Returns the delivery id with the
 * decoded envelope; fails with `InvalidWebhook`.
 */
export const verifyWebhook = Effect.fn("Billing.verifyWebhook")(function* (
  body: string,
  headers: Headers,
  secret: string,
) {
  const { id, timestamp, signature } = yield* Schema.decodeUnknownEffect(WebhookHeaders)({
    id: headers.get("webhook-id"),
    timestamp: headers.get("webhook-timestamp"),
    signature: headers.get("webhook-signature"),
  }).pipe(Effect.mapError(() => InvalidWebhook.make({ message: "Invalid webhook headers" })))

  const now = DateTime.toEpochMillis(yield* DateTime.now)

  if (Math.abs(now / 1000 - timestamp) > 300) {
    return yield* InvalidWebhook.make({ message: "Invalid webhook headers" })
  }

  const keyBytes = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64")

  const key = yield* Effect.tryPromise(() =>
    globalThis.crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "verify",
    ]),
  ).pipe(Effect.mapError(() => InvalidWebhook.make({ message: "Invalid webhook signature" })))

  const signed = new TextEncoder().encode(`${id}.${headers.get("webhook-timestamp")}.${body}`)

  const candidates = signature.split(" ").flatMap((part) => {
    const [version, encoded] = part.split(",")

    return version === "v1" && encoded !== undefined && encoded.length > 0 ? [encoded] : []
  })

  const results = yield* Effect.forEach(candidates, (encoded) =>
    Effect.tryPromise(() =>
      globalThis.crypto.subtle.verify("HMAC", key, Buffer.from(encoded, "base64"), signed),
    ).pipe(Effect.orElseSucceed(() => false)),
  )

  const valid = results.some(Boolean)

  if (!valid) return yield* InvalidWebhook.make({ message: "Invalid webhook signature" })

  const event = yield* Schema.decodeEffect(Schema.fromJsonString(Envelope))(body).pipe(
    Effect.mapError(() => InvalidWebhook.make({ message: "Invalid webhook body" })),
  )

  return { id, ...event }
})
