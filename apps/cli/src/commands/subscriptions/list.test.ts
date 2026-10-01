import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/http"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"
import { formatLagging } from "./list.ts"

const live = ActorTest.layer().pipe(Layer.provideMerge(BunCrypto.layer))

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
      const runner = recordingFetch([])

      const listed = yield* runCliWith({ fetch: runner.fetch })([
        "subscriptions",
        "list",
        "--lagging",
        "--url",
        "http://a/",
        "--tenant",
        "t",
        "--min-attempts",
        "3",
        "--limit",
        "5",
      ])

      expect(listed).toEqual({
        stdout: "no lagging subscriptions\n",
        stderr: "",
        exitCode: 0,
        reason: "",
      })
      expect(runner.requests.map(({ url }) => url)).toEqual([
        "http://a/operator/subscriptions/lagging?tenant=t&minAttempts=3&limit=5",
      ])

      for (const [args, reason, message] of [
        [["--url", "u", "--tenant", "t"], "MissingOption", "Missing required flag: --lagging"],
        [["--lagging", "--url", "u"], "MissingOption", "Missing required flag: --tenant"],
        [
          ["--lagging", "--url", "u", "--tenant", "t", "--min-attempts", "0"],
          "InvalidValue",
          'Invalid value for flag --min-attempts: "0"',
        ],
        [
          ["--lagging", "--url", "u", "--tenant", "t", "--limit", "1001"],
          "InvalidValue",
          'Invalid value for flag --limit: "1001"',
        ],
        [
          ["--lagging", "--url", "u", "--tenant", "t", "extra"],
          "UnexpectedArgument",
          'Unexpected positional argument: "extra"',
        ],
      ] as const) {
        const refused = yield* runCli(["subscriptions", "list", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }
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

      const fetch = ((input, init) =>
        web.handler(new Request(input, init))) as typeof globalThis.fetch

      const read = (token: string) =>
        runCliWith({
          fetch,
          env: { DURABLE_OPERATOR_TOKEN: token },
        })(["subscriptions", "list", "--lagging", "--url", "http://runner", "--tenant", tenant])

      expect(yield* read("look-token")).toEqual({
        stdout: "no lagging subscriptions\n",
        stderr: "",
        exitCode: 0,
        reason: "",
      })

      const json = yield* runCliWith({ fetch, env: { DURABLE_OPERATOR_TOKEN: "look-token" } })([
        "subscriptions",
        "list",
        "--lagging",
        "--url",
        "http://runner",
        "--tenant",
        tenant,
        "--json",
      ])

      expect(json.stdout).toBe("[]\n")
      expect(yield* formatLagging([])).toBe("no lagging subscriptions")

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

      for (const [token, status] of [
        ["actor-token", 403],
        ["skip-token", 403],
        ["nobody", 401],
      ] as const) {
        const refused = yield* read(token)

        expect(refused).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
        expect(refused.stderr).toMatch(new RegExp(`^Refused \\(${status}\\): `))
      }
    }).pipe(Effect.scoped, Effect.runPromise))
})
