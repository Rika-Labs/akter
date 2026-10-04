import { Config, Effect, Option, Redacted, Schema } from "effect"
import { defaultPricingConfig, PricingConfigSchema, type PricingConfig } from "@akter/billing"
import type { MeterCell } from "./collector.ts"
import type { EcsOptions } from "@akter/deployments/runners"

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
  readonly billingMode?: "local" | "stripe"
  readonly stripeApiKey?: Redacted.Redacted<string>
  readonly billingWebhookSecret?: Redacted.Redacted<string>
  readonly pricing?: PricingConfig
  readonly meterCells?: ReadonlyArray<MeterCell>
  readonly paidOrganizations?: ReadonlyArray<string>
  readonly runnerEnvironment?: Readonly<Record<string, string>>
  readonly deploymentDomain?: string
  readonly edgeOrigin?: string
  readonly runnerPort?: number
  readonly runnerNetwork?: string
  readonly runnerRouteViaNetwork?: boolean
  readonly migrationCommand?: ReadonlyArray<string>
  readonly runnerIdleSeconds?: number
  readonly runnerEcs?: EcsOptions
  readonly runtimeRequestTimeoutSeconds?: number
}

export const localBillingWebhookSecret = "local-billing-signature-secret-not-for-production"

/** The signing secret that ships in the local Compose file and is public in the repository. */
const publishedDevelopmentSecret = "local-development-only-change-before-production"

const isPublicHttpsOrigin = (value: string) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return (
    url.protocol === "https:" &&
    url.hostname !== "localhost" &&
    !url.hostname.endsWith(".localhost") &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  )
}

