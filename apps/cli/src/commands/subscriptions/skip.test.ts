import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

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

describe("akter subscriptions skip", () => {
  it("parses the source, subscriber, subscription, cursor, and reason", () =>
    Effect.gen(function* () {
      const runner = recordingFetch({ skipped: true })

      expect(
        yield* runCliWith({ fetch: runner.fetch })(["subscriptions", "skip", ...base]),
      ).toEqual({
        stdout: '{"skipped":true}\n',
        stderr: "",
        exitCode: 0,
        reason: "",
      })
      expect(runner.requests.map(({ method, url }) => ({ method, url }))).toEqual([
        {
          method: "POST",
          url: "http://a/operator/subscriptions/skip",
        },
      ])
      expect(yield* decodeJson(runner.requests[0]!.body)).toEqual({
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

      for (const [args, reason, message] of [
        [without("--reason"), "MissingOption", "Missing required flag: --reason"],
        [without("--tenant"), "MissingOption", "Missing required flag: --tenant"],
        [
          [...without("--through"), "--through", "0x2"],
          "InvalidValue",
          'Invalid value for flag --through: "0x2". Expected: a positive event cursor',
        ],
      ] as const) {
        const refused = yield* runCli(["subscriptions", "skip", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }
    }).pipe(Effect.runPromise))
})
