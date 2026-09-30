import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { OrdersLive } from "./layer.ts"
import { fakeLedger } from "./payments/ledger.ts"
import { routes } from "./server.ts"

const ledger = fakeLedger()

/**
 * The same cases run on PGlite (`test`) and on a fresh Postgres database
 * (`test:integration`).
 */
const database = Effect.gen(function* () {
  if ((yield* Config.String("ORDERS_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `orders_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return OrdersLive.pipe(
      Layer.provide(ledger.layer),
      Layer.provideMerge(ActorTest.layer({ database: yield* database })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

const web = HttpRouter.toWebHandler(
  routes.pipe(
    Layer.provide(Layer.effectContext(runtime.contextEffect)),
    Layer.provide(BunCrypto.layer),
  ),
  { disableLogger: true },
)

afterAll(() => web.dispose().then(() => runtime.dispose()))

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

const Json = Schema.fromJsonString(Schema.Unknown)

interface Sent {
  readonly status: number
  readonly text: string
  readonly body: unknown
}

/** Sends one request as `user` and returns its status and decoded JSON body. */
const send = Effect.fnUntraced(function* (
  method: string,
  path: string,
  options: { readonly user?: string; readonly key?: string; readonly body?: unknown } = {},
) {
  const context = yield* Effect.context<Layer.Success<typeof live>>()
  const headers = new Headers()

  if (options.user !== undefined) headers.set("authorization", `Bearer ${options.user}`)

  if (options.key !== undefined) headers.set("idempotency-key", options.key)

  if (options.body !== undefined) headers.set("content-type", "application/json")

  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : yield* Schema.encodeEffect(Json)(options.body),
  })

  const response = yield* Effect.promise(() => web.handler(request, context))
  const text = yield* Effect.promise(() => response.text())
  const body = text === "" ? null : yield* Schema.decodeEffect(Json)(text)
  const sent: Sent = { status: response.status, text, body }

  return sent
}, Effect.orDie)

const commandId = send("POST", "/command-ids", { user: "ada" }).pipe(
  Effect.map(({ body }) => (body as { readonly commandId: string }).commandId),
)

const order = {
  items: [
    { sku: "kettle", quantity: 1 },
    { sku: "mug", quantity: 2 },
  ],
}

/** Advances the relay until the order has settled its payment. */
const paid = Effect.fnUntraced(function* (path: string) {
  const test = yield* ActorTest

  for (let round = 0; round < 30; round++) {
    yield* test.advance("1 second")
    const { body } = yield* send("GET", path, { user: "ada" })

    if ((body as { readonly status: string }).status === "paid") return body
  }

  return yield* Effect.die(new Error(`${path} was not paid`))
})

it("serves the OpenAPI document recorded in the snapshot, without the order's Place", () =>
  run(
    Effect.gen(function* () {
      const { status, text, body } = yield* send("GET", "/openapi.json")

      expect(status).toBe(200)
      expect(Object.keys((body as { readonly paths: object }).paths)).not.toContain(
        "/actors/Order/{id}/Place",
      )
      yield* Effect.promise(() =>
        expect(text).toMatchFileSnapshot("./__snapshots__/openapi.json.snap"),
      )
    }),
  ))

it("places an order over HTTP from the app's catalog and replays a retry with the same key", () =>
  run(
    Effect.gen(function* () {
      const key = yield* commandId
      const placed = yield* send("POST", "/orders/http-1", { user: "ada", key, body: order })

      expect(placed).toMatchObject({
        status: 200,
        body: { orderId: "http-1", total: 3900 + 2 * 1200 },
      })

      const shipments = (placed.body as { readonly shipments: ReadonlyArray<string> }).shipments
      expect(shipments).toHaveLength(2)
      expect(yield* send("POST", "/orders/http-1", { user: "ada", key, body: order })).toEqual(
        placed,
      )

      expect(yield* paid("/orders/http-1")).toMatchObject({
        status: "paid",
        customerId: "ada",
        lines: [
          { sku: "kettle", name: "Kettle", quantity: 1, unitPrice: 3900, package: "bulky" },
          { sku: "mug", name: "Mug", quantity: 2, unitPrice: 1200, package: "small" },
        ],
      })
      expect(
        yield* send("POST", `/actors/Shipment/${shipments[1]}/Tracking`, { user: "ada" }),
      ).toMatchObject({
        status: 200,
        body: { order: "http-1", package: "small", skus: ["mug"], status: "ready" },
      })
      expect(yield* send("GET", "/orders/http-1", { user: "grace" })).toMatchObject({
        status: 404,
      })
    }),
  ))

it("refuses a retry whose catalog read changed under the same key", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const key = yield* commandId
      const body = { items: [{ sku: "tea", quantity: 1 }] }

      expect(yield* send("POST", "/orders/http-2", { user: "ada", key, body })).toMatchObject({
        status: 200,
        body: { total: 850 },
      })

      yield* sql`UPDATE products SET unit_price = 900 WHERE sku = 'tea'`
      expect(yield* send("POST", "/orders/http-2", { user: "ada", key, body })).toMatchObject({
        status: 409,
        body: { error: "CommandConflict" },
      })
      yield* sql`UPDATE products SET unit_price = 850 WHERE sku = 'tea'`
    }),
  ))

it("answers bad requests before any turn runs", () =>
  run(
    Effect.gen(function* () {
      const key = yield* commandId

      expect(yield* send("POST", "/orders/http-3", { body: order })).toMatchObject({ status: 401 })
      expect(yield* send("POST", "/orders/http-3", { user: "ada", body: order })).toMatchObject({
        status: 400,
        body: { error: "MissingIdempotencyKey" },
      })
      expect(
        yield* send("POST", "/orders/http-3", {
          user: "ada",
          key,
          body: { items: [{ sku: "unicorn", quantity: 1 }] },
        }),
      ).toMatchObject({ status: 422, body: { error: "UnknownProducts", skus: ["unicorn"] } })
      expect(
        yield* send("POST", "/orders/http-3", { user: "nobody", key, body: order }),
      ).toMatchObject({ status: 422, body: { error: "UnknownCustomer" } })
      expect(
        yield* send("POST", "/actors/Order/http-3/Place", { user: "ada", key, body: {} }),
      ).toMatchObject({ status: 404 })
      expect(yield* send("GET", "/orders/http-3", { user: "ada" })).toMatchObject({ status: 404 })
    }),
  ))

it("reports sales across orders with plain SQL outside any turn", () =>
  run(
    Effect.gen(function* () {
      yield* send("POST", "/orders/http-4", {
        user: "grace",
        key: yield* commandId,
        body: { items: [{ sku: "mug", quantity: 5 }] },
      })

      const { status, body } = yield* send("GET", "/reports/sales", { user: "ada" })
      const mug = (body as ReadonlyArray<{ readonly sku: string }>).find(({ sku }) => sku === "mug")

      expect(status).toBe(200)
      expect(mug).toEqual({ sku: "mug", name: "Mug", orders: 2, quantity: 7, revenue: 7 * 1200 })
    }),
  ))
