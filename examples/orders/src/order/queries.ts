import { Effect } from "effect"
import { Order, orderLines } from "./contract.ts"

/** Query handlers for `Order`. */
export const OrderReads = Order.toQueryLayer({
  Summary: Effect.fnUntraced(function* () {
    const read = yield* Order.Read
    const lines = yield* read.rows(orderLines).all({ orderBy: { sku: "asc" } })

    const { status, customerId, total, chargeId, shipments } = read.state

    return { status, customerId, total, chargeId, shipments, lines }
  }),
})
