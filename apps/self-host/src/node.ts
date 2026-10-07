import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Cause, Console, Effect, Exit, Layer } from "effect"
import { createServer } from "node:http"
import { server } from "./server.ts"

const exit = await Effect.runPromiseExit(
  server.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        NodeServices.layer,
        NodeHttpServer.layer(createServer, { port: 8080 }),
      ),
    ),
  ),
)
if (Exit.isFailure(exit)) {
  await Effect.runPromise(Console.error(Cause.pretty(exit.cause)))
  process.exitCode = 1
}
