import { expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { verifyWebhook } from "./webhook.ts"

const secret = Buffer.from("test-webhook-key").toString("base64")

const body = JSON.stringify({
  type: "subscription.updated",
  timestamp: "2026-01-01T00:00:00Z",
  data: {},
})

/**
 * Independently generated with Python hmac.sha256 over
 * event-1.<timestamp>.<body>.
 */
const signatures = new Map([
  [699, "3OusZfBFZVKRurmK71+eRwPuDkJfequB1eF8EyOayBI="],
  [700, "7ED4J0zS35zKMLGab096BeqACm5doP4r569GISMzbkA="],
  [1000, "9pFsIcJpZmCiNhWMKffL+XdVpAfcMyd5pe1X2SVME0U="],
  [1300, "tBqw43Rts12uNpYACBrgfhP43GSRgQKevSMpFhUDS9w="],
  [1301, "J1fzqCZrCqxiUF2dUQk5oQiFODirgz5jmIsn6PpVKCA="],
])

function headers(timestamp: number) {
  return new Headers({
    "webhook-id": "event-1",
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signatures.get(timestamp)}`,
  })
}

it.effect(
  "accepts the exact replay-window boundary, rejects stale/future deliveries and tampering",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000)
      expect((yield* verifyWebhook(body, headers(700), secret)).id).toBe("event-1")
      expect((yield* verifyWebhook(body, headers(1300), secret)).id).toBe("event-1")

      for (const timestamp of [699, 1301]) {
        expect((yield* Effect.flip(verifyWebhook(body, headers(timestamp), secret)))._tag).toBe(
          "InvalidWebhook",
        )
      }

      expect((yield* Effect.flip(verifyWebhook(`${body} `, headers(1000), secret)))._tag).toBe(
        "InvalidWebhook",
      )
      expect((yield* Effect.flip(verifyWebhook(body, new Headers(), secret)))._tag).toBe(
        "InvalidWebhook",
      )

      const rotated = headers(1000)
      rotated.set("webhook-signature", `v1,invalid v2,ignored v1,${signatures.get(1000)}`)
      expect((yield* verifyWebhook(body, rotated, `whsec_${secret}`)).id).toBe("event-1")
      expect((yield* Effect.flip(verifyWebhook(body, rotated, "d3Jvbmc=")))._tag).toBe(
        "InvalidWebhook",
      )
    }),
)
