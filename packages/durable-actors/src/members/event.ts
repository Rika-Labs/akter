import { Schema } from "effect"
import type { ValueSchema } from "./command.ts"
import { declareChain, type PayloadOptions } from "./payload.ts"

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
 * `migrations` upcasts events stored at older versions when they are read;
 * stored events are never rewritten.
 */
const make =
  <Self = never>() =>
  <const Tag extends string, const Fields extends Schema.Struct.Fields>(
    tag: Tag,
    fields: Fields,
    options?: PayloadOptions,
  ) => {
    const declared = Schema.TaggedClass<Self>()(tag, fields)
    declareChain(declared as object, `Event ${tag}`, fields as never, options)

    return declared
  }

export const Event = { make }

/** Entries one `read.events` call returns when the reader names no `limit`. */
export const DEFAULT_REPLAY_LIMIT = 1_000

/** The largest page a reader may ask for; it bounds rows per page, not their bytes. */
export const MAX_REPLAY_LIMIT = 10_000
