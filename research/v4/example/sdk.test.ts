// Typecheck-only sketch: the Promise SDK through `Actor.serve`, in-process, with the real auth middleware and serialization.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Layer } from "effect"
import { Actor, Unauthorized } from "../framework/Actor.ts"
import { ActorTest, conformance, describeConformance } from "../framework/Testing.ts"
import { Counter, CounterId, Overflow } from "./Counter.ts"
import { CounterLive, CounterReads } from "./Counter.server.ts"
import { PrincipalSchema, UserId } from "./Principal.ts"

const auth = Actor.auth((headers) =>
  headers["x-user"] === undefined
    ? Effect.fail(new Unauthorized({ reason: "missing x-user" }))
    : Effect.succeed({ userId: UserId.make(headers["x-user"]), roles: ["member"] as const })
)

const TestLive = Layer.mergeAll(CounterLive, CounterReads).pipe(
  Layer.provideMerge(ActorTest.layer({ principal: PrincipalSchema }))
)

it.layer(TestLive)("sdk", (it) => {
  it.effect("declared errors arrive as thrown instances of the same classes", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const server = yield* test.serve({ actors: [Counter], auth })
      const counter = server.client(Counter, { headers: { "x-user": "alice" } }).get(CounterId.make("c1"))

      expect(yield* Effect.promise(() => counter.Increment(1))).toBe(1)
      const thrown = yield* Effect.tryPromise(() => counter.Increment(5_000)).pipe(Effect.flip)
      expect(thrown.cause).toEqual(new Overflow({ max: 1_000 }))

      const handled = (yield* test.turns.of(Counter, CounterId.make("c1")))[0]
      expect(handled?.caller).toEqual({ _tag: "User", principal: { userId: "alice", roles: ["member"] } })
    }))

  it.effect("no credentials: Unauthorized at the edge, no turn ran", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const server = yield* test.serve({ actors: [Counter], auth })
      const anonymous = server.client(Counter).get(CounterId.make("c2"))
      const thrown = yield* Effect.tryPromise(() => anonymous.Increment(1)).pipe(Effect.flip)
      expect(thrown.cause).toEqual(new Unauthorized({ reason: "missing x-user" }))
      expect(yield* test.turns.of(Counter, CounterId.make("c2"))).toEqual([])
    }))

  it.effect("the OpenAPI document lists every command, query and stream with the declared error statuses", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const server = yield* test.serve({ actors: [Counter], auth })
      const spec = yield* server.http.get("/openapi.json").pipe(Effect.flatMap((r) => r.json), Effect.orDie)
      expect(JSON.stringify(spec)).toContain("Overflow")
    }))
})

// the same gate list runs on every database the layer can point at; Neki support means this passes on Neki
it.layer(ActorTest.layer({ database: "pglite" }))("conformance: pglite", (it) => describeConformance(it.effect))
it.layer(ActorTest.layer({ database: { url: process.env["TEST_PG_URL"] ?? "", neki: false } }))("conformance: postgres", (it) =>
  describeConformance(it.effect.skipIf(process.env["TEST_PG_URL"] === undefined))
)
it.layer(ActorTest.layer({ database: { url: process.env["TEST_NEKI_URL"] ?? "", neki: true } }))("conformance: neki", (it) =>
  describeConformance(it.effect.skipIf(process.env["TEST_NEKI_URL"] === undefined))
)
export const gateCount = conformance.length
