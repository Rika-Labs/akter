import {
  Clock,
  DateTime,
  Duration,
  Effect,
  Encoding,
  Option,
  Result,
  Schema,
  Semaphore,
} from "effect"
import { HttpClient } from "effect/unstable/http"
import { ActorUnavailable } from "../errors/actor.ts"
import { User } from "../identity/caller.ts"
import { type AuthProvider, bearerToken, Credential, unauthorized } from "./auth.ts"

/** A JWS algorithm `Actor.auth.jwt` can verify. */
type Algorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "EdDSA"

/** A JSON Web Key as `Actor.auth.jwt` reads it; unrecognized members are dropped. */
export const Jwk = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  alg: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
})

/** A JSON Web Key as `Actor.auth.jwt` reads it. */
export type Jwk = typeof Jwk.Type

/** A static JSON Web Key Set. */
interface Jwks {
  readonly keys: ReadonlyArray<Jwk>
}

const JwksJson = Schema.Struct({ keys: Schema.Array(Schema.Unknown) })

const decodeJwk = Schema.decodeUnknownOption(Jwk)

/** The verified payload of a JWT, handed to the `tenant` and `subject` callbacks. */
type Claims = Readonly<Record<string, Schema.Json>>

/** Options of `Actor.auth.jwt`. */
interface JwtOptions<Keys extends URL | Jwks> {
  /** The required `iss` claim. */
  readonly issuer: string
  /** The token's `aud` must include at least one of these. */
  readonly audience: string | ReadonlyArray<string>
  /** A JWKS URL, fetched when first needed and refetched for an unknown `kid` at most once a minute, or static keys. */
  readonly jwks: Keys
  /** The tenant, from verified claims only. A single-tenant application returns `"default"`. */
  readonly tenant: (claims: Claims) => string
  /** The stable subject; defaults to the `sub` claim. */
  readonly subject?: (claims: Claims) => string
  /** Accepted asymmetric algorithms. Default `RS256`, `ES256`, and `EdDSA`. */
  readonly algorithms?: ReadonlyArray<Algorithm>
  /** Default 30 seconds. */
  readonly clockTolerance?: Duration.Input
}

interface Params {
  readonly kty: string
  readonly crv?: string
  readonly importKey: RsaHashedImportParams | EcKeyImportParams | Algorithm_
  readonly verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams
}

type Algorithm_ = { readonly name: string }

const rsa = (name: "RSASSA-PKCS1-v1_5" | "RSA-PSS", bits: 256 | 384 | 512): Params => ({
  kty: "RSA",
  importKey: { name, hash: `SHA-${bits}` },
  verify: name === "RSA-PSS" ? { name, saltLength: bits / 8 } : { name },
})

const ALGORITHMS: Record<Algorithm, Params> = {
  RS256: rsa("RSASSA-PKCS1-v1_5", 256),
  RS384: rsa("RSASSA-PKCS1-v1_5", 384),
  RS512: rsa("RSASSA-PKCS1-v1_5", 512),
  PS256: rsa("RSA-PSS", 256),
  PS384: rsa("RSA-PSS", 384),
  PS512: rsa("RSA-PSS", 512),
  ES256: {
    kty: "EC",
    crv: "P-256",
    importKey: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    crv: "P-384",
    importKey: { name: "ECDSA", namedCurve: "P-384" },
    verify: { name: "ECDSA", hash: "SHA-384" },
  },
  EdDSA: {
    kty: "OKP",
    crv: "Ed25519",
    importKey: { name: "Ed25519" },
    verify: { name: "Ed25519" },
  },
}

const isAlgorithm = Schema.is(Schema.Literals(Object.keys(ALGORITHMS) as Array<Algorithm>))

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  crit: Schema.optionalKey(Schema.Unknown),
})

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))

const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)

const isNumber = Schema.is(Schema.Finite)

const isString = Schema.is(Schema.String)

const REFRESH_MS = 60_000

const invalid = unauthorized("invalid_credentials")

const fits = (jwk: Jwk, alg: Algorithm) => {
  const params = ALGORITHMS[alg]

  return (
    jwk.kty === params.kty &&
    (params.crv === undefined || jwk.crv === params.crv) &&
    (jwk.alg === undefined || jwk.alg === alg) &&
    (jwk.use === undefined || jwk.use === "sig")
  )
}

const utf8 = new TextEncoder()

const verifySignature = Effect.fnUntraced(function* (
  jwk: Jwk,
  alg: Algorithm,
  signature: Uint8Array,
  signed: string,
) {
  const params = ALGORITHMS[alg]

  const key = yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("jwk", jwk, params.importKey, false, ["verify"]),
    catch: () => invalid,
  })

  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(params.verify, key, new Uint8Array(signature), utf8.encode(signed)),
    catch: () => invalid,
  })
})

