import { BunCrypto, BunHttpServer, BunServices } from "@effect/platform-bun"
import { Cause, Console, Effect, Exit, Layer } from "effect"
import { server } from "./server.ts"

const exit = await Effect.runPromiseExit(
  server.pipe(
    Effect.provide(
      Layer.mergeAll(BunCrypto.layer, BunServices.layer, BunHttpServer.layer({ port: 8080 })),
    ),
  ),
)
if (Exit.isFailure(exit)) {
  await Effect.runPromise(Console.error(Cause.pretty(exit.cause)))
  process.exitCode = 1
}
