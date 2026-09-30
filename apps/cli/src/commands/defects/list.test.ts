import { Actor, User } from "@durable-actors/core"
import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { RunnerUnreachable } from "../operator/request.ts"
import { UsageError } from "../workflows/check.ts"
import { formatDefects, listDefects, parseList } from "./list.ts"

const Break = Actor.command("Break", { input: Schema.String })

const Fine = Actor.command("Fine")

const Boiler = Actor.make("Boiler", { key: Schema.String, api: { Break, Fine } })

const BoilerLive = Boiler.toLayer(
  Effect.succeed({
    Break: (reason: string) => Effect.die(new Error(`boiler broke: ${reason}`)),
    Fine: () => Effect.void,
  }),
)

const live = BoilerLive.pipe(
  Layer.provideMerge(ActorTest.layer({ as: User.make({ subject: "alice" }) })),
  Layer.provideMerge(BunCrypto.layer),
)

const grant = (tenant: string) => ({
  operator: `ops-${tenant}`,
  capabilities: [{ action: "defects.read" as const, tenant }],
})

/**
 * Each token reads its own tenant's defects; "reader" reads every tenant's.
 */
const operators = OperatorAuth.tokens([
  { token: Redacted.make("plant-token"), grant: grant("plant") },
  { token: Redacted.make("other-token"), grant: grant("other") },
  { token: Redacted.make("reader-token"), grant: grant("*") },
])

describe("durable defects list", () => {
  it("parses runners, filters, and compact durations", () =>
    Effect.gen(function* () {
      const options = yield* parseList({
        args: ["--url", "http://a/", "--url", "http://b", "--actor", "Room", "--since", "1h"],
        nowMs: 10_000_000,
      })

      expect(options).toEqual({
        urls: ["http://a", "http://b"],
        tenant: "*",
        actor: "Room",
        sinceMs: 10_000_000 - 3_600_000,
        limit: undefined,
        tokenEnv: "DURABLE_OPERATOR_TOKEN",
        json: false,
      })

      const long = yield* parseList({ args: ["--url", "u", "--since", "90 minutes"], nowMs: 0 })
      expect(long.sinceMs).toBe(-5_400_000)

      for (const [args, message] of [
        [[], "--url is required"],
        [["--url"], "--url needs a value"],
        [["--url", "u", "--limit", "0"], "--limit must be an integer from 1 to 1000"],
        [["--url", "u", "--x"], "Unknown argument: --x"],
      ] as const) {
        const failure = yield* parseList({ args, nowMs: 0 }).pipe(Effect.flip)

        expect(failure).toBeInstanceOf(UsageError)
        expect(failure.message).toBe(message)
      }
    }).pipe(Effect.runPromise))

  it("lists a runner's defect spans for the operator's tenant, newest last", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(live)

      yield* Effect.gen(function* () {
        const boiler = yield* Boiler.get("b1").pipe(Actor.tenant("plant"))
        yield* boiler.Fine()
        yield* Effect.exit(boiler.Break("pressure"))
        yield* Effect.exit(boiler.Break("heat"))
        yield* Effect.exit((yield* Boiler.get("b2").pipe(Actor.tenant("other"))).Break("x"))
      }).pipe(Effect.provideContext(context))

      const web = HttpRouter.toWebHandler(
        Operators.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const client = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(FetchHttpClient.layer.pipe(Layer.provide(client)))

      const read = (token: string | undefined, tenant: string, actor?: string) =>
        listDefects(
          { urls: ["http://runner"], tenant, actor, sinceMs: undefined, limit: undefined },
          token,
        ).pipe(Effect.provideContext(services))

      const defects = yield* read("plant-token", "plant")

      expect(
        defects.map(({ actorType, actorId, command, tenant }) => ({
          actorType,
          actorId,
          command,
          tenant,
        })),
      ).toEqual([
        { actorType: "Boiler", actorId: "b1", command: "Break", tenant: "plant" },
        { actorType: "Boiler", actorId: "b1", command: "Break", tenant: "plant" },
      ])
      expect(defects[0]!.span).toBe("durable-actors.Boiler/Break")
      expect(defects[0]!.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(defects[0]!.cause).toContain("boiler broke: pressure")
      expect(defects[1]!.cause).toContain("boiler broke: heat")

      expect((yield* read("other-token", "other")).map(({ actorId }) => actorId)).toEqual(["b2"])
      expect((yield* read("reader-token", "*")).map(({ actorId }) => actorId)).toEqual([
        "b1",
        "b1",
        "b2",
      ])
      expect(yield* read("plant-token", "plant", "Kettle")).toEqual([])

      for (const [token, tenant, status] of [
        ["plant-token", "other", 403],
        ["plant-token", "*", 403],
        [undefined, "plant", 401],
      ] as const) {
        const refused = yield* read(token, tenant).pipe(Effect.flip)

        expect(refused).toBeInstanceOf(RunnerUnreachable)
        expect(refused.url).toBe("http://runner")
        expect(refused.message).toContain(`non 2xx status code (${status} GET`)
      }

      const browse = (origin: string) =>
        web.handler(
          new Request("http://runner/operator/defects?tenant=plant", {
            headers: { authorization: "Bearer plant-token", origin },
          }),
        )

      const foreign = yield* Effect.promise(() => browse("https://elsewhere.example"))
      expect(foreign.status).toBe(403)
      expect(yield* Effect.promise(() => foreign.text())).toContain("origin_not_allowed")

      const plain = yield* Effect.promise(() =>
        web.handler(
          new Request("http://runner/operator/defects?tenant=plant", {
            headers: { authorization: "Bearer plant-token" },
          }),
        ),
      )

      expect(plain.status).toBe(200)

      const text = formatDefects({ defects, json: false }).split("\n")
      expect(text).toHaveLength(2)
      expect(text[0]).toContain("Boiler/b1  Break ")
      expect(text[0]).toContain("tenant=plant")
      expect(formatDefects({ defects: [], json: false })).toBe("No defects.")
      expect(formatDefects({ defects, json: true })).toContain(
        `"span": "durable-actors.Boiler/Break"`,
      )
    }).pipe(Effect.scoped, Effect.runPromise))
})
