import { Effect, Redacted } from "effect"

/**
 * The edge's `EDGE_SIGNING_KEYS`: a JSON array of Ed25519 private JWKs, converted from the PKCS#8
 * PEM the stack generated. The key id is the head of the public key, which is stable for the key.
 */
export const signingKeys = (pem: Redacted.Redacted<string>) =>
  Effect.tryPromise(() => {
    const body = Redacted.value(pem)
      .replace(/-----[A-Z ]+-----/g, "")
      .replace(/\s+/g, "")
    return crypto.subtle
      .importKey(
        "pkcs8",
        Uint8Array.from(atob(body), (char) => char.charCodeAt(0)),
        "Ed25519",
        true,
        ["sign"],
      )
      .then((key) => crypto.subtle.exportKey("jwk", key))
  }).pipe(
    Effect.flatMap((jwk) =>
      jwk.x === undefined || jwk.d === undefined
        ? Effect.die(new Error("The generated key is not an Ed25519 private key"))
        : Effect.succeed(
            Redacted.make(JSON.stringify([{ kid: jwk.x.slice(0, 16), x: jwk.x, d: jwk.d }])),
          ),
    ),
    Effect.orDie,
  )
