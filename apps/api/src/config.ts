import { Config, Effect, Redacted } from "effect"

export interface ApiOptions {
  readonly databaseUrl: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
  readonly origin: string
  readonly consoleOrigin?: string
  readonly trustedIdpOrigins?: ReadonlyArray<string>
  readonly port: number
  readonly hostname?: string
  readonly production: boolean
  readonly emailMode: "local" | "ses"
  readonly emailFrom: string
  readonly github?: { readonly clientId: string; readonly clientSecret: string }
  readonly google?: { readonly clientId: string; readonly clientSecret: string }
  readonly enterpriseOrganizations?: ReadonlyArray<string>
}

export const loadOptions = Effect.gen(function* () {
  const databaseUrl = yield* Config.Redacted("CONTROL_PLANE_DATABASE_URL")
  const secret = yield* Config.Redacted("AUTH_SECRET")
  const origin = yield* Config.String("API_ORIGIN").pipe(
    Config.withDefault("http://localhost:3001"),
  )
  const consoleOrigin = yield* Config.String("CONSOLE_ORIGIN").pipe(
    Config.withDefault("http://localhost:5173"),
  )
  const trustedIdpOrigins = yield* Config.String("AUTH_TRUSTED_IDP_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  )
  const port = yield* Config.Int("API_PORT").pipe(Config.withDefault(3001))
  const hostname = yield* Config.String("API_HOST").pipe(Config.withDefault("127.0.0.1"))
  const production = yield* Config.Boolean("API_PRODUCTION").pipe(Config.withDefault(false))
  const emailMode = yield* Config.Literals(["local", "ses"], "EMAIL_MODE").pipe(
    Config.withDefault("local"),
  )
  const emailFrom = yield* Config.String("EMAIL_FROM").pipe(
    Config.withDefault("Akter <auth@localhost>"),
  )
  const githubId = yield* Config.String("GITHUB_CLIENT_ID").pipe(Config.withDefault(""))
  const githubSecret = yield* Config.Redacted("GITHUB_CLIENT_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  )
  const googleId = yield* Config.String("GOOGLE_CLIENT_ID").pipe(Config.withDefault(""))
  const googleSecret = yield* Config.Redacted("GOOGLE_CLIENT_SECRET").pipe(
    Config.withDefault(Redacted.make("")),
  )
  const enterpriseOrganizations = yield* Config.String("ENTERPRISE_ORGANIZATIONS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  )
  if (Redacted.value(secret).length < 32)
    return yield* Effect.die(new Error("AUTH_SECRET must contain at least 32 characters"))
  if (production && emailMode === "local")
    return yield* Effect.die(new Error("Production requires SES email delivery"))
  return {
    databaseUrl,
    secret,
    origin,
    consoleOrigin,
    trustedIdpOrigins,
    port,
    hostname,
    production,
    emailMode,
    emailFrom,
    enterpriseOrganizations,
    github:
      githubId === ""
        ? undefined
        : { clientId: githubId, clientSecret: Redacted.value(githubSecret) },
    google:
      googleId === ""
        ? undefined
        : { clientId: googleId, clientSecret: Redacted.value(googleSecret) },
  } satisfies ApiOptions
})
