import { Actor, User } from "@durable-actors/core"
import { OperatorAuth, Operators } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { BunCrypto } from "@effect/platform-bun"
import { Clock, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"

import { recordingFetch, runCli, runCliWith } from "../../testing.ts"
import { OperatorRefused } from "../operator/request.ts"
import { formatDefects, listDefects } from "./list.ts"

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
      const runners = recordingFetch([])
      const before = yield* Clock.currentTimeMillis

      const listed = yield* runCliWith({
        fetch: runners.fetch,
        env: { DURABLE_OPERATOR_TOKEN: "ops-token" },
      })([
        "defects",
        "list",
        "--url",
        "http://a/",
        "--url",
        "http://b",
        "--actor",
        "Room",
        "--since",
        "1h",
      ])

      expect(listed).toEqual({ stdout: "No defects.\n", stderr: "", exitCode: 0, reason: "" })
      expect(runners.requests.map(({ url }) => new URL(url).origin)).toEqual([
        "http://a",
        "http://b",
      ])

      for (const { url, authorization } of runners.requests) {
        const query = new URL(url).searchParams
        const sinceMs = Number(query.get("sinceMs"))

        expect(new URL(url).pathname).toBe("/operator/defects")
        expect(query.get("tenant")).toBe("*")
        expect(query.get("actor")).toBe("Room")
        expect(query.has("limit")).toBe(false)
        expect(sinceMs).toBeGreaterThanOrEqual(before - 3_600_000 - 1)
        expect(sinceMs).toBeLessThanOrEqual((yield* Clock.currentTimeMillis) - 3_600_000)
        expect(authorization).toBe("Bearer ops-token")
      }

      const long = recordingFetch([])
      yield* runCliWith({
        fetch: long.fetch,
      })(["defects", "list", "--url", "http://c", "--since", "90 minutes", "--limit", "5"])
      const query = new URL(long.requests[0]!.url).searchParams
      const ago = (yield* Clock.currentTimeMillis) - Number(query.get("sinceMs"))
      expect(ago).toBeGreaterThanOrEqual(5_400_000)
      expect(ago).toBeLessThan(5_460_000)
      expect(query.get("limit")).toBe("5")

      for (const [args, reason, message] of [
        [[], "MissingOption", "Missing required flag: --url"],
        [["--url"], "InvalidValue", "Missing value for flag --url"],
        [
          ["--url", "u", "--limit", "0"],
          "InvalidValue",
          'Invalid value for flag --limit: "0". Expected: an integer from 1 to 1000',
        ],
        [["--url", "u", "--x"], "UnrecognizedOption", "Unrecognized flag: --x"],
        [
          ["--url", "u", "--since", "soon"],
          "InvalidValue",
          'Invalid value for flag --since: "soon"',
        ],
      ] as const) {
        const refused = yield* runCli(["defects", "list", ...args])

        expect(refused).toMatchObject({ exitCode: 2, reason })
        expect(refused.stderr).toContain(message)
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
      const foreignTenant = yield* read("plant-token", "other").pipe(Effect.flip)

      expect(foreignTenant).toBeInstanceOf(OperatorRefused)
      expect(foreignTenant).toMatchObject({ status: 403 })
      const everyTenant = yield* read("plant-token", "*").pipe(Effect.flip)

      expect(everyTenant).toBeInstanceOf(OperatorRefused)
      expect(everyTenant).toMatchObject({ status: 403 })
      expect(yield* read("plant-token", "plant", "Kettle")).toEqual([])
      const anonymous = yield* read(undefined, "plant").pipe(Effect.flip)

      expect(anonymous).toBeInstanceOf(OperatorRefused)
      expect(anonymous).toMatchObject({ status: 401 })

      const fetch = ((input, init) =>
        web.handler(new Request(input, init))) as typeof globalThis.fetch

      const cli = (token: string, tenant: string) =>
        runCliWith({ fetch, env: { DURABLE_OPERATOR_TOKEN: token } })([
          "defects",
          "list",
          "--url",
          "http://runner",
          "--tenant",
          tenant,
        ])

      const listed = yield* cli("plant-token", "plant")

      expect(listed).toMatchObject({ exitCode: 0, reason: "" })
      expect(
        listed.stdout.split("\n").filter((line) => line.includes("Boiler/b1  Break ")),
      ).toHaveLength(2)

      for (const [token, tenant, status] of [
        ["plant-token", "other", 403],
        ["nobody", "plant", 401],
      ] as const) {
        const refused = yield* cli(token, tenant)

        expect(refused).toMatchObject({ exitCode: 1, reason: "OperatorRefused" })
        expect(refused.stderr).toMatch(new RegExp(`^Refused \\(${status}\\): `))
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
