import { Effect, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { signingKeys } from "./signing-keys.ts"

const Keys = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ kid: Schema.String, x: Schema.String, d: Schema.String })),
)

const pem = (key: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(key))).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`

const generate = Effect.gen(function* () {
  const pair = yield* Effect.promise(() =>
    crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]),
  )
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return { pem: pem(exported), privateKey: pair.privateKey }
})

const message = new TextEncoder().encode("assertion")

describe("edge signing keys", () => {
  it("publishes a private JWK array whose halves belong to the generated key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const generated = yield* generate
        const encoded = yield* signingKeys(Redacted.make(generated.pem))
        const [key, ...rest] = yield* Schema.decodeEffect(Keys)(Redacted.value(encoded))
        expect(rest).toEqual([])
        expect(key?.kid).toBe(key?.x.slice(0, 16))
        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign("Ed25519", generated.privateKey, message),
        )
        const publicKey = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "jwk",
            { kty: "OKP", crv: "Ed25519", x: key?.x },
            "Ed25519",
            false,
            ["verify"],
          ),
        )
        expect(
          yield* Effect.promise(() =>
            crypto.subtle.verify("Ed25519", publicKey, signature, message),
          ),
        ).toBe(true)
        const privateKey = yield* Effect.promise(() =>
          crypto.subtle.importKey(
            "jwk",
            { kty: "OKP", crv: "Ed25519", x: key?.x, d: key?.d },
            "Ed25519",
            false,
            ["sign"],
          ),
        )
        const again = yield* Effect.promise(() =>
          crypto.subtle.sign("Ed25519", privateKey, message),
        )
        expect(new Uint8Array(again)).toEqual(new Uint8Array(signature))
      }),
    ))

  it("gives different keys different ids", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* signingKeys(Redacted.make((yield* generate).pem))
        const second = yield* signingKeys(Redacted.make((yield* generate).pem))
        const [a] = yield* Schema.decodeEffect(Keys)(Redacted.value(first))
        const [b] = yield* Schema.decodeEffect(Keys)(Redacted.value(second))
        expect(a?.kid).not.toBe(b?.kid)
      }),
    ))

  it("refuses a key that is not Ed25519", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const pair = yield* Effect.promise(() =>
          crypto.subtle.generateKey(
            {
              name: "RSASSA-PKCS1-v1_5",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["sign"],
          ),
        )
        const rsa = yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey))
        const outcome = yield* Effect.exit(signingKeys(Redacted.make(pem(rsa))))
        expect(outcome._tag).toBe("Failure")
      }),
    ))
})
