import { ASSERTION_TYPE, KEY_REFRESH_TYPE } from "@durable-actors/core"
import type { AssertionClaims } from "@durable-actors/core/runtime"
import { Clock, Duration, Effect, Encoding, Ref, Schedule, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import type { EdgeOptions, SigningKey } from "../config.ts"

interface Published {
  readonly publishedAt: number
  readonly expiresAt: number | null
  readonly revoked: boolean
}

interface LoadedKey {
  readonly kid: string
  readonly privateKey: CryptoKey
}

/** Signs assertions and key-set refresh pushes with the edge's keys. */
export interface KeyRing {
  /** Signs `claims` with the newest usable key, if there is one. */
  readonly sign: (claims: AssertionClaims) => Effect.Effect<string | undefined>
  /**
   * Signs a key-set refresh push for `audience`. A runner verifies it with the
   * keys it already holds, so when no key is usable a revoked one still
   * serves: all the push can do is make the runner reread the set.
   */
  readonly signRefresh: (audience: string) => Effect.Effect<string | undefined>
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const segment = (value: Schema.Json) =>
  encodeJson(value).pipe(Effect.orDie, Effect.map(Encoding.encodeBase64Url))

const utf8 = new TextEncoder()

const importKey = (key: SigningKey) =>
  Effect.promise(() =>
    crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: key.x, d: key.d },
      { name: "Ed25519" },
      false,
      ["sign"],
    ),
  ).pipe(Effect.map((privateKey): LoadedKey => ({ kid: key.kid, privateKey })))

/**
 * The edge's signing keys. It publishes each key's public half, then signs
 * only with a key published for at least `publicationLead`, so every runner
 * has had time to reread its key set. A key the control plane revoked or
 * expired stops signing within one poll.
 *
 * A kid names one key for good: runners already trust its published half, so a
 * different key under the same kid would sign assertions no runner can verify.
 */
export const keyRing = Effect.fnUntraced(function* (options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient
  const keys = yield* Effect.forEach(options.signingKeys, importKey)
  const kids = keys.map((key) => key.kid)

  for (const key of options.signingKeys) {
    const [row] = yield* sql<{ readonly x: string }>`
      INSERT INTO edge_key (kid, x) VALUES (${key.kid}, ${key.x})
      ON CONFLICT (kid) DO UPDATE SET kid = edge_key.kid
      RETURNING x
    `.pipe(Effect.orDie)

    if (row?.x !== key.x)
      return yield* Effect.die(
        new Error(
          `Edge key ${key.kid} is published with a different public key; give the new key a new kid`,
        ),
      )
  }

  const published = yield* Ref.make(new Map<string, Published>())

  const refresh = sql<{
    readonly kid: string
    readonly publishedAt: number
    readonly expiresAt: number | null
    readonly revoked: boolean
  }>`
    SELECT kid,
      (extract(epoch FROM published_at) * 1000)::float8 AS "publishedAt",
      (extract(epoch FROM expires_at) * 1000)::float8 AS "expiresAt",
      revoked_at IS NOT NULL AS revoked
    FROM edge_key WHERE kid IN ${sql.in(kids)}
  `.pipe(
    Effect.flatMap((rows) =>
      Ref.set(published, new Map(rows.map(({ kid, ...row }) => [kid, row]))),
    ),
  )

  yield* refresh.pipe(Effect.orDie)
  yield* refresh.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Edge key refresh failed", cause)),
    Effect.repeat(Schedule.spaced(options.pollEvery)),
    Effect.forkScoped,
  )

  const lead = Duration.toMillis(options.publicationLead)
  const lifetime = Duration.toMillis(options.assertionLifetime)

  const current = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* Ref.get(published)

    const usable = keys
      .map((key) => ({ key, row: rows.get(key.kid) }))
      .filter(
        ({ row }) =>
          row !== undefined &&
          !row.revoked &&
          row.publishedAt <= now - lead &&
          (row.expiresAt === null || row.expiresAt > now + lifetime),
      )
      .sort((left, right) => (right.row?.publishedAt ?? 0) - (left.row?.publishedAt ?? 0))

    return usable[0]?.key
  })

  const jws = Effect.fnUntraced(function* (
    key: LoadedKey,
    typ: string,
    claims: { readonly [claim: string]: Schema.Json },
  ) {
    const header = yield* segment({ alg: "EdDSA", typ, kid: key.kid })
    const signed = `${header}.${yield* segment(claims)}`

    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8.encode(signed)),
    )

    return `${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`
  })

  return {
    sign: (claims) =>
      Effect.gen(function* () {
        const key = yield* current

        if (key === undefined) return undefined

        return yield* jws(key, ASSERTION_TYPE, { ...claims })
      }),
    signRefresh: (audience) =>
      Effect.gen(function* () {
        const key = (yield* current) ?? keys[0]

        if (key === undefined) return undefined

        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        const exp = now + Math.floor(Duration.toSeconds(options.assertionLifetime))

        return yield* jws(key, KEY_REFRESH_TYPE, {
          iss: options.issuer,
          aud: audience,
          iat: now,
          exp,
        })
      }),
  } satisfies KeyRing
})
