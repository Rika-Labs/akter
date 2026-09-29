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
import { Headers, HttpClient } from "effect/unstable/http"
import { ActorUnavailable } from "../../errors/actor.ts"
import { Anonymous, User } from "../../identity/caller.ts"
import {
  type Authenticated,
  type AuthProvider,
  type AuthRequest,
  type Binding,
  Credential,
  unauthorized,
} from "../auth.ts"
import { ASSERTION_HEADER, ASSERTION_TYPE } from "./binding.ts"

/** An edge verification key: an Ed25519 public JWK, valid from `nbf` until `exp` (epoch seconds). */
export const AssertionKey = Schema.Struct({
  kid: Schema.NonEmptyString,
  kty: Schema.Literal("OKP"),
  crv: Schema.Literal("Ed25519"),
  x: Schema.NonEmptyString,
  nbf: Schema.optionalKey(Schema.Finite),
  exp: Schema.optionalKey(Schema.Finite),
})

export type AssertionKey = typeof AssertionKey.Type

/** The key set the control plane publishes for runners. */
export const AssertionKeySet = Schema.Struct({ keys: Schema.Array(AssertionKey) })

export type AssertionKeySet = typeof AssertionKeySet.Type

export interface AssertionOptions<Keys extends URL | AssertionKeySet> {
  /** The edge's issuer; `iss` must equal it. */
  readonly issuer: string
  /** The deployment id; `aud` must equal it. */
  readonly audience: string
  /** The runner's region; an assertion routed to another region is refused. */
  readonly region: string
  /** The published key-set URL, reread every `refreshEvery`, or static keys. */
  readonly keys: Keys
  /**
   * How often a key-set URL is reread, which bounds how long a removed key is
   * still accepted. Default 5 minutes.
   */
  readonly refreshEvery?: Duration.Input
}

/** The most an assertion may live, from `iat` to `exp`. */
export const MAX_ASSERTION_SECONDS = 60

/** Clock skew allowed on `iat` and `exp`; edge and runners run synchronized clocks. */
export const ASSERTION_SKEW_MS = 5_000

// An unknown `kid` rereads the key set at most this often.
const UNKNOWN_KID_REFRESH_MS = 60_000

const Header = Schema.Struct({
  alg: Schema.Literal("EdDSA"),
  typ: Schema.Literal(ASSERTION_TYPE),
  kid: Schema.NonEmptyString,
  crit: Schema.optionalKey(Schema.Never),
})

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

/** The claims an edge signs; `actor`, `id`, `member`, and `cid` are there for logs. */
export const AssertionClaims = Schema.Struct({
  iss: Schema.String,
  aud: Schema.String,
  region: Schema.String,
  iat: Schema.Finite,
  exp: Schema.Finite,
  tenant: Schema.String,
  caller: Schema.Union([User, Anonymous]),
  req: Digest,
  /** The streaming session id, on assertions for a WebSocket open or renewal. */
  sid: Schema.optionalKey(Schema.NonEmptyString),
  /** The external credential's own expiry in epoch seconds, which caps a live session. */
  cexp: Schema.optionalKey(Schema.Finite),
  actor: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  member: Schema.optionalKey(Schema.String),
  cid: Schema.optionalKey(Schema.String),
})

export type AssertionClaims = typeof AssertionClaims.Type

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header))

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(AssertionClaims))

const decodeKeySet = Schema.decodeUnknownEffect(AssertionKeySet)

const invalid = unauthorized("invalid_credentials")

const utf8 = new TextEncoder()

/** The compact JWS from a WebSocket frame's `Bearer` credential, or from `durable-assertion`. */
const tokenOf = (request: AuthRequest) => {
  if (request.credential !== undefined) {
    const match = /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(request.credential)

    return match === null ? Effect.fail(invalid) : Effect.succeed(match[1]!)
  }

  return Option.match(Headers.get(request.headers, ASSERTION_HEADER), {
    onNone: () => Effect.fail(unauthorized("missing_credentials")),
    onSome: (value) => Effect.succeed(value.trim()),
  })
}

const verifySignature = Effect.fnUntraced(function* (
  key: AssertionKey,
  signature: Uint8Array,
  signed: string,
) {
  const imported = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "jwk",
        { kty: key.kty, crv: key.crv, x: key.x },
        { name: "Ed25519" },
        false,
        ["verify"],
      ),
    catch: () => invalid,
  })

  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(
        { name: "Ed25519" },
        imported,
        new Uint8Array(signature),
        utf8.encode(signed),
      ),
    catch: () => invalid,
  })
})

