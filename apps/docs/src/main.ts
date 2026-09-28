import { BunServices } from "@effect/platform-bun"
import { Config, Effect, ManagedRuntime, Path } from "effect"

import { staticSiteHandler } from "./server.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

await runtime.runPromise(
  Effect.gen(function* () {
    const path = yield* Path.Path

    const port = yield* Config.Port("PORT").pipe(Config.withDefault(3002))

    const fetch = yield* staticSiteHandler(path.join(import.meta.dirname, "../dist"))

    const server = Bun.serve({ hostname: "0.0.0.0", port, fetch })

    yield* Effect.log(`Docs site listening on port ${server.port}; build it first.`)
  }),
)
