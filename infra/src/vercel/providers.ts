import { Credentials, DEFAULT_API_BASE_URL } from "@distilled.cloud/vercel"
import * as Provider from "alchemy/Provider"
import { Config, Effect, Layer } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { DnsRecordProvider } from "./dns-record.ts"
import { Vercel } from "./resources.ts"

/**
 * The Vercel resources and what they need to call Vercel: a token from `VERCEL_TOKEN`,
 * resolved when the first request is made so building the layer needs no configuration,
 * and an HTTP client. Provide it on the stack next to the other providers.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Vercel") {}

const credentials = Layer.succeed(
  Credentials,
  Effect.gen(function* () {
    return {
      token: yield* Config.Redacted("VERCEL_TOKEN"),
      apiBaseUrl: yield* Config.String("VERCEL_API_URL").pipe(
        Config.withDefault(DEFAULT_API_BASE_URL),
      ),
    }
  }).pipe(Effect.orDie),
)

export const providers = Layer.effect(Providers, Provider.collection([Vercel.DnsRecord])).pipe(
  Layer.provide(DnsRecordProvider),
  Layer.provideMerge(credentials),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.orDie,
)
