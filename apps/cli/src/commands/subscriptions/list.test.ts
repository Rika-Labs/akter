import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Exit, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { formatLagging, list, parseList } from "./list.ts"

const live = ActorTest.layer({}).pipe(Layer.provideMerge(BunCrypto.layer))

const operators = OperatorAuth.tokens([
  {
    token: Redacted.make("look-token"),
    grant: { operator: "support", capabilities: [{ action: "inspect", tenant: "*" }] },
  },
  {
    token: Redacted.make("actor-token"),
    grant: {
      operator: "narrow",
      capabilities: [{ action: "inspect", tenant: "*", actorType: "Order" }],
    },
  },
  {
    token: Redacted.make("skip-token"),
    grant: { operator: "skipper", capabilities: [{ action: "subscriptions.skip", tenant: "*" }] },
  },
])

describe("durable subscriptions list --lagging", () => {
  it("parses the tenant, thresholds, and the required --lagging switch", () =>
    Effect.gen(function* () {
      expect(
        yield* parseList([
          "--lagging",
          "--url",
          "http://a/",
          "--tenant",
          "t",
          "--min-attempts",
          "3",
          "--limit",
          "5",
        ]),
      ).toMatchObject({ urls: ["http://a"], tenant: "t", minAttempts: "3", limit: "5" })

      for (const args of [
        ["--url", "u", "--tenant", "t"],
        ["--lagging", "--url", "u"],
        ["--lagging", "--url", "u", "--tenant", "t", "--min-attempts", "0"],
        ["--lagging", "--url", "u", "--tenant", "t", "--limit", "1001"],
        ["--lagging", "--url", "u", "--tenant", "t", "extra"],
      ])
        expect(Exit.isFailure(yield* parseList(args).pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.runPromise))

  it("prints each failing row with its lag, and reads only under a tenant-wide inspect grant", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live)
      const tenant = Context.get(context, ActorTest).tenant

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const fetcher = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(FetchHttpClient.layer.pipe(Layer.provide(fetcher)))

      const options = yield* parseList(["--lagging", "--url", "http://runner", "--tenant", tenant])

      const read = (token: string) => list({ options, token }).pipe(Effect.provideContext(services))

      const answer = yield* read("look-token")

      expect(answer).toEqual([])
      expect(yield* formatLagging(answer)).toBe("no lagging subscriptions")

      expect(
        yield* formatLagging([
          {
            sourceType: "Order",
            sourceId: "o1",
            subscriberType: "Follower",
            subscription: "FollowedOrders",
            subscriberId: "f1",
            delivered: "1",
            head: "3",
            lag: "2",
            attempts: 9,
            lastError: "Error: bad payload\n    at somewhere",
          },
        ]),
      ).toBe(
        "Order/o1 -> Follower.FollowedOrders/f1  delivered 1 of 3  lag 2  attempts 9\n  Error: bad payload",
      )

      expect(Exit.isFailure(yield* read("actor-token").pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* read("skip-token").pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* read("nobody").pipe(Effect.exit))).toBe(true)
    }).pipe(Effect.scoped, Effect.runPromise))
})
