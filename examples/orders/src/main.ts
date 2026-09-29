/**
 * The orders app over HTTP, on Postgres. The bearer token is the customer id (`ada` or `grace`).
 *   curl -X POST localhost:3000/command-ids -H 'authorization: Bearer ada'
 *   curl -X POST localhost:3000/orders/o-1 -H 'authorization: Bearer ada' \
 *     -H 'idempotency-key: <commandId>' -H 'content-type: application/json' \
 *     -d '{"items":[{"sku":"kettle","quantity":1},{"sku":"mug","quantity":2}]}'
 *   curl localhost:3000/orders/o-1 -H 'authorization: Bearer ada'
 *   curl -X POST localhost:3000/actors/Shipment/<shipmentId>/Tracking -H 'authorization: Bearer ada' \
 *     -H 'content-type: application/json' -d '{}'
 *   curl localhost:3000/reports/sales -H 'authorization: Bearer ada'
 */
import { BunCrypto, BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { Config, Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { OrdersLive } from "./layer.ts"
import { fakeLedger } from "./payments/ledger.ts"
import { routes } from "./server.ts"

/**
 * The orders runtime on Postgres with a fake payment provider in this process;
 * `Payments.http(url)` calls a real one.
 */
const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Config.String("DATABASE_URL")

    return OrdersLive.pipe(
      Layer.provide(fakeLedger().layer),
      Layer.provideMerge(Actors.layer()),
      Layer.provideMerge(Database.postgres({ url: Redacted.make(database) })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer))

HttpRouter.serve(routes).pipe(
  Layer.provide(runtime),
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.launch,
  BunRuntime.runMain,
)
