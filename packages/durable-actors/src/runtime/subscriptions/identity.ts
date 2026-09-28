import { Effect, Schema } from "effect"
import type { Request, SubscriptionEnvelope } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"

const encodeIdentity = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * The identity of one subscription delivery: which subscription, subscriber,
 * source, epoch, and position it applies. Two subscriptions, two subscribers
 * of one source, or two epochs of one subscription never share one.
 */
export const deliveryIdentity = ({
  subscriber,
  envelope,
}: {
  readonly subscriber: ActorRef
  readonly envelope: SubscriptionEnvelope
}) =>
  encodeIdentity([
    "subscription/v1",
    subscriber.tenant,
    subscriber.actor,
    envelope.subscription,
    subscriber.id,
    envelope.sourceType,
    envelope.sourceId,
    envelope.epoch,
    envelope.kind,
    envelope.position,
  ]).pipe(Effect.orDie)

/**
 * What a receipt's payload hash binds: a delivery's identity rather than its
 * re-encoded bytes, so a redelivery after a schema-compatible deploy replays
 * instead of conflicting; any other request's payload.
 */
export const hashedPayload = (request: Request) =>
  request.delivery === undefined
    ? Effect.succeed(request.payload)
    : deliveryIdentity({ subscriber: request.ref, envelope: request.delivery })

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * A delivery's command id: `v1.<s>.<s + retryWindow>.<digest>`, where `s` is
 * fixed by the delivered record (an event's emit time, a gap's detection
 * time, a control row's schedule), so a redelivery repeats the id. The digest
 * is SHA-256 of the identity shaped as a version-8 UUID, which external
 * admission never accepts, so no caller can plant a receipt under it.
 */
export const deliveryCommandId = Effect.fnUntraced(function* ({
  subscriber,
  envelope,
  issuedAt,
  retryWindowMs,
}: {
  readonly subscriber: ActorRef
  readonly envelope: SubscriptionEnvelope
  readonly issuedAt: number
  readonly retryWindowMs: number
}) {
  const identity = yield* deliveryIdentity({ subscriber, envelope })

  const digest = yield* Effect.promise(() =>
    globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)),
  )

  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x80
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const raw = hex(bytes)

  const uuid = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`

  const issued = Math.max(1, Math.floor(issuedAt))

  return `v1.${issued}.${issued + retryWindowMs}.${uuid}`
})
