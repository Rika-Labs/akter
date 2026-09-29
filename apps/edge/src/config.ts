import { Config, Duration, Effect, Redacted, Schema } from "effect"

/** One Ed25519 signing key from the edge's secret store, as a private JWK. */
export const SigningKey = Schema.Struct({
  kid: Schema.NonEmptyString,
  x: Schema.NonEmptyString,
  d: Schema.NonEmptyString,
})

export type SigningKey = typeof SigningKey.Type

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
   */
  readonly publicationLead: Duration.Duration
  /** The largest request body the edge forwards. Default 1 MiB. */
  readonly requestBytes: number
}

const decodeKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(SigningKey)))

/** Whether `lifetime` is a whole number of seconds from 1 to 60, as assertion claims need. */
export const isAssertionLifetime = (lifetime: Duration.Duration) => {
  const ms = Duration.toMillis(lifetime)

  return ms % 1000 === 0 && ms >= 1000 && ms <= 60_000
}

/** The edge's configuration from its environment. */
export const loadOptions = Effect.gen(function* () {
  const lifetime = yield* Config.Duration("EDGE_ASSERTION_LIFETIME").pipe(
    Config.withDefault(Duration.seconds(10)),
  )

  // Claims carry whole seconds, so a fractional lifetime would be floored, and one under a
  // second would sign assertions whose `exp` equals `iat`, which runners refuse.
  if (!isAssertionLifetime(lifetime))
    return yield* Effect.die(
      new Error("EDGE_ASSERTION_LIFETIME is a whole number of seconds from 1 to 60"),
    )

  const keys = yield* Config.Redacted("EDGE_SIGNING_KEYS")

  return {
    issuer: yield* Config.String("EDGE_ISSUER"),
    controlPlaneUrl: yield* Config.Redacted("CONTROL_PLANE_DATABASE_URL"),
    signingKeys: yield* decodeKeys(Redacted.value(keys)).pipe(Effect.orDie),
    hostname: yield* Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
    port: yield* Config.Port("PORT").pipe(Config.withDefault(8080)),
    assertionLifetime: lifetime,
    apiKeySession: yield* Config.Duration("EDGE_API_KEY_SESSION").pipe(
      Config.withDefault(Duration.minutes(5)),
    ),
    pollEvery: Duration.seconds(5),
    publicationLead: Duration.minutes(5),
    requestBytes: 1024 * 1024,
  } satisfies EdgeOptions
})
