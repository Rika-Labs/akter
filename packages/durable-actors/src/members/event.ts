import { Schema } from "effect"
import type { ValueSchema } from "./command.ts"

/**
 * A declared event class. Its schema identifier is its tag, which is stored
 * with each committed event so replay can filter and decode by class.
 */
export type EventClass = ValueSchema & {
  readonly identifier: string
  readonly Type: { readonly _tag: string }
}

/**
 * Declares a durable event: `class Posted extends Actor.Event<Posted>()("Posted", fields) {}`.
 * The identifier is fixed to the tag so a stored event names its class.
 */
const make = <Self = never>() => Schema.TaggedClass<Self>()

export const Event = { make }