/**
 * Verifies the hosted edge's signed assertion, the only provider a hosted
 * runner uses. It checks the signature, key, issuer, deployment, region, and
 * lifetime here; the server then checks the request binding against the
 * request it received before any turn.
 */
export const assertion = <Keys extends URL | AssertionKeySet>(
  options: AssertionOptions<Keys>,
): AuthProvider<Keys extends URL ? HttpClient.HttpClient : never> => {
  const refreshMs = Duration.toMillis(Duration.fromInputUnsafe(options.refreshEvery ?? "5 minutes"))
  const lock = Semaphore.makeUnsafe(1)
  const source = options.keys

  let cached: { readonly keys: ReadonlyArray<AssertionKey>; readonly at: number } | undefined =
    source instanceof URL ? undefined : { keys: source.keys, at: Number.POSITIVE_INFINITY }

  const fetchKeys = (url: URL) =>
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const response = yield* client.get(url)

      return (yield* decodeKeySet(yield* response.json)).keys
    }).pipe(
      Effect.mapError(() =>
        ActorUnavailable.make({
          cause: new Error("Actor.auth.assertion could not fetch its key set"),
        }),
      ),
    )

  // A key set older than `refreshEvery` is reread before use, and a runner that can't
  // reread it refuses rather than keep trusting keys the control plane may have removed.
  const keysFor = (unknownKid: boolean) =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis

        if (
          source instanceof URL &&
          (cached === undefined ||
            now - cached.at >= refreshMs ||
            (unknownKid && now - cached.at >= UNKNOWN_KID_REFRESH_MS))
        )
          cached = { keys: yield* fetchKeys(source), at: now }

        return cached!.keys
      }),
    )

  const authenticate = Effect.fnUntraced(function* (request: AuthRequest) {
    const token = yield* tokenOf(request)
    const parts = token.split(".")

    if (parts.length !== 3) return yield* invalid
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string]
    const headerText = Encoding.decodeBase64UrlString(encodedHeader)
    const claimsText = Encoding.decodeBase64UrlString(encodedClaims)
    const signature = Encoding.decodeBase64Url(encodedSignature)

    if (Result.isFailure(headerText) || Result.isFailure(claimsText) || Result.isFailure(signature))
      return yield* invalid

    // EdDSA with Ed25519 only: `none` and every other algorithm are refused here.
    const header = decodeHeader(headerText.success)

    if (Option.isNone(header)) return yield* invalid
    const kid = header.value.kid
    const now = yield* Clock.currentTimeMillis
    const seconds = now / 1000
    const skew = ASSERTION_SKEW_MS / 1000

    const usable = (keys: ReadonlyArray<AssertionKey>) =>
      keys.find(
        (key) =>
          key.kid === kid &&
          (key.nbf === undefined || key.nbf <= seconds + skew) &&
          (key.exp === undefined || key.exp > seconds - skew),
      )

    const key = usable(yield* keysFor(false)) ?? usable(yield* keysFor(true))

    if (key === undefined) return yield* invalid

    if (!(yield* verifySignature(key, signature.success, `${encodedHeader}.${encodedClaims}`)))
      return yield* invalid

    const claims = decodeClaims(claimsText.success)

    if (Option.isNone(claims)) return yield* invalid
    const { iss, aud, region, iat, exp, tenant, caller, req, sid, cexp } = claims.value

    if (iss !== options.issuer || aud !== options.audience || region !== options.region)
      return yield* invalid

    if (exp <= iat || exp - iat > MAX_ASSERTION_SECONDS || iat > seconds + skew)
      return yield* invalid

    if (exp <= seconds - skew) return yield* unauthorized("expired")

    const binding: Binding = sid === undefined ? { request: req } : { request: req, session: sid }
    const authenticated: Authenticated = { caller, tenant, binding }

    if (cexp === undefined) return authenticated

    return { ...authenticated, expiresAt: DateTime.makeUnsafe(cexp * 1000) }
  })

  return {
    credentials: [Credential.Assertion()],
    authenticate: authenticate as AuthProvider<
      Keys extends URL ? HttpClient.HttpClient : never
    >["authenticate"],
  }
}
