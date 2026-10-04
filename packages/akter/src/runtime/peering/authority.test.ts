import { X509Certificate } from "node:crypto"
import { createSecureContext } from "node:tls"
import { Effect, Redacted } from "effect"
import { describe, expect, it } from "vitest"
import { RunnerAuthority } from "./authority.ts"

describe("runner certificate authority", () => {
  it("issues certificates that this runtime's TLS stack loads, whatever their random serial", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const authority = yield* RunnerAuthority.make()
        const parsed = new X509Certificate(authority.certificate)

        for (let index = 0; index < 512; index++) {
          const credentials = yield* authority.issue({ deployment: "deployment-a" })
          const leaf = new X509Certificate(credentials.certificate)
          expect(leaf.serialNumber).toMatch(/^[4-7]/u)
          expect(leaf.verify(parsed.publicKey)).toBe(true)
          createSecureContext({
            ca: credentials.ca,
            cert: credentials.certificate,
            key: Redacted.value(credentials.key),
          })
        }
      }),
    ))

  it("restores a saved authority whose certificates the original's holders trust, and refuses a mismatched key", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const original = yield* RunnerAuthority.make()
        const restored = yield* RunnerAuthority.from({
          certificate: original.certificate,
          key: original.key,
        })
        const leaf = new X509Certificate(
          (yield* restored.issue({ deployment: "deployment-a" })).certificate,
        )
        expect(leaf.checkIssued(new X509Certificate(original.certificate))).toBe(true)
        expect(leaf.subjectAltName).toBe("URI:spiffe://akter/deployment/deployment-a")
        const other = yield* RunnerAuthority.make()
        const exit = yield* Effect.exit(
          RunnerAuthority.from({ certificate: original.certificate, key: other.key }),
        )
        expect(String(exit)).toContain("matching key")
      }),
    ))
})
