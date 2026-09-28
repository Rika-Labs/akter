import { Actor } from "@durable-actors/core"
import { Effect, Schema } from "effect"

export const ShipmentStatus = Schema.Literals(["pending", "ready", "cancelled"])

export const ShipmentState = Actor.state({
  order: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  package: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  skus: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  status: ShipmentStatus.pipe(Schema.withDecodingDefault(Effect.succeed("pending" as const))),
})

// Internal: only the order's intents reach these, delivered by the relay.
export const Open = Actor.command("Open", {
  input: Schema.Struct({
    order: Schema.String,
    package: Schema.String,
    skus: Schema.Array(Schema.String),
  }),
})

export const Release = Actor.command("Release")

export const Cancel = Actor.command("Cancel")

export const Tracking = Actor.query("Tracking", {
  output: Schema.Struct({
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
  api: { Tracking },
  internal: { Open, Release, Cancel },
  policy: { createdBy: Open },
})
