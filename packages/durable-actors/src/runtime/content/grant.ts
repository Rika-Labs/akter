import { Effect, Encoding, Redacted, Result } from "effect"
import type { InvalidContentRef } from "../../errors/content.ts"

/** How long a grant lasts from when it is issued. */
export const GRANT_LIFETIME_MS = 3_600_000

/** One deployment secret grants are signed or verified with. */
export interface GrantKey {
  /** Named in every grant it signs, so a rotated-out key still verifies its grants. */
  readonly id: string
  /** At least 32 bytes of UTF-8. */
  readonly secret: Redacted.Redacted<string>
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/

// `g1.<key id>.<expires ms>.<mac>`, the MAC as unpadded base64url of 32 bytes.
const GRANT = /^g1\.([A-Za-z0-9_-]{1,32})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/

const utf8 = new TextEncoder()

/** What a grant binds. The deployment id keeps grants of one database out of another. */
export interface Granted {
  readonly tenant: string
  readonly hash: string
  readonly size: number
  readonly expiresAt: number
}

// Length-prefixed parts, so no two bindings encode to the same message.
const message = (deployment: string, granted: Granted) =>
  utf8.encode(
    [
      "durable-content/v1",
      deployment,
      granted.tenant,
      granted.hash,
      String(granted.size),
      String(granted.expiresAt),
    ]
      .map((part) => `${part.length}:${part}`)
      .join(""),
  )

export interface Grants {
  /** Signs with the first key. */
  readonly sign: (granted: Granted) => Effect.Effect<string>
  /**
   * Checks a grant's MAC under any configured key; returns its expiry. The
   * caller checks the expiry against the database clock.
   */
  readonly verify: (
    grant: string,
    bound: Omit<Granted, "expiresAt">,
  ) => Effect.Effect<Result.Result<number, InvalidContentRef["reason"]>>
}

/**
 * Validates `keys` and imports them once. The first key signs; every key
 * verifies, so an operator adds the new key first, keeps the old one listed
 * for one grant lifetime, and then removes it.
 */
export const makeGrants = Effect.fnUntraced(function* (
  keys: ReadonlyArray<GrantKey>,
  deployment: string,
) {
  if (keys.length === 0) return yield* Effect.die(new Error("content.keys needs at least one key"))

  const imported = new Map<string, CryptoKey>()

  for (const key of keys) {
    if (!KEY_ID.test(key.id))
      return yield* Effect.die(new Error("content.keys ids are 1-32 letters, digits, - or _"))

    if (imported.has(key.id))
      return yield* Effect.die(new Error(`content.keys lists ${key.id} twice`))

    const secret = utf8.encode(Redacted.value(key.secret))

    if (secret.byteLength < 32)
      return yield* Effect.die(
        new Error(`content.keys ${key.id} needs a secret of at least 32 bytes`),
      )

    imported.set(
      key.id,
      yield* Effect.promise(() =>
        globalThis.crypto.subtle.importKey(
          "raw",
          secret,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      ),
    )
  }

  const signer = keys[0]!.id

  const grants: Grants = {
    sign: (granted) =>
      Effect.promise(() =>
        globalThis.crypto.subtle.sign("HMAC", imported.get(signer)!, message(deployment, granted)),
      ).pipe(
        Effect.map(
          (mac) =>
            `g1.${signer}.${granted.expiresAt}.${Encoding.encodeBase64Url(new Uint8Array(mac))}`,
        ),
      ),
    verify: (grant, bound) =>
      Effect.gen(function* () {
        const parts = GRANT.exec(grant)

        if (parts === null) return Result.fail("malformed" as const)

        const expiresAt = Number(parts[2])
        const key = imported.get(parts[1]!)
        const mac = Encoding.decodeBase64Url(parts[3]!)

        if (!Number.isSafeInteger(expiresAt) || Result.isFailure(mac))
          return Result.fail("malformed" as const)

        if (key === undefined) return Result.fail("invalid" as const)

        // WebCrypto's verify compares in constant time.
        const valid = yield* Effect.promise(() =>
          globalThis.crypto.subtle.verify(
            "HMAC",
            key,
            new Uint8Array(mac.success),
            message(deployment, { ...bound, expiresAt }),
          ),
        )

        return valid ? Result.succeed(expiresAt) : Result.fail("invalid" as const)
      }),
  }

  return grants
})
