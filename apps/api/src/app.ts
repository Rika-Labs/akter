import { Layer } from "effect"
import { BunHttpServer } from "@effect/platform-bun"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { Api } from "@durable-actors/contracts"
import { Auth, processRuntimeLayer } from "@durable-actors/accounts"
import { databaseLayer } from "@durable-actors/postgres"
import { captureLayer, resendLayer } from "@durable-actors/email"
import { disabledLayer, polarLayer } from "@durable-actors/billing"
import { observabilityLayer } from "@durable-actors/observability"
import { accountLive, authRoute } from "./account/handler.ts"
import { webhookRoute } from "./billing/handler.ts"
import type { Config } from "./config.ts"
import { HealthLive } from "./health.ts"

export const applicationLayer = (config: Config) => {
  const database = databaseLayer(config.databaseUrl)

  const email =
    config.emailMode === "capture"
      ? captureLayer(config.captureDirectory)
      : resendLayer({ apiKey: config.resendApiKey!, from: config.emailFrom! })

  const services = Layer.mergeAll(
    database,
    Auth.layer(config).pipe(Layer.provide(Layer.merge(database, email))),
    processRuntimeLayer,
    config.polar !== undefined ? polarLayer(config.polar) : disabledLayer,
  ).pipe(Layer.provideMerge(BunHttpServer.layerHttpServices))

  const api = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.merge(HealthLive, accountLive(config))),
  )

  return Layer.mergeAll(api, authRoute, webhookRoute(config)).pipe(
    HttpRouter.provideRequest(services),
    Layer.provide(services),
    Layer.provide(observabilityLayer(config.axiom)),
  )
}

export const makeHandler = (config: Config) =>
  HttpRouter.toWebHandler(applicationLayer(config), { disableLogger: true })
