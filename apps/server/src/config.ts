import { Exit, Schema } from "effect"

const Required = Schema.String.check(Schema.isMinLength(1))

const Environment = Schema.Struct({
  NODE_ENV: Schema.optional(Schema.Literals(["development", "test", "production"])),
  DATABASE_URL: Required,
  APP_ORIGIN: Required,
  BETTER_AUTH_SECRET: Schema.String.check(Schema.isMinLength(32)),
  PORT: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
  EMAIL_MODE: Schema.Literals(["capture", "resend"]),
  EMAIL_CAPTURE_DIR: Schema.optional(Required),
  RESEND_API_KEY: Schema.optional(Required),
  EMAIL_FROM: Schema.optional(Required),
  POLAR_ACCESS_TOKEN: Schema.optional(Required),
  POLAR_WEBHOOK_SECRET: Schema.optional(Required),
  POLAR_PRODUCT_ID: Schema.optional(Required),
  POLAR_SANDBOX: Schema.optional(Schema.Literals(["true", "false"])),
  AXIOM_TOKEN: Schema.optional(Required),
  AXIOM_DATASET: Schema.optional(Required),
})

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  // Never include schema errors in startup logs: they may contain secret input.
  const decoded = Schema.decodeUnknownExit(Environment)(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")),
  )

  if (Exit.isFailure(decoded))
    throw new Error("Invalid API environment; check required configuration and formats")
  const value = decoded.value
  const production = value.NODE_ENV === "production"
  const originResult = Schema.decodeExit(Schema.URLFromString)(value.APP_ORIGIN)
  const databaseResult = Schema.decodeExit(Schema.URLFromString)(value.DATABASE_URL)

  if (Exit.isFailure(originResult) || Exit.isFailure(databaseResult))
    throw new Error("APP_ORIGIN and DATABASE_URL must be valid URLs")
  const origin = originResult.value
  const database = databaseResult.value

  if (
    origin.origin !== value.APP_ORIGIN ||
    !["http:", "https:"].includes(origin.protocol) ||
    (production && origin.protocol !== "https:")
  )
    throw new Error("APP_ORIGIN must be an origin (HTTPS in production)")

  if (!["postgres:", "postgresql:"].includes(database.protocol))
    throw new Error("DATABASE_URL must be PostgreSQL")

  if (production && value.EMAIL_MODE !== "resend")
    throw new Error("Production email requires Resend")

  if (
    value.EMAIL_MODE === "resend" &&
    (value.RESEND_API_KEY === undefined || value.EMAIL_FROM === undefined)
  )
    throw new Error("Resend requires RESEND_API_KEY and EMAIL_FROM")

  const billingValues = [
    value.POLAR_ACCESS_TOKEN,
    value.POLAR_WEBHOOK_SECRET,
    value.POLAR_PRODUCT_ID,
  ]

  if ((production || billingValues.some(Boolean)) && !billingValues.every(Boolean))
    throw new Error("Polar requires access token, product ID, and webhook secret")

  if (
    (production || value.AXIOM_TOKEN !== undefined || value.AXIOM_DATASET !== undefined) &&
    (value.AXIOM_TOKEN === undefined || value.AXIOM_DATASET === undefined)
  )
    throw new Error("Axiom requires token and dataset")

  return {
    databaseUrl: value.DATABASE_URL,
    origin: value.APP_ORIGIN,
    secret: value.BETTER_AUTH_SECRET,
    production,
    port: value.PORT ?? 3001,
    emailMode: value.EMAIL_MODE,
    captureDirectory: value.EMAIL_CAPTURE_DIR ?? `${import.meta.dirname}/../../../.amp/email`,
    resendApiKey: value.RESEND_API_KEY,
    emailFrom: value.EMAIL_FROM,
    polar:
      value.POLAR_ACCESS_TOKEN !== undefined &&
      value.POLAR_PRODUCT_ID !== undefined &&
      value.POLAR_WEBHOOK_SECRET !== undefined
        ? {
            accessToken: value.POLAR_ACCESS_TOKEN,
            productId: value.POLAR_PRODUCT_ID,
            webhookSecret: value.POLAR_WEBHOOK_SECRET,
            sandbox: value.POLAR_SANDBOX === "true",
            origin: value.APP_ORIGIN,
          }
        : undefined,
    axiom:
      value.AXIOM_TOKEN !== undefined && value.AXIOM_DATASET !== undefined
        ? { token: value.AXIOM_TOKEN, dataset: value.AXIOM_DATASET }
        : undefined,
  }
}

export type Config = ReturnType<typeof loadConfig>
