import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import { parseSkip } from "./skip.ts"

const base = [
  "--url",
  "http://a/",
  "--tenant",
  "t",
  "--source",
  "Order/o1",
  "--subscriber",
  "Follower/f1",
  "--subscription",
  "FollowedOrders",
  "--through",
  "42",
  "--reason",
  "bad payload",
]

describe("durable subscriptions skip", () => {
  it("parses the source, subscriber, subscription, cursor, and reason", () =>
    Effect.gen(function* () {
      expect(yield* parseSkip(base)).toMatchObject({
        urls: ["http://a"],
        tenant: "t",
        sourceType: "Order",
        sourceId: "o1",
        subscriberType: "Follower",
        subscriberId: "f1",
        subscription: "FollowedOrders",
        through: "42",
        reason: "bad payload",
      })
    }).pipe(Effect.runPromise))

  it("refuses a missing reason, a non-numeric cursor, and a missing tenant", () =>
    Effect.gen(function* () {
      const without = (flag: string) => {
        const at = base.indexOf(flag)

        return base.filter((_, index) => index !== at && index !== at + 1)
      }

      for (const args of [
        without("--reason"),
        without("--tenant"),
        [...without("--through"), "--through", "0x2"],
      ])
        expect(Exit.isFailure(yield* parseSkip(args).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.runPromise))
})
