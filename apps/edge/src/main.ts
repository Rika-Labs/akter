import { defaultPricingConfig, PricingConfigSchema, PricingLive } from "@akter/billing"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Database } from "@rikalabs/akter/runtime"
import { Config, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { loadOptions } from "./config.ts"
import { EdgeLive } from "./server.ts"

/**
 * Hosted ingress: deployment hosts to runners, credentials to signed
 * assertions, proxied sockets.
 */
const program = Effect.gen(function* () {
  const options = yield* loadOptions
  const pricing = yield* Config.schema(
    Schema.fromJsonString(PricingConfigSchema),
    "BILLING_PRICING_CONFIG",
  ).pipe(Config.withDefault(defaultPricingConfig))

  return yield* Layer.launch(
    EdgeLive(options).pipe(
      Layer.provide(
        Layer.mergeAll(
          PgClient.layer({ url: options.controlPlaneUrl, maxConnections: 10 }),
          Layer.succeed(Database.Neki, options.controlPlaneEngine === "neki"),
          FetchHttpClient.layer,
          BunCrypto.layer,
          PricingLive(pricing),
        ),
      ),
    ),
  )
})

BunRuntime.runMain(program)
