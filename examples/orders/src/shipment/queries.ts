import { Effect } from "effect"
import { Shipment } from "./contract.ts"

/** Query handlers for `Shipment`. */
export const ShipmentReads = Shipment.toQueryLayer({
  Tracking: Effect.fnUntraced(function* () {
    const { order, package: pkg, skus, status } = (yield* Shipment.Read).state

    return { order, package: pkg, skus, status }
  }),
})
