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
import { OrderEffects } from "./effects.ts"
import { OrderReads } from "./queries.ts"

export const OrderCommands = Order.toLayer(
  Effect.succeed({
    Place: Effect.fnUntraced(function* ({ customer, lines }) {
      const turn = yield* Order.Turn

      if (turn.state.status !== "new") return yield* OrderAlreadyPlaced.make({})

      const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
      yield* turn.rows(orderLines).insert(lines)

      // One shipment per package, minted in the order lines name them, so a
      // rerun of this command mints the same ids.
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
      yield* turn.perform(Charge.make({ customerId: customer.id, amount: total }))
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

    // A typed decline on the last attempt means nothing was charged, so the
    // shipments are cancelled. A crash or timeout leaves the outcome unknown:
    // the shipments stay pending for an operator to check with the provider.
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
  }),
)

/** Creates the owned table as a drizzle-kit migration would, then registers the order. */
export const OrderLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(orderLinesDdl)

    return Layer.mergeAll(OrderCommands, OrderReads, OrderEffects)
  }).pipe(Effect.orDie),
)
