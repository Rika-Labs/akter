import { Array, Clock, Crypto, DateTime, Effect } from "effect"
import { Hex } from "effect/encoding"

import {
  BillingProviderError,
  type BillingConfig,
  type UsageEvent,
  UnknownMeter,
} from "./contract.ts"

/** Stripe accepts at most this many meter events in one stream request. */
export const MAX_BATCH = 100

const encoder = new TextEncoder()

const MAX_EVENT_AGE_MILLIS = 35 * 24 * 3600 * 1000 - 3600 * 1000

const MAX_EVENT_FUTURE_MILLIS = 4 * 60 * 1000

/**
 * A usage value as the plain decimal text Stripe's meter payload takes.
 * Stripe accepts at most 15 significant digits. Fractional values are
 * deterministically quantized to that precision for provider interoperability,
 * without rounding reads to whole commands or changing the stored logical
 * counters. Integer counts remain exact; validation rejects those Stripe
 * cannot represent. Exponent notation is expanded without zeroing tiny values.
 */
export const usageValueText = (value: number): string => {
  const text = Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)))
  if (!text.includes("e")) return text
  const [coefficient, exponent] = text.split("e")
  const parts = coefficient!.split(".")
  const digits = parts.join("")
  const point = parts[0]!.length + Number(exponent)
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) return `${digits}${"0".repeat(point - digits.length)}`
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

export const sha256Hex = (text: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Crypto.Crypto.use((crypto) => crypto.digest("SHA-256", encoder.encode(text))).pipe(
    Effect.map(Hex.encode),
    Effect.orDie,
  )

/** The event identifier Stripe deduplicates on; the same meter, customer and key always give the same one. */
export const usageIdentifier = (event: UsageEvent): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.map(
    sha256Hex(
      `${event.meter.length}:${event.meter}${event.customerId.length}:${event.customerId}${event.key}`,
    ),
    (hash) => `akter_${hash}`,
  )

export interface IdentifiedUsage {
  readonly identifier: string
  readonly event: UsageEvent
}

/**
 * Validates and identifies a report, then drops repeats of the same
 * identifier and splits the rest into batches of at most `MAX_BATCH`, keeping
 * the caller's order. Stripe only accepts events from the last 35 days to five
 * minutes ahead and validates asynchronously, so an event outside that window
 * (with a margin for clock skew) is refused here instead of being silently
 * dropped later.
 */
export const planUsage = (config: BillingConfig) => {
  const known = new Set(config.tiers.flatMap((tier) => tier.usage.map((usage) => usage.meter)))
  return Effect.fn("planUsage")(function* (events: ReadonlyArray<UsageEvent>) {
    const now = yield* Clock.currentTimeMillis
    const seen = new Set<string>()
    const identified: Array<IdentifiedUsage> = []
    for (const event of events) {
      if (!known.has(event.meter)) return yield* UnknownMeter.make({ meter: event.meter })
      if (!Number.isFinite(event.value) || event.value < 0) {
        return yield* BillingProviderError.make({
          operation: "recordUsage",
          message: `Usage value for ${event.meter} must be a non-negative number`,
          retryable: false,
        })
      }
      if (
        Number.isInteger(event.value) &&
        (!Number.isSafeInteger(event.value) || String(event.value).replace(/0+$/, "").length > 15)
      ) {
        return yield* BillingProviderError.make({
          operation: "recordUsage",
          message: `Integer usage for ${event.meter} exceeds exact Stripe precision`,
          retryable: false,
        })
      }
      const at = DateTime.toEpochMillis(event.occurredAt)
      if (at < now - MAX_EVENT_AGE_MILLIS || at > now + MAX_EVENT_FUTURE_MILLIS) {
        return yield* BillingProviderError.make({
          operation: "recordUsage",
          message: `Usage for ${event.meter} is outside the window Stripe accepts (35 days back, 5 minutes ahead)`,
          retryable: false,
        })
      }
      const identifier = yield* usageIdentifier(event)
      if (seen.has(identifier)) continue
      seen.add(identifier)
      identified.push({ identifier, event })
    }
    return Array.chunksOf(identified, MAX_BATCH)
  })
}
