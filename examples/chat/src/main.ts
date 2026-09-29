/**
 * Chat over HTTP. Post with an Idempotency-Key minted from POST /command-ids and retry with the same key:
 *   curl -X POST localhost:3000/command-ids -H 'authorization: Bearer ada'
 *   curl -X POST localhost:3000/actors/Room/lobby/Post -H 'authorization: Bearer ada' \
 *     -H 'idempotency-key: <commandId>' -H 'content-type: application/json' -d '{"body":"hello"}'
 *   curl -X POST localhost:3000/actors/Room/lobby/History -H 'authorization: Bearer ada' \
 *     -H 'content-type: application/json' -d '{}'
 *   curl localhost:3000/openapi.json
 * Or, with the local inspector: durable dev --entry src/app.ts --tenant chat-demo
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { app } from "./app.ts"

const database = Layer.unwrap(
  Effect.map(Config.String("DATABASE_URL"), (url) =>
    Database.postgres({ url: Redacted.make(url) }),
  ),
)

HttpRouter.serve(app).pipe(
  Layer.provide(database),
  Layer.provide(BunCrypto.layer),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