export const loadOptions = Effect.gen(function* () {
  const databaseUrl = yield* Config.Redacted("CONTROL_PLANE_DATABASE_URL")
  const secret = yield* Config.Redacted("AUTH_SECRET")
  const origin = yield* Config.String("API_ORIGIN").pipe(
    Config.withDefault("http://localhost:3001"),
  )
  const consoleOrigin = yield* Config.String("CONSOLE_ORIGIN").pipe(Config.option)
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
    Config.withDefault(production ? "Akter <auth@akter.dev>" : "Akter <auth@localhost>"),
  )
  const billingMode = yield* Config.Literals(["local", "stripe"], "BILLING_MODE").pipe(
    Config.withDefault("local"),
  )
  const stripeApiKey = yield* Config.Redacted("STRIPE_API_KEY").pipe(Config.option)
  const billingWebhookSecret = yield* Config.Redacted("STRIPE_WEBHOOK_SECRET").pipe(
    Config.withDefault(Redacted.make(localBillingWebhookSecret)),
  )
  const meterCells = yield* Config.Redacted("METER_CELLS").pipe(Config.option)
  const pricing = yield* Config.schema(
    Schema.fromJsonString(PricingConfigSchema),
    "BILLING_PRICING_CONFIG",
  ).pipe(Config.withDefault(defaultPricingConfig))
  const cells = Option.isNone(meterCells)
    ? []
    : yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              deploymentId: Schema.NonEmptyString,
              databaseUrl: Schema.NonEmptyString,
            }),
          ),
        ),
      )(Redacted.value(meterCells.value)).pipe(
        Effect.catch(() =>
          Effect.die(
            new Error("METER_CELLS must be an array of deploymentId and databaseUrl records"),
          ),
        ),
      )
  if (production && billingMode === "local")
    return yield* Effect.die(new Error("Production requires Stripe billing"))
  if (billingMode === "stripe" && Option.isNone(stripeApiKey))
    return yield* Effect.die(new Error("Stripe billing requires STRIPE_API_KEY"))
  if (
    billingMode === "stripe" &&
    Redacted.value(billingWebhookSecret) === localBillingWebhookSecret
  )
    return yield* Effect.die(new Error("Stripe billing requires an explicit webhook secret"))
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
  const paidOrganizations = yield* Config.String("PAID_ORGANIZATIONS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  )
  const environment = yield* Config.Redacted("RUNNER_ENVIRONMENT").pipe(
    Config.withDefault(Redacted.make("{}")),
  )
  const runnerEnvironment = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  )(Redacted.value(environment)).pipe(
    Effect.catch(() =>
      Effect.die(new Error("RUNNER_ENVIRONMENT must be a string-valued JSON object")),
    ),
  )
  const ecs = yield* Config.String("RUNNER_ECS_CONFIG").pipe(Config.option)
  const runnerEcs = Option.isNone(ecs)
    ? undefined
    : yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            regions: Schema.Record(
              Schema.String,
              Schema.Struct({
                cluster: Schema.String,
                subnets: Schema.Array(Schema.String),
                securityGroups: Schema.Array(Schema.String),
              }),
            ),
            container: Schema.String,
            port: Schema.Int,
            scheme: Schema.optional(Schema.Literals(["http", "https"])),
            definition: Schema.Struct({
              executionRoleArn: Schema.String,
              taskRoleArn: Schema.optional(Schema.String),
              cpu: Schema.optional(Schema.String),
              memory: Schema.optional(Schema.String),
            }),
          }),
        ),
      )(ecs.value).pipe(Effect.catch(() => Effect.die(new Error("RUNNER_ECS_CONFIG is invalid"))))
  const migrationCommand = yield* Config.String("RUNNER_MIGRATION_COMMAND").pipe(
    Config.withDefault('["bun","run","migrate"]'),
  )
  const parsedMigrationCommand = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.String).check(Schema.isMinLength(1))),
  )(migrationCommand).pipe(
    Effect.catch(() =>
      Effect.die(new Error("RUNNER_MIGRATION_COMMAND must be a nonempty JSON array")),
    ),
  )
  if (Redacted.value(secret).length < 32)
    return yield* Effect.die(new Error("AUTH_SECRET must contain at least 32 characters"))
  if (production && emailMode === "local")
    return yield* Effect.die(new Error("Production requires SES email delivery"))
  if (production && Object.keys(runnerEnvironment).length > 0)
    return yield* Effect.die(new Error("Production cannot use shared runner environment values"))
  if (production && Redacted.value(secret) === publishedDevelopmentSecret)
    return yield* Effect.die(new Error("Production cannot use the published development secret"))
  if (
    production &&
    ![origin, ...Option.toArray(consoleOrigin), ...trustedIdpOrigins].every(isPublicHttpsOrigin)
  )
    return yield* Effect.die(
      new Error("Production requires explicit public https API, console and IdP origins"),
    )
  return {
    databaseUrl,
    secret,
    origin,
    consoleOrigin: Option.getOrUndefined(consoleOrigin),
    trustedIdpOrigins,
    port,
    hostname,
    production,
    emailMode,
    emailFrom,
    billingMode,
    stripeApiKey: Option.getOrUndefined(stripeApiKey),
    billingWebhookSecret,
    pricing,
    meterCells: cells.map((cell) => ({
      deploymentId: cell.deploymentId,
      databaseUrl: Redacted.make(cell.databaseUrl),
    })),
    enterpriseOrganizations,
    paidOrganizations,
    runnerEnvironment,
    runnerEcs,
    migrationCommand: parsedMigrationCommand,
    edgeOrigin: yield* Config.String("EDGE_ORIGIN").pipe(
      Config.withDefault("http://127.0.0.1:3002"),
    ),
    deploymentDomain: yield* Config.String("DEPLOYMENT_DOMAIN").pipe(
      Config.withDefault("localhost"),
    ),
    runnerPort: yield* Config.Port("RUNNER_PORT").pipe(Config.withDefault(8080)),
    runnerNetwork: Option.getOrUndefined(
      yield* Config.String("RUNNER_DOCKER_NETWORK").pipe(Config.option),
    ),
    runnerRouteViaNetwork: yield* Config.Boolean("RUNNER_ROUTE_VIA_NETWORK").pipe(
      Config.withDefault(false),
    ),
    runnerIdleSeconds: yield* Config.schema(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "RUNNER_IDLE_SECONDS",
    ).pipe(Config.withDefault(300)),
    runtimeRequestTimeoutSeconds: yield* Config.schema(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "RUNTIME_REQUEST_TIMEOUT_SECONDS",
    ).pipe(Config.withDefault(35)),
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
