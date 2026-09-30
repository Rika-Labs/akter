import { Anonymous, type Access } from "@durable-actors/core"
import { Schema } from "effect"

/** Every order of this demo belongs to one shop. */
export const TENANT = "shop"

/**
 * Customers signed in to the shop may use its orders and shipments; a visitor
 * without credentials may not. The identity provider issues only shop
 * callers, and the application's own code runs as `System`.
 */
export const shopper: Access = ({ caller }) => !Schema.is(Anonymous)(caller)
