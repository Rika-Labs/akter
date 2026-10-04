import { Unauthorized, User } from "@rikalabs/akter"
import { Auth, type Authenticated, type AuthProvider } from "@rikalabs/akter/runtime"
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { Headers, type HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import type { EdgeOptions } from "../config.ts"

/** A caller the edge authenticated, and when its credential stops being good. */
export interface Principal {
  readonly tenant: string
  readonly caller: typeof User.Type
  /** Epoch milliseconds; caps a session the assertion opens. */
  readonly expiresAt: number
  /**
   * The credential is the control plane's deployment service credential: a
   * hosted API key the control plane registered under `CONTROL_PLANE_SUBJECT`.
   * A JWT never is, because its issuer, not the control plane, picks its subject.
   */
  readonly service: boolean
}

/** The subject the control plane registers its deployment service credential under. */
export const CONTROL_PLANE_SUBJECT = "akter-control-plane"

/** Proves a credential for a deployment. */
export interface Authenticator {
  /**
   * The principal a `Bearer` credential proves for `deployment`: a hosted API
   * key, or a JWT under the deployment's JWT settings. A revoked or unknown
   * key fails `invalid_credentials` from the moment its revocation commits.
   */
  readonly authenticate: (options: {
    readonly deployment: string
    readonly credential: string
  }) => Effect.Effect<Principal, Unauthorized>
}

interface JwtSettings {
  readonly issuer: string
  readonly audience: string
  readonly jwksUrl: string
  readonly algorithms: ReadonlyArray<string>
  readonly tenantClaim: string | null
  readonly tenantFixed: string | null
  readonly subjectClaim: string
}

const Algorithms = Schema.Array(
  Schema.Literals([
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "EdDSA",
  ]),
)

const isString = Schema.is(Schema.String)

const invalid = Unauthorized.make({ code: "invalid_credentials" })

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map(hex),
  )

const isClaims = Schema.is(Schema.Record(Schema.String, Schema.Json))

/** A string claim by dotted path, such as `org.id`; anything else is no claim. */
const claimAt = (claims: Readonly<Record<string, Schema.Json>>, path: string) => {
  const value = path
    .split(".")
    .reduce<Schema.Json | undefined>((at, part) => (isClaims(at) ? at[part] : undefined), claims)

  return isString(value) ? value : ""
}

/**
 * The limits every served tenant and subject keep; the runner refuses the rest
 * anyway.
 */
const isTenant = Schema.is(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/u)))

/** The token of `Bearer <token>`, as a header or a WebSocket frame carries it. */
export const bearer = (value: string) => /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(value)?.[1]

/**
 * Builds the credential check. Providers are kept per deployment and settings
 * so their JWKS cache outlives a request. A credential with three dot-separated
 * parts is a JWT; anything else is a hosted API key.
 */
export const authenticator = Effect.fnUntraced(function* (options: EdgeOptions) {
  const sql = yield* SqlClient.SqlClient
  const context = yield* Effect.context<HttpClient.HttpClient>()
  const session = Duration.toMillis(options.apiKeySession)
  const pollMs = Duration.toMillis(options.pollEvery)

  const providers = new Map<
    string,
    {
      readonly key: string
      readonly at: number
      readonly provider: AuthProvider<HttpClient.HttpClient> | undefined
    }
  >()

  const jwtProvider = Effect.fnUntraced(function* (deployment: string) {
    const now = yield* Clock.currentTimeMillis
    const cached = providers.get(deployment)

    if (cached !== undefined && now - cached.at < pollMs) return cached.provider

    const [settings] = yield* sql<JwtSettings>`
      SELECT issuer, audience, jwks_url AS "jwksUrl", algorithms, tenant_claim AS "tenantClaim",
        tenant_fixed AS "tenantFixed", subject_claim AS "subjectClaim"
      FROM deployment_jwt WHERE deployment_id = ${deployment}
    `.pipe(Effect.orDie)

    const key =
      settings === undefined
        ? ""
        : [
            settings.issuer,
            settings.audience,
            settings.jwksUrl,
            settings.algorithms.join(","),
            settings.tenantClaim,
            settings.tenantFixed,
            settings.subjectClaim,
          ].join("\n")

    if (cached !== undefined && cached.key === key) {
      providers.set(deployment, { ...cached, at: now })

      return cached.provider
    }

    const provider =
      settings === undefined
        ? undefined
        : Auth.jwt({
            issuer: settings.issuer,
            audience: settings.audience,
            jwks: new URL(settings.jwksUrl),
            algorithms: yield* Schema.decodeUnknownEffect(Algorithms)(settings.algorithms).pipe(
              Effect.orDie,
            ),
            tenant: (claims) => settings.tenantFixed ?? claimAt(claims, settings.tenantClaim ?? ""),
            subject: (claims) => claimAt(claims, settings.subjectClaim),
          })

    providers.set(deployment, { key, at: now, provider })

    return provider
  })

  const apiKey = Effect.fnUntraced(function* (deployment: string, token: string) {
    const [row] = yield* sql<{ readonly tenant: string; readonly subject: string }>`
      SELECT tenant, subject FROM hosted_api_key
      WHERE key_hash = ${yield* sha256(token)} AND deployment_id = ${deployment} AND revoked_at IS NULL
    `.pipe(Effect.orDie)

    if (row === undefined) return yield* invalid

    return {
      tenant: row.tenant,
      caller: User.make({ subject: row.subject }),
      expiresAt: (yield* Clock.currentTimeMillis) + session,
      service: row.subject === CONTROL_PLANE_SUBJECT,
    } satisfies Principal
  })

  const jwt = Effect.fnUntraced(function* (deployment: string, token: string) {
    const provider = yield* jwtProvider(deployment)

    if (provider === undefined) return yield* invalid

    const authenticated: Authenticated = yield* provider
      .authenticate({
        headers: Headers.fromInput({ authorization: `Bearer ${token}` }),
        cookies: {},
      })
      .pipe(
        Effect.provideContext(context),
        Effect.catchTag("ActorUnavailable", () => Effect.fail(invalid)),
      )

    if (!Schema.is(User)(authenticated.caller) || !isTenant(authenticated.tenant))
      return yield* invalid

    return {
      tenant: authenticated.tenant,
      caller: authenticated.caller,
      expiresAt: Option.match(Option.fromUndefinedOr(authenticated.expiresAt), {
        onNone: () => Number.MAX_SAFE_INTEGER,
        onSome: (at) => at.epochMilliseconds,
      }),
      service: false,
    } satisfies Principal
  })

  return {
    authenticate: ({ deployment, credential }) => {
      const token = bearer(credential)

      if (token === undefined) return Effect.fail(invalid)

      return token.split(".").length === 3 ? jwt(deployment, token) : apiKey(deployment, token)
    },
  } satisfies Authenticator
})
