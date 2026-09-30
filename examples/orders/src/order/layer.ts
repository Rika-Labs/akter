import { Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Shipment } from "../shipment/contract.ts"
import {
  Charge,
  Order,
  OrderAlreadyPlaced,
  OrderPlaced,
  orderLines,
  orderLinesDdl,
  PaymentCaptured,
  PaymentFailed,
} from "./contract.ts"
import { OrderJobs } from "./jobs.ts"
import { OrderReads } from "./queries.ts"

/**
 * Order command handlers.
 *
 * `Place` mints one shipment per package, named by the order lines, so a rerun
 * of the command mints the same ids. `ChargeFailed` cancels the shipments only
 * for a typed decline on the last attempt, which means nothing was charged; a
 * crash or timeout leaves the outcome unknown, so the shipments stay pending
 * for an operator to check with the provider.
 */
export const OrderCommands = Order.toLayer({
  Place: Effect.fnUntraced(function* ({ customer, lines }) {
    const turn = yield* Order.Turn

    if (turn.state.status !== "new") return yield* OrderAlreadyPlaced.make({})

    const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
    yield* turn.rows(orderLines).insert(lines)

    const packages = new Map<string, Array<string>>()

    for (const { sku, package: pkg } of lines)
      packages.set(pkg, [...(packages.get(pkg) ?? []), sku])

    const shipments: Array<string> = []

    for (const [pkg, skus] of packages) {
      const id = yield* turn.mint(Shipment)
      yield* (yield* Shipment.intents(id)).Open({ order: turn.id, package: pkg, skus })
      shipments.push(id)
    }

    yield* turn.emit(OrderPlaced.make({ customerId: customer.id, total, shipments }))
    yield* turn.enqueue(Charge.make({ customerId: customer.id, amount: total }))
    yield* turn.state.set({
      status: "awaiting_payment",
      customerId: customer.id,
      total,
      shipments,
    })

    return { total, shipments }
  }),

  Charged: Effect.fnUntraced(function* ({ chargeId }) {
    const turn = yield* Order.Turn
    const { customerId, total, shipments } = turn.state
    yield* turn.state.set({ status: "paid", customerId, total, shipments, chargeId })
    yield* turn.emit(PaymentCaptured.make({ chargeId }))

    for (const id of turn.state.shipments) yield* (yield* Shipment.intents(id)).Release()
  }),

  ChargeFailed: Effect.fnUntraced(function* ({ ambiguous }) {
    const turn = yield* Order.Turn
    const { customerId, total, shipments } = turn.state
    yield* turn.state.set({
      status: ambiguous ? "payment_unknown" : "payment_failed",
      customerId,
      total,
      shipments,
    })
    yield* turn.emit(PaymentFailed.make({ ambiguous }))

    if (!ambiguous)
      for (const id of turn.state.shipments) yield* (yield* Shipment.intents(id)).Cancel()
  }),
})

/** Creates the owned table as a drizzle-kit migration would, then registers the order. */
export const OrderLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(orderLinesDdl)

    return Layer.mergeAll(OrderCommands, OrderReads, OrderJobs)
  }).pipe(Effect.orDie),
)
