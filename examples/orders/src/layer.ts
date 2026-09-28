import { Layer } from "effect"
import { CatalogLive } from "./catalog/schema.ts"
import { OrderLive } from "./order/layer.ts"
import { ShipmentLive } from "./shipment/layer.ts"

/** The app's tables, then the actors; the order's executor needs a `Payments` layer. */
export const OrdersLive = Layer.mergeAll(OrderLive, ShipmentLive).pipe(
  Layer.provideMerge(CatalogLive),
)
