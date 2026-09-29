import { Actor, Unauthorized, User } from "@durable-actors/core"
import { Telemetry } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient, Headers, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

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

// `Bearer <tenant>`: the operator token names the tenant it reads.
const operators = Actor.auth.make((request) =>
  Option.match(Headers.get(request.headers, "authorization"), {
    onNone: () => Effect.fail(Unauthorized.make({ code: "missing_credentials" })),
    onSome: (header) => {
      const match = /^Bearer ([A-Za-z0-9._:-]+)$/.exec(header)

      return match === null
        ? Effect.fail(Unauthorized.make({ code: "invalid_credentials" }))
        : Effect.succeed({ tenant: match[1]!, caller: User.make({ subject: "operator" }) })
    },
  }),
)

describe("durable defects list", () => {
  it("parses runners, filters, and compact durations", () =>
    Effect.gen(function* () {
      const options = yield* parseList({
        args: ["--url", "http://a/", "--url", "http://b", "--actor", "Room", "--since", "1h"],
        nowMs: 10_000_000,
      })

      expect(options).toEqual({
        urls: ["http://a", "http://b"],
        actor: "Room",
        sinceMs: 10_000_000 - 3_600_000,
        limit: undefined,
        tokenEnv: "DURABLE_TOKEN",
        json: false,
      })

      const long = yield* parseList({ args: ["--url", "u", "--since", "90 minutes"], nowMs: 0 })
      expect(long.sinceMs).toBe(-5_400_000)

      for (const args of [[], ["--url"], ["--url", "u", "--limit", "0"], ["--url", "u", "--x"]])
        expect(Exit.isFailure(yield* parseList({ args, nowMs: 0 }).pipe(Effect.exit))).toBe(true)
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
        Telemetry.serve({ auth: operators }).pipe(Layer.provide(Layer.succeedContext(context))),
        { disableLogger: true },
      )

      yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

      const client = Layer.succeed(FetchHttpClient.Fetch, ((input, init) =>
        web.handler(new Request(input, init))) as typeof fetch)

      const services = yield* Layer.build(FetchHttpClient.layer.pipe(Layer.provide(client)))

      const read = (token: string | undefined, actor?: string) =>
        listDefects(
          { urls: ["http://runner"], actor, sinceMs: undefined, limit: undefined },
          token,
        ).pipe(Effect.provideContext(services))

      const defects = yield* read("plant")

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

      expect((yield* read("other")).map(({ actorId }) => actorId)).toEqual(["b2"])
      expect(yield* read("plant", "Kettle")).toEqual([])
      expect(Exit.isFailure(yield* read(undefined).pipe(Effect.exit))).toBe(true)

      const browse = (origin: string) =>
        web.handler(
          new Request("http://runner/defects", {
            headers: { authorization: "Bearer plant", origin },
          }),
        )

      const foreign = yield* Effect.promise(() => browse("https://elsewhere.example"))
      expect(foreign.status).toBe(403)
      expect(yield* Effect.promise(() => foreign.text())).toContain("origin_not_allowed")

      const plain = yield* Effect.promise(() =>
        web.handler(
          new Request("http://runner/defects", { headers: { authorization: "Bearer plant" } }),
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
