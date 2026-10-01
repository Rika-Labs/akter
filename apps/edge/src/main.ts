import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { loadOptions } from "./config.ts"
import { EdgeLive } from "./server.ts"

/**
 * Hosted ingress: deployment hosts to runners, credentials to signed
 * assertions, proxied sockets.
 */
const program = Effect.gen(function* () {
  const options = yield* loadOptions

  return yield* Layer.launch(
    EdgeLive(options).pipe(
      Layer.provide(
        Layer.mergeAll(
          PgClient.layer({ url: options.controlPlaneUrl, maxConnections: 10 }),
          FetchHttpClient.layer,
          BunCrypto.layer,
        ),
      ),
    ),
  )
})

BunRuntime.runMain(program)
