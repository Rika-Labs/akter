import { Actor, User } from "@durable-actors/core"
import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { describe, expect, it } from "vitest"

import { UsageError } from "../workflows/check.ts"
import { parseRepair, repair } from "./repair.ts"

class Notify extends Actor.effect<Notify>()("CliNotify", { input: { to: Schema.String } }) {}

const Ping = Actor.command("Ping", { input: Schema.String })

const Pager = Actor.make("CliPager", {
  key: Schema.String,
  effects: [Notify],
  api: { Ping },
  policy: { effects: { CliNotify: { retry: { times: 0 } } } },
})

class PagerDown extends Schema.TaggedError<PagerDown>()("PagerDown", {}) {}

const provider = { up: false, calls: 0 }

const live = Layer.mergeAll(
  Pager.toLayer(
    Effect.succeed({
      Ping: Effect.fnUntraced(function* (to: string) {
        yield* (yield* Pager.Turn).perform(Notify.make({ to }))
      }),
    }),
  ),
  Pager.toEffectLayer(
    Effect.succeed({
      CliNotify: () =>
        Effect.suspend(() => {
          provider.calls += 1

          return provider.up ? Effect.void : Effect.fail(PagerDown.make({}))
        }),
    }),
  ),
).pipe(
  Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
  Layer.provideMerge(BunCrypto.layer),
)

const operators = OperatorAuth.tokens([
  {
    token: Redacted.make("repair-token"),
    grant: {
      operator: "oncall",
      capabilities: [
        { action: "dead-letters.retry", tenant: "*" },
        { action: "dead-letters.discard", tenant: "*" },
      ],
    },
  },
])

describe("durable dead-letters", () => {
  it("parses retry and discard, and refuses a missing reason or actor", () =>
    Effect.gen(function* () {
      const retry = yield* parseRepair({
        action: "retry",
        args: [
          "e1",
          "--actor",
          "CliPager/p1",
          "--url",
          "http://runner/",
          "--tenant",
          "t",
          "--reason",
          "pager is back",
          "--provider-checked",
        ],
      })

      expect(retry).toMatchObject({
        urls: ["http://runner"],
        tenant: "t",
        actorType: "CliPager",
        actorId: "p1",
        effectId: "e1",
        reason: "pager is back",
        providerChecked: true,
        tokenEnv: "DURABLE_OPERATOR_TOKEN",
      })

      for (const [args, message] of [
        [
          ["e1", "--actor", "CliPager/p1", "--url", "u", "--tenant", "t"],
          "--reason is required, up to 500 characters",
        ],
        [["e1", "--url", "u", "--tenant", "t", "--reason", "r"], "Name the actor as <Type>/<id>"],
        [
          ["e1", "--actor", "CliPager", "--url", "u", "--tenant", "t", "--reason", "r"],
          "Name the actor as <Type>/<id>",
        ],
      ] as const) {
        const failure = yield* parseRepair({ action: "retry", args }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(UsageError)
        expect(failure.message).toBe(message)
      }

      const discard = yield* parseRepair({
        action: "discard",
        args: [
          "e1",
          "--actor",
          "a/b",
          "--url",
          "u",
          "--tenant",
          "t",
          "--reason",
          "r",
          "--provider-checked",
        ],
      }).pipe(Effect.flip)

      expect(discard).toBeInstanceOf(UsageError)
      expect(discard.message).toBe("Unknown argument: --provider-checked")
    }).pipe(Effect.runPromise))

  it("retries a dead letter through the operator routes and refuses a second repair", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live)
      const sql = Context.get(context, SqlClient.SqlClient)
      const tenant = Context.get(context, ActorTest).tenant

      yield* Effect.gen(function* () {
        yield* (yield* Pager.get("p1")).Ping("ops")
        yield* (yield* ActorTest).advance(0)
      }).pipe(Effect.provideContext(context))

      const [letter] = yield* sql<{ effect_id: string }>`SELECT effect_id FROM actor_dead_letters`

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const fetcher = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(FetchHttpClient.layer.pipe(Layer.provide(fetcher)))

      const args = (action: "retry" | "discard") =>
        parseRepair({
          action,
          args: [
            letter!.effect_id,
            "--actor",
            "CliPager/p1",
            "--url",
            "http://runner",
            "--tenant",
            tenant,
            "--reason",
            "pager is back",
          ],
        })

      provider.up = true

      const retried = yield* repair({ options: yield* args("retry"), token: "repair-token" }).pipe(
        Effect.provideContext(services),
      )

      expect(retried).toMatchObject({ effectId: expect.any(String) })
      yield* Context.get(context, ActorTest).advance(0)
      expect(provider.calls).toBe(2)

      const again = yield* repair({ options: yield* args("discard"), token: "repair-token" }).pipe(
        Effect.provideContext(services),
        Effect.flip,
      )

      expect(again).toMatchObject({ status: 404 })

      const unauthorized = yield* repair({
        options: yield* args("retry"),
        token: "app-token",
      }).pipe(Effect.provideContext(services), Effect.flip)

      expect(unauthorized).toMatchObject({ status: 401 })
    }).pipe(Effect.scoped, Effect.runPromise))
})
