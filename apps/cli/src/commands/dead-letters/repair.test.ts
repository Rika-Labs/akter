import { Actor } from "@rikalabs/akter"
import { OperatorAuth, Operators } from "@rikalabs/akter/runtime"
import { ActorTest } from "@rikalabs/akter/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { SqlClient } from "effect/sql"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const Notify = Actor.job("CliNotify", { payload: { to: Schema.String } })

const Ping = Actor.command("Ping", { payload: Schema.String })

const Pager = Actor.make("CliPager", {
  key: Schema.String,
  api: { Ping },
  jobs: { CliNotify: { job: Notify, retry: { times: 0 } } },
})

class PagerDown extends Schema.TaggedError<PagerDown>()("PagerDown", {}) {}

const provider = { up: false, calls: 0 }

const live = Layer.mergeAll(
  Pager.toLayer({
    Ping: Effect.fnUntraced(function* (to: string) {
      yield* (yield* Pager.Turn).enqueue(Notify.make({ to }))
    }),
  }),
  Pager.toJobLayer({
    CliNotify: () =>
      Effect.suspend(() => {
        provider.calls += 1

        return provider.up ? Effect.void : Effect.fail(PagerDown.make({}))
      }),
  }),
).pipe(Layer.provideMerge(ActorTest.layer()), Layer.provideMerge(BunCrypto.layer))

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

describe("akter dead-letters", () => {
  it("parses retry and discard, and refuses a missing reason or actor", () =>
    Effect.gen(function* () {
      const runner = recordingFetch({ jobId: "e1" })

      const retried = yield* runCliWith({
        fetch: runner.fetch,
        env: { DURABLE_OPERATOR_TOKEN: "repair-token" },
      })([
        "dead-letters",
        "retry",
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
      ])

      expect(retried).toEqual({
        stdout: '{"jobId":"e1"}\n',
        stderr: "",
        exitCode: 0,
        reason: "",
      })
      expect(
        runner.requests.map(({ method, url, authorization }) => ({ method, url, authorization })),
      ).toEqual([
        {
          method: "POST",
          url: "http://runner/operator/dead-letters/e1/retry",
          authorization: "Bearer repair-token",
        },
      ])
      expect(yield* decodeJson(runner.requests[0]!.body)).toEqual({
        tenant: "t",
        actorType: "CliPager",
        actorId: "p1",
        reason: "pager is back",
        providerChecked: true,
      })

      for (const [args, reason, message] of [
        [
          ["e1", "--actor", "CliPager/p1", "--url", "u", "--tenant", "t"],
          "MissingOption",
          "Missing required flag: --reason",
        ],
        [
          ["e1", "--url", "u", "--tenant", "t", "--reason", "r"],
          "MissingOption",
          "Missing required flag: --actor",
        ],
        [
          ["e1", "--actor", "CliPager", "--url", "u", "--tenant", "t", "--reason", "r"],
          "InvalidValue",
          'Invalid value for flag --actor: "CliPager". Expected: an actor named as <Type>/<id>',
        ],
      ] as const) {
        const refused = yield* runCli(["dead-letters", "retry", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
      }

      const discard = yield* runCli([
        "dead-letters",
        "discard",
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
      ])

      expect(discard).toMatchObject({ exitCode: 2, reason: "UnrecognizedOption" })
      expect(discard.stderr).toContain("Unrecognized flag: --provider-checked")
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

      const [letter] = yield* sql<{ job_id: string }>`SELECT job_id FROM actor_dead_letters`

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const fetch = ((input, init) =>
        web.handler(new Request(input, init))) as typeof globalThis.fetch

      const repair = (action: "retry" | "discard", token: string) =>
        runCliWith({ fetch, env: { DURABLE_OPERATOR_TOKEN: token } })([
          "dead-letters",
          action,
          letter!.job_id,
          "--actor",
          "CliPager/p1",
          "--url",
          "http://runner",
          "--tenant",
          tenant,
          "--reason",
          "pager is back",
          "--json",
        ])

      provider.up = true

      const retried = yield* repair("retry", "repair-token")

      expect(retried.exitCode).toBe(0)
      expect(yield* decodeJson(retried.stdout)).toMatchObject({ jobId: expect.any(String) })
      yield* Context.get(context, ActorTest).advance(0)
      expect(provider.calls).toBe(2)

      const again = yield* repair("discard", "repair-token")

      expect(again).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
      expect(again.stderr).toMatch(/^Refused \(404\): /)

      const unauthorized = yield* repair("retry", "app-token")

      expect(unauthorized).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
      expect(unauthorized.stderr).toMatch(/^Refused \(401\): /)
    }).pipe(Effect.scoped, Effect.runPromise))
})
