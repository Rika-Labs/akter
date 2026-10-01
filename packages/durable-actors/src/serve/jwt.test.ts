import { Clock, Effect, Exit, Option, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { Headers } from "effect/http"
import { describe, expect, it } from "vitest"
import { Unauthorized } from "../errors/actor.ts"
import { Jwk, jwt } from "./jwt.ts"

interface JwtHeader {
  readonly alg: string
  readonly kid: string
}

interface TokenClaims {
  readonly iss: string
  readonly aud: string
  readonly sub: string
  readonly org: string
  readonly exp?: number
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const keyPair = Effect.promise(() =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
)

const segment = (value: JwtHeader | TokenClaims) =>
  encodeJson({ ...value }).pipe(Effect.orDie, Effect.map(Base64Url.encode))

const sign = Effect.fnUntraced(function* (key: CryptoKey, header: JwtHeader, claims: TokenClaims) {
  const signed = `${yield* segment(header)}.${yield* segment(claims)}`

  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signed)),
  )

  return `${signed}.${Base64Url.encode(new Uint8Array(signature))}`
})

const setup = Effect.gen(function* () {
  const keys = yield* keyPair
  const other = yield* keyPair
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", keys.publicKey))

  const jwk = {
    ...(yield* Schema.decodeUnknownEffect(Jwk)(exported).pipe(Effect.orDie)),
    kid: "k1",
  }

  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

  const provider = jwt({
    issuer: "https://issuer.example",
    audience: "api",
    jwks: { keys: [jwk] },
    tenant: (claims) => (Schema.is(Schema.String)(claims.org) ? claims.org : ""),
  })

  const claims: TokenClaims = {
    iss: "https://issuer.example",
    aud: "api",
    sub: "alice",
    org: "acme",
    exp: now + 60,
  }

  const code = Effect.fnUntraced(function* (token: string) {
    const exit = yield* Effect.exit(
      provider.authenticate({
        headers: Headers.fromInput({ authorization: `Bearer ${token}` }),
        cookies: {},
      }),
    )

    return Option.match(Exit.findErrorOption(exit), {
      onNone: () => "ok",
      onSome: (error) => (Schema.is(Unauthorized)(error) ? error.code : error._tag),
    })
  })

  return { keys, other, provider, claims, code, now }
})

describe("Actor.auth.jwt", () => {
  it("refuses a verified token whose exp is past the representable time as invalid, not a defect", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { keys, provider, claims } = yield* setup

        const token = yield* sign(
          keys.privateKey,
          { alg: "ES256", kid: "k1" },
          { ...claims, exp: 1e20 },
        )

        const exit = yield* provider
          .authenticate({
            headers: Headers.fromInput({ authorization: `Bearer ${token}` }),
            cookies: {},
          })
          .pipe(Effect.exit)

        expect(exit).toEqual(Exit.fail(Unauthorized.make({ code: "invalid_credentials" })))
      }),
    ))

  it("accepts a valid token with its subject and tenant from verified claims", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { keys, provider, claims } = yield* setup
        const token = yield* sign(keys.privateKey, { alg: "ES256", kid: "k1" }, claims)

        const authenticated = yield* provider.authenticate({
          headers: Headers.fromInput({ authorization: `Bearer ${token}` }),
          cookies: {},
        })

        expect(authenticated.tenant).toBe("acme")
        expect(authenticated.caller).toHaveProperty("_tag", "User")
        expect(authenticated.caller).toHaveProperty("subject", "alice")
      }),
    ))

  it("rejects a wrong key, issuer, audience, algorithm, and missing exp; reports expiry", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { keys, other, claims, code, now } = yield* setup
        const header = { alg: "ES256", kid: "k1" }
        const { exp: _, ...noExp } = claims

        for (const [key, tokenHeader, tokenClaims, expected] of [
          [other.privateKey, header, claims, "invalid_credentials"],
          [keys.privateKey, header, { ...claims, iss: "x" }, "invalid_credentials"],
          [keys.privateKey, header, { ...claims, aud: "x" }, "invalid_credentials"],
          [keys.privateKey, { alg: "HS256", kid: "k1" }, claims, "invalid_credentials"],
          [keys.privateKey, header, noExp, "invalid_credentials"],
          [keys.privateKey, header, { ...claims, exp: now - 120 }, "expired"],
        ] as const)
          expect(yield* code(yield* sign(key, tokenHeader, tokenClaims))).toBe(expected)

        expect(yield* code("not.a.jwt")).toBe("invalid_credentials")
      }),
    ))
})
