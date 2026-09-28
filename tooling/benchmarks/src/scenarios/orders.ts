import { BunCrypto } from "@effect/platform-bun"
import { Actors } from "@durable-actors/core/runtime"
import { TurnHooks } from "@durable-actors/core/testing"
import { OrdersLive } from "@durable-actors/orders/layer"
import { Order, OrderId } from "@durable-actors/orders/order"
import { fakeLedger } from "@durable-actors/orders/payments"
import { Deferred, Effect, Layer } from "effect"
import { load } from "../measure.ts"
import { type CaseResult, DEFAULT_POOL, measure, type Scenario } from "../scenario.ts"

const customer = { id: "ada", name: "Ada Lovelace", email: "ada@example.com" }

/** Two packages, so every order mints two shipments and stages their creating intents. */
const lines = [
  { sku: "kettle", name: "Kettle", quantity: 1, unitPrice: 3900, package: "bulky" },
  { sku: "mug", name: "Mug", quantity: 2, unitPrice: 1200, package: "small" },
]

/** Orders waiting for their `Charged` turn to commit, by order id. */
const waiting = new Map<string, Deferred.Deferred<void>>()

// The round trip ends when the charge's onSuccess turn commits, which only
// the runtime's post-commit hook observes.
const hooks = Layer.succeed(TurnHooks, {
  at: (point, request) =>
    point === "afterCommit" && request.command === "Charged"
      ? Effect.suspend(() => {
          const done = waiting.get(request.ref.id)

          return done === undefined ? Effect.void : Deferred.succeed(done, undefined)
        }).pipe(Effect.asVoid)
      : Effect.void,
})

const place = (id: string) =>
  Order.get(OrderId.make(id)).pipe(Effect.flatMap((order) => order.Place({ customer, lines })))

/** Places an order and waits until its payment has been charged and recorded. */
const placeAndCharge = (id: string) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>()
    waiting.set(id, done)
    yield* place(id)
    yield* Deferred.await(done)
  }).pipe(Effect.ensuring(Effect.sync(() => waiting.delete(id))))

/**
 * The orders example's `Place`: a turn that writes order lines, emits an
 * event, mints one shipment per package with its creating intent, and
 * performs a charge. `place` times the acknowledged turn; `place-to-paid`
 * adds the relay running the executor against an in-process provider and the
 * `Charged` turn committing; `place-concurrent-16` is 16 callers on 16 orders
 * at a time.
 */
export const orders: Scenario = {
  name: "orders",
  description:
    "examples/orders Place: the acknowledged turn (lines, event, two minted shipments, a charge), the round trip until the charge's Charged turn commits, and 16 concurrent callers.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      const cases = [
        { name: "place", workers: 1, operation: place },
        { name: "place-to-paid", workers: 1, operation: placeAndCharge },
        { name: "place-concurrent-16", workers: 16, operation: place },
      ]

      for (const { name, workers, operation } of cases)
        results.push(
          yield* Effect.scoped(
            Effect.gen(function* () {
              const database = yield* context.backend.database({ maxConnections: DEFAULT_POOL })

              const services = yield* Layer.build(
                OrdersLive.pipe(
                  Layer.provide(fakeLedger().layer),
                  Layer.provideMerge(
                    Actors.layer({ authorize: () => Effect.succeed(true) }).pipe(
                      Layer.provide(hooks),
                    ),
                  ),
                  Layer.provideMerge(database.layer),
                  Layer.provide(BunCrypto.layer),
                  Layer.orDie,
                ),
              )

              const body = Effect.gen(function* () {
                yield* load({
                  workers,
                  operations: 20,
                  operation: (index) => operation(`warm-${index}`),
                })

                return yield* measure({
                  name,
                  parameters: { workers, shipments: 2 },
                  instruments: database.instruments,
                  workers,
                  ...(workers === 1
                    ? { operations: quick ? 100 : 1000 }
                    : { durationMs: quick ? 2000 : 10_000 }),
                  operation: (index) => operation(`${name}-${index}`),
                  listStatements: workers === 1,
                })
              })

              return yield* body.pipe(Effect.provideContext(services))
            }),
          ),
        )

      return results
    }),
}
