import { Clock, DateTime, Effect, Encoding, Exit, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { Unauthorized } from "../../errors/actor.ts"
import { Anonymous, System, User } from "../../identity/caller.ts"
import {
  claimsFor,
  DEPLOYMENT,
  edgeKey,
  ISSUER,
  REGION,
  signAssertion,
} from "../../testing/conformance/assertions.ts"
import { type AssertionKey, assertion } from "./verify.ts"
import { Credential } from "../auth.ts"

const REQ = "a".repeat(64)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const setup = Effect.gen(function* () {
  const edge = yield* edgeKey("edge-1")
  const claims = yield* claimsFor({ tenant: "t1", subject: "alice", req: REQ })
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

  const provider = (keys: ReadonlyArray<AssertionKey> = [edge.publicKey]) =>
    assertion({ issuer: ISSUER, audience: DEPLOYMENT, region: REGION, keys: { keys } })

  const run = (token: string, keys?: ReadonlyArray<AssertionKey>) =>
    provider(keys)
      .authenticate({ headers: Headers.fromInput({ "durable-assertion": token }), cookies: {} })
      .pipe(Effect.exit)

  return { edge, claims, now, provider, run }
})

const refusal = (code: Unauthorized["code"]) => Exit.fail(Unauthorized.make({ code }))

describe("Actor.auth.assertion", () => {
  it("refuses a signed assertion whose cexp is past the representable time as invalid, not a defect", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { edge, claims, run } = yield* setup

        expect(yield* run(yield* signAssertion(edge, { ...claims, cexp: 1e20 }))).toEqual(
          refusal("invalid_credentials"),
        )
      }),
    ))

  it("reads durable-assertion and returns the caller, tenant, and binding it signs", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { edge, claims, run } = yield* setup

        expect(yield* run(yield* signAssertion(edge, claims))).toEqual(
          Exit.succeed({
            caller: User.make({ subject: "alice" }),
            tenant: "t1",
            binding: { request: REQ },
          }),
        )
      }),
    ))

  it("declares the assertion credential", () => {
    const provider = assertion({
      issuer: ISSUER,
      audience: DEPLOYMENT,
      region: REGION,
      keys: { keys: [] },
    })

    expect(provider.credentials).toEqual([Credential.Assertion()])
  })

  it("reads a frame's Bearer credential, and carries the session id and credential expiry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { edge, claims, now, provider } = yield* setup
        const anonymous = { ...claims, caller: Anonymous.make({}) }
        const token = yield* signAssertion(edge, { ...anonymous, sid: "s1", cexp: now + 600 })

        const authenticated = yield* provider().authenticate({
          headers: Headers.empty,
          cookies: {},
          credential: `Bearer ${token}`,
        })

        expect(authenticated).toEqual({
          caller: Anonymous.make({}),
          tenant: "t1",
          expiresAt: DateTime.makeUnsafe((now + 600) * 1000),
          binding: { request: REQ, session: "s1" },
        })
      }),
    ))

  it("refuses a missing assertion as missing and a malformed one as invalid", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { provider, run } = yield* setup

        const missing = yield* provider()
          .authenticate({ headers: Headers.empty, cookies: {} })
          .pipe(Effect.exit)

        expect(missing).toEqual(refusal("missing_credentials"))
        expect(yield* run("not.a-jws")).toEqual(refusal("invalid_credentials"))
      }),
    ))

  it("refuses a crit header, a claim that does not decode, and a key outside its validity", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { edge, claims, now, run } = yield* setup
        const valid = yield* signAssertion(edge, claims)

        const critical = yield* encodeJson({
          alg: "EdDSA",
          typ: "durable-assertion+jwt",
          kid: "edge-1",
          crit: ["x"],
        }).pipe(Effect.orDie)

        const withCrit = [Encoding.encodeBase64Url(critical), ...valid.split(".").slice(1)]
        const system = { ...claims, caller: System.make({ source: "actor" }) }

        const exits = [
          yield* run(withCrit.join(".")),
          yield* run(yield* signAssertion(edge, system)),
          yield* run(yield* signAssertion(edge, { ...claims, req: "not-a-digest" })),
          yield* run(valid, [{ ...edge.publicKey, nbf: now + 60 }]),
          yield* run(valid, [{ ...edge.publicKey, exp: now - 60 }]),
        ]

        for (const exit of exits) expect(exit).toEqual(refusal("invalid_credentials"))
      }),
    ))
})
