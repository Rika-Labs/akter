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

/** The class `Actor.event` returns for tag `Tag` and fields `Fields`. */
export type EventOf<Tag extends string, Fields extends Schema.Struct.Fields> = Schema.Class<
  Schema.TaggedStruct<Tag, Fields>["Type"],
  Schema.TaggedStruct<Tag, Fields>,
  {}
>

/**
 * `EventMember.make` is `Actor.event`: declares a durable event class. Its schema identifier is
 * fixed to the tag, so a stored event names its class. `migrations` upcasts
 * events stored at older versions when they are read; stored events are never
 * rewritten. An invalid migration chain throws when the class is built. The
 * value is itself the class: `Posted.make(...)`, `new Posted(...)`, and
 * `instanceof` all work.
 *
 * @example
 * const Posted = Actor.event("Posted", { text: Schema.String })
 */
const make = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  fields: Fields,
  options?: PayloadOptions,
): EventOf<Tag, Fields> => {
  const declared: EventOf<Tag, Fields> = Schema.TaggedClass<
    Schema.TaggedStruct<Tag, Fields>["Type"]
  >()(tag, fields) as never

  declareChain({ schema: declared, label: `Event ${tag}`, fields: fields as never, options })

  return declared
}

/** `Actor.event`; see `make`. */
export const EventMember = { make }

/** Entries one `read.events` call returns when the reader names no `limit`. */
export const DEFAULT_REPLAY_LIMIT = 1_000

/** The largest page a reader may ask for; it bounds rows per page, not their bytes. */
export const MAX_REPLAY_LIMIT = 10_000