/**
 * Verifies `authorization: Bearer` JWTs signed with an asymmetric key. `exp`
 * is required; `iss` must equal `issuer` and `aud` must name an `audience`;
 * `nbf` and `exp` are checked within `clockTolerance`. Tokens with `crit`
 * headers or an algorithm outside `algorithms` are refused. A missing
 * `authorization` header fails `missing_credentials`, an expired token
 * `expired`, and every other failure `invalid_credentials`. With a JWKS URL
 * the provider needs an `HttpClient`, and an unreachable key set fails
 * `ActorUnavailable`.
 * The credential's `exp` becomes the session's `expiresAt`.
 *
 * @example
 * ```ts
 * Actor.auth.jwt({
 *   issuer: "https://issuer.example.com",
 *   audience: "my-api",
 *   jwks: new URL("https://issuer.example.com/.well-known/jwks.json"),
 *   tenant: () => "default",
 * })
 * ```
 */
export const jwt = <Keys extends URL | Jwks>(
  options: JwtOptions<Keys>,
): AuthProvider<Keys extends URL ? HttpClient.HttpClient : never> => {
  const algorithms = new Set<Algorithm>(options.algorithms ?? ["RS256", "ES256", "EdDSA"])

  for (const alg of algorithms)
    if (!isAlgorithm(alg)) throw new Error(`Actor.auth.jwt: unsupported algorithm ${String(alg)}`)

  const audiences = new Set(isString(options.audience) ? [options.audience] : options.audience)

  const toleranceMs = Duration.toMillis(
    Duration.fromInputUnsafe(options.clockTolerance ?? "30 seconds"),
  )

  const lock = Semaphore.makeUnsafe(1)
  const source = options.jwks
  let cached: { readonly keys: ReadonlyArray<Jwk>; readonly at: number } | undefined

  if (!(source instanceof URL)) cached = { keys: source.keys, at: Number.POSITIVE_INFINITY }

  const fetchKeys = (url: URL) =>
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const response = yield* client.get(url)
      const body = yield* Schema.decodeUnknownEffect(JwksJson)(yield* response.json)
      const keys: Array<Jwk> = []

      for (const raw of body.keys) {
        const jwk = decodeJwk(raw)

        if (Option.isSome(jwk)) keys.push(jwk.value)
      }

      return keys
    }).pipe(
      Effect.mapError(() =>
        ActorUnavailable.make({ cause: new Error("Actor.auth.jwt could not fetch its JWKS") }),
      ),
    )

  const keysFor = (refresh: boolean) =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis

        if (
          source instanceof URL &&
          (cached === undefined || (refresh && now - cached.at >= REFRESH_MS))
        )
          cached = { keys: yield* fetchKeys(source), at: now }

        return cached!.keys
      }),
    )

  const authenticate = Effect.fnUntraced(function* (
    request: Parameters<AuthProvider["authenticate"]>[0],
  ) {
    const token = yield* bearerToken(request)
    const parts = token.split(".")

    if (parts.length !== 3) return yield* invalid
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string]
    const headerText = Encoding.decodeBase64UrlString(encodedHeader)
    const claimsText = Encoding.decodeBase64UrlString(encodedClaims)
    const signature = Encoding.decodeBase64Url(encodedSignature)

    if (Result.isFailure(headerText) || Result.isFailure(claimsText) || Result.isFailure(signature))
      return yield* invalid
    const header = decodeHeader(headerText.success)

    if (Option.isNone(header) || header.value.crit !== undefined) return yield* invalid
    const alg = header.value.alg

    if (!isAlgorithm(alg) || !algorithms.has(alg)) return yield* invalid
    const kid = header.value.kid
    const signed = `${encodedHeader}.${encodedClaims}`

    const candidates = (keys: ReadonlyArray<Jwk>) =>
      keys.filter((jwk) => fits(jwk, alg) && (kid === undefined || jwk.kid === kid))

    let keys = candidates(yield* keysFor(false))

    if (keys.length === 0 && kid !== undefined) keys = candidates(yield* keysFor(true))
    let verified = false

    for (const jwk of keys)
      if (yield* verifySignature(jwk, alg, signature.success, signed)) {
        verified = true
        break
      }

    if (!verified) return yield* invalid
    const claims = decodeClaims(claimsText.success)

    if (Option.isNone(claims)) return yield* invalid
    const { exp, nbf, iss, aud, sub } = claims.value

    if (!isNumber(exp) || iss !== options.issuer) return yield* invalid

    const audience = isString(aud) ? [aud] : Array.isArray(aud) ? aud : []

    if (!audience.some((value) => isString(value) && audiences.has(value))) return yield* invalid
    const now = yield* Clock.currentTimeMillis

    if (nbf !== undefined && (!isNumber(nbf) || nbf * 1000 > now + toleranceMs))
      return yield* invalid

    if (exp * 1000 <= now - toleranceMs) return yield* unauthorized("expired")

    const resolved = yield* Effect.try({
      try: () => ({
        subject: options.subject === undefined ? sub : options.subject(claims.value),
        tenant: options.tenant(claims.value),
      }),
      catch: () => invalid,
    })

    if (!isString(resolved.subject) || resolved.subject === "" || !isString(resolved.tenant))
      return yield* invalid

    return {
      caller: User.make({ subject: resolved.subject }),
      tenant: resolved.tenant,
      expiresAt: DateTime.makeUnsafe(exp * 1000),
    }
  })

  return {
    credentials: [Credential.Jwt()],
    authenticate: authenticate as AuthProvider<
      Keys extends URL ? HttpClient.HttpClient : never
    >["authenticate"],
  }
}
