import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { applicationLayer } from "./app.ts"
import { loadConfig } from "./config.ts"

const config = loadConfig()

HttpRouter.serve(applicationLayer(config), { disableLogger: true }).pipe(
  Layer.provide(
    BunHttpServer.layer({ port: config.port, hostname: "0.0.0.0", maxRequestBodySize: 1_048_576 }),
  ),
  Layer.launch,
  BunRuntime.runMain,
)
