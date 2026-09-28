import { Effect } from "effect"
import { Shipment } from "./contract.ts"

export const ShipmentReads = Shipment.toQueryLayer(
  Effect.succeed({
    Tracking: Effect.fnUntraced(function* () {
      const { order, package: pkg, skus, status } = (yield* Shipment.Read).state

      return { order, package: pkg, skus, status }
    }),
  }),
)
