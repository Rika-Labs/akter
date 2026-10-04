import {
  defaultPricingConfig,
  PricingConfigSchema,
  StripeBilling,
  StripeBillingDistilled,
  StripeBillingLocal,
  stripeTiers,
} from "@akter/billing"
import * as Stripe from "@distilled.cloud/stripe"
import { BunCrypto } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Config, Console, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { UsageError, fail } from "../../failure.ts"

const flags = {
  mode: Flag.Literals("mode", ["local", "stripe"]).pipe(Flag.withDefault("local")),
  databaseUrl: Flag.Redacted("database-url").pipe(Flag.optional),
}

/** Idempotent catalog setup; local mode never needs a provider credential. */
export const setupCatalog = StripeBilling.use((billing) => billing.ensureCatalog)

export const billingSetupCommand = Command.make("setup", flags, (options) =>
  Effect.gen(function* () {
    const pricing = yield* Config.schema(
      Schema.fromJsonString(PricingConfigSchema),
      "BILLING_PRICING_CONFIG",
    ).pipe(Config.withDefault(defaultPricingConfig))
    const config = {
      tiers: stripeTiers(pricing),
      webhookSecret: Redacted.make("catalog-setup-does-not-verify-webhooks"),
    }
    if (options.mode === "local" && Option.isNone(options.databaseUrl))
      return yield* UsageError.make({ message: "Local billing setup requires --database-url" })
    const provider =
      options.mode === "local"
        ? StripeBillingLocal(config).pipe(
            Layer.provide(PgClient.layer({ url: Option.getOrThrow(options.databaseUrl) })),
          )
        : StripeBillingDistilled(config).pipe(
            Layer.provide(
              Stripe.credentials({
                apiKey: Redacted.value(yield* Config.Redacted("STRIPE_API_KEY")),
              }),
            ),
            Layer.provide(FetchHttpClient.layer),
          )
    const context = yield* Layer.build(provider.pipe(Layer.provide(BunCrypto.layer)))
    const catalog = yield* setupCatalog.pipe(Effect.provideContext(context))
    yield* Console.log(`Configured ${catalog.tiers.length} provisional paid tiers`)
  }).pipe(
    Effect.scoped,
    Effect.catchTags({
      UsageError: (error) => fail({ reason: error._tag, message: error.message }),
      BillingProviderError: (error) =>
        fail({ reason: error._tag, message: "Billing catalog setup was refused" }),
    }),
  ),
).pipe(
  Command.withDescription(
    "Create or reconcile the provisional Stripe billing catalog; defaults to the local SQL provider",
  ),
)
