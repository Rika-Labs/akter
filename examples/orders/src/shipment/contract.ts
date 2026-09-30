import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"
import { shopper } from "../access.ts"

/** Where a shipment stands. */
export const ShipmentStatus = Schema.Literals(["pending", "ready", "cancelled"])

/** Shipment state: its order, package, SKUs and status. */
export const ShipmentState = Actor.state({
  order: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  package: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  skus: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  status: ShipmentStatus.pipe(Schema.withDecodingDefault(Effect.succeed("pending" as const))),
})

/**
 * Creates the shipment for a package. Internal: only the order's intents reach
 * `Open`, `Release` and `Cancel`, delivered by the relay.
 */
export const Open = Actor.command("Open", {
  payload: {
    order: Schema.String,
    package: Schema.String,
    skus: Schema.Array(Schema.String),
  },
})

/** Marks a pending shipment ready. */
export const Release = Actor.command("Release")

/** Marks a pending shipment cancelled. */
export const Cancel = Actor.command("Cancel")

/** The shipment's order, package, SKUs and status. */
export const Tracking = Actor.query("Tracking", {
  success: Schema.Struct({
    order: Schema.String,
    package: Schema.String,
    skus: Schema.Array(Schema.String),
    status: ShipmentStatus,
  }),
})

/**
 * One package of an order. It has no key: the order's `Place` turn mints its
 * id, and it comes into being only when the relay delivers that turn's
 * `Open` intent.
 */
export const Shipment = Actor.make("Shipment", {
  state: ShipmentState,
  access: shopper,
  api: { Tracking },
  internal: { Open, Release, Cancel },
  createdBy: Open,
})
