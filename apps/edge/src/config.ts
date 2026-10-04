import { Config, Duration, Effect, Redacted, Schema } from "effect"
import { cidrs, type TrustedProxies } from "./routing/client-ip.ts"

/** One Ed25519 signing key from the edge's secret store, as a private JWK. */
export const SigningKey = Schema.Struct({
  kid: Schema.NonEmptyString,
  x: Schema.NonEmptyString,
  d: Schema.NonEmptyString,
})

/** One Ed25519 signing key as a private JWK. */
export type SigningKey = typeof SigningKey.Type

/**
 * Everything the edge needs to run: identity, database, signing keys,
 * listening address and its time settings.
 */
export interface EdgeOptions {
  /** The `iss` of every assertion; runners are configured with the same value. */
  readonly issuer: string
  /** The control-plane database: hosts, runners, credentials, keys, and the tenant directory. */
  readonly controlPlaneUrl: Redacted.Redacted<string>
  /** The edge's signing keys. Their public halves are published at startup. */
  readonly signingKeys: ReadonlyArray<SigningKey>
  readonly hostname: string
  readonly port: number
  /** How long an assertion lives, at most 60 seconds. Default 10 seconds. */
  readonly assertionLifetime: Duration.Duration
  /** How long a session opened with a hosted API key lasts before it must reauthenticate. */
  readonly apiKeySession: Duration.Duration
  /** How often hosts, runners, keys, and the directory's highest version are reread. */
  readonly pollEvery: Duration.Duration
  /**
   * How long a key must have been published before the edge signs with it:
   * at least the runners' key-set refresh interval, so every runner knows it.
   * Default 5 minutes, the runners' default refresh; a shorter lead suits only
   * local development, where a runner rereads its key set on an unknown kid.
   */
  readonly publicationLead: Duration.Duration
  /** The largest request body the edge forwards. Default 1 MiB. */
  readonly requestBytes: number
  /** The largest client WebSocket message the edge accepts, as runners do. Default 64 KiB. */
  readonly socketMessageBytes: number
  /**
   * The most client WebSocket bytes the edge holds for one socket before a
   * runner takes them; a client past it is closed. Default 1 MiB.
   */
  readonly socketBufferBytes: number
  /**
   * How long a request to a scale-to-zero deployment waits for a runner to be
   * started and to answer ready before it is refused. Default 30 seconds.
   */
  readonly coldStartTimeout: Duration.Duration
  /**
   * Whether `CF-Connecting-IP` is believed. It is only when `nlbOnly` says the
   * network admits the edge's traffic solely through an NLB that preserves
   * client addresses, and then only from a peer in Cloudflare's ranges;
   * otherwise the client is the TCP peer.
   */
  readonly trustedProxies: TrustedProxies
}

const decodeKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(SigningKey)))

/** Whether `lifetime` is a whole number of seconds from 1 to 60, as assertion claims need. */
export const isAssertionLifetime = (lifetime: Duration.Duration) => {
  const ms = Duration.toMillis(lifetime)

  return ms % 1000 === 0 && ms >= 1000 && ms <= 60_000
}

/**
 * The edge's configuration from its environment.
 *
 * Claims carry whole seconds, so a fractional lifetime would be floored, and
 * one under a second would sign assertions whose `exp` equals `iat`, which
 * runners refuse.
 */
export const loadOptions = Effect.gen(function* () {
  const lifetime = yield* Config.Duration("EDGE_ASSERTION_LIFETIME").pipe(
    Config.withDefault(Duration.seconds(10)),
  )

  if (!isAssertionLifetime(lifetime))
    return yield* Effect.die(
      new Error("EDGE_ASSERTION_LIFETIME is a whole number of seconds from 1 to 60"),
    )

  const keys = yield* Config.Redacted("EDGE_SIGNING_KEYS")

  const list = (name: string) =>
    Config.String(name).pipe(
      Config.withDefault(""),
      Config.map((value) =>
        value
          .split(",")
          .map((block) => block.trim())
          .filter((block) => block.length > 0),
      ),
    )

  const trustedProxies = {
    nlbOnly: yield* Config.Boolean("EDGE_NLB_ONLY").pipe(Config.withDefault(false)),
    cloudflare: yield* list("EDGE_CLOUDFLARE_RANGES"),
  } satisfies TrustedProxies

  yield* Effect.try(() => cidrs(trustedProxies.cloudflare)).pipe(Effect.orDie)

  if (trustedProxies.nlbOnly && trustedProxies.cloudflare.length === 0)
    return yield* Effect.die(new Error("EDGE_NLB_ONLY needs EDGE_CLOUDFLARE_RANGES"))

  return {
    issuer: yield* Config.String("EDGE_ISSUER"),
    controlPlaneUrl: yield* Config.Redacted("CONTROL_PLANE_DATABASE_URL"),
    signingKeys: yield* decodeKeys(Redacted.value(keys)).pipe(
      Effect.catch(() =>
        Effect.die(new Error("EDGE_SIGNING_KEYS must contain a valid private signing-key array")),
      ),
    ),
    hostname: yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
    port: yield* Config.Port("PORT").pipe(Config.withDefault(8080)),
    assertionLifetime: lifetime,
    apiKeySession: yield* Config.Duration("EDGE_API_KEY_SESSION").pipe(
      Config.withDefault(Duration.minutes(5)),
    ),
    pollEvery: Duration.seconds(5),
    publicationLead: yield* Config.Duration("EDGE_PUBLICATION_LEAD").pipe(
      Config.withDefault(Duration.minutes(5)),
    ),
    requestBytes: 1024 * 1024,
    socketMessageBytes: 64 * 1024,
    socketBufferBytes: 1024 * 1024,
    coldStartTimeout: yield* Config.Duration("EDGE_COLD_START_TIMEOUT").pipe(
      Config.withDefault(Duration.seconds(30)),
    ),
    trustedProxies,
  } satisfies EdgeOptions
})
