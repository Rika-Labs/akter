import * as Alchemy from "alchemy"
import { AlchemyContext } from "alchemy/AlchemyContext"
import { provideFreshArtifactStore } from "alchemy/Artifacts"
import { layerNonInteractive } from "alchemy/Interaction"
import { evalStack } from "alchemy/Stack"
import { tryFindProviderByType } from "alchemy/Provider"
import { inMemoryState } from "alchemy/State"
import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Console, Effect, Layer, ManagedRuntime, Schema } from "effect"
import type { DeploymentRegion, DeploymentStage } from "./config.ts"
import { resources, stackProviders } from "./stack.ts"

export const previewLayer = Layer.mergeAll(
  BunServices.layer,
  layerNonInteractive(),
  inMemoryState(),
)

/** Compiles real declarations and providers with memory state; no planner or cloud lifecycle runs. */
export const preview = (options: {
  readonly stage: DeploymentStage
  readonly region: DeploymentRegion
}) => {
  const prefix = `AKTER_${options.stage.toUpperCase()}_${options.region.toUpperCase().replaceAll("-", "_")}`
  const accountId = { dev: "111111111111", staging: "222222222222", prod: "333333333333" }[
    options.stage
  ]
  const config = ConfigProvider.fromUnknown({
    AKTER_REGION: options.region,
    AKTER_DEV_ACCOUNT_ID: "111111111111",
    AKTER_STAGING_ACCOUNT_ID: "222222222222",
    AKTER_PROD_ACCOUNT_ID: "333333333333",
    AKTER_ORGANIZATION_ID: "o-placeholder",
    [`AKTER_${options.stage.toUpperCase()}_AWS_PROFILE`]: "akter-offline-nonexistent",
    [`${prefix}_ZONE`]: `${options.stage}-${options.region}.example.com`,
    [`${prefix}_CERTIFICATE_ARN`]: `arn:aws:acm:${options.region}:${accountId}:certificate/placeholder`,
    [`${prefix}_IMAGE_TAG`]: "placeholder",
    [`${prefix}_NEKI_CLUSTER_SIZE`]: "PS_10",
    [`${prefix}_NEKI_ROUTER_SIZE`]: "NKR_1",
    [`${prefix}_CUSTOM_HOSTNAMES`]: '["app.customer.example"]',
    AXIOM_TOKEN: "nonfunctional-offline-placeholder",
    AXIOM_URL: "http://127.0.0.1:1",
    AXIOM_NOTIFIER_ID: "placeholder",
    CLOUDFLARE_API_TOKEN: "nonfunctional-offline-placeholder",
    CLOUDFLARE_ACCOUNT_ID: "placeholder",
    PLANETSCALE_API_TOKEN_ID: "placeholder",
    PLANETSCALE_API_TOKEN: "nonfunctional-offline-placeholder",
    PLANETSCALE_ORGANIZATION: "placeholder",
    PLANETSCALE_API_BASE_URL: "http://127.0.0.1:1",
  })
  const stack = Alchemy.Stack(
    `akter-${options.region}`,
    { providers: stackProviders, state: inMemoryState() },
    resources,
  )
  return evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        for (const resource of Object.values(compiled.resources)) {
          if ((yield* tryFindProviderByType(resource.Type)) === undefined)
            return yield* Effect.die(new Error(`No provider registered for ${resource.Type}`))
        }
        return {
          deletionProtection: {
            nlb: compiled.resources.Nlb?.Props?.attributes?.["deletion_protection.enabled"],
            database: compiled.resources.Database?.Props?.deletionProtected,
          },
          stage: compiled.stage,
          name: compiled.name,
          resources: Object.entries(compiled.resources).map(([id, resource]) => ({
            id,
            type: resource.Type,
          })),
        }
      }),
    { stage: options.stage },
  ).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, config),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: ".cache/alchemy-preview",
      dev: false,
      adopt: false,
    }),
    provideFreshArtifactStore,
  )
}

if (import.meta.main) {
  const runtime = ManagedRuntime.make(previewLayer)
  await runtime
    .runPromise(
      Effect.gen(function* () {
        for (const stage of ["dev", "staging", "prod"] as const) {
          for (const region of ["us-east-1", "us-west-2"] as const) {
            const result = yield* preview({ stage, region })
            yield* Console.log(
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result),
            )
          }
        }
      }),
    )
    .finally(() => runtime.dispose())
}
