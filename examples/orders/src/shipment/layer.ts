import { Effect, Layer } from "effect"
import { Shipment } from "./contract.ts"
import { ShipmentReads } from "./queries.ts"

const moveTo = Effect.fnUntraced(function* (status: "ready" | "cancelled") {
  const { state } = yield* Shipment.Turn
  yield* state.set({ order: state.order, package: state.package, skus: state.skus, status })
})

/**
 * Intents have no delivery order, so a Release can reach a shipment only after
 * its Open: before that the child does not exist and the relay retries.
 */
export const ShipmentCommands = Shipment.toLayer({
  Open: Effect.fnUntraced(function* ({ order, package: pkg, skus }) {
    yield* (yield* Shipment.Turn).state.set({ order, package: pkg, skus, status: "pending" })
  }),

  Release: Effect.fnUntraced(function* () {
    const turn = yield* Shipment.Turn

    if (turn.state.status === "pending") yield* moveTo("ready")
  }),

  Cancel: Effect.fnUntraced(function* () {
    const turn = yield* Shipment.Turn

    if (turn.state.status === "pending") yield* moveTo("cancelled")
  }),
})

/** Every handler of `Shipment`. */
export const ShipmentLive = Layer.mergeAll(ShipmentCommands, ShipmentReads)
