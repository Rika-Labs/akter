import type { Schema } from "effect"
import { type DeclaredError, member, type Member, type ValueSchema } from "./command.ts"
import type { ProgressEffect } from "./effect.ts"

/**
 * A live, read-only feed that runs on the actor's activation for one
 * subscriber. `input` is the subscription's input and `output` the schema of
 * each element; nothing it emits is stored.
 */
export interface Stream<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> extends Member<"stream", Tag, Input, Output, Errors> {
  /** Effects whose executor progress its handler may read with `read.progress`. */
  readonly progress: { readonly effects: ReadonlyArray<ProgressEffect> } | undefined
}

/** Any stream member, whatever its schemas. */
export type AnyStream = Stream<string, ValueSchema, ValueSchema, ReadonlyArray<DeclaredError>>

const make = <
  const Tag extends string,
  Output extends ValueSchema,
  Input extends ValueSchema = typeof Schema.Void,
  const Errors extends ReadonlyArray<DeclaredError> = readonly [],
>(
  tag: Tag,
  options: {
    readonly output: Output
    readonly input?: Input
    readonly errors?: Errors
    readonly progress?: { readonly effects: ReadonlyArray<ProgressEffect> }
  },
): Stream<Tag, Input, Output, Errors> => ({
  ...member("stream")(tag, options),
  progress: options.progress,
})

/**
 * `StreamMember.make` is `Actor.stream`: declares a live, read-only feed by
 * tag. `output` types each element; `input` defaults to `void`, and `progress`
 * lists the effects whose executor progress the handler may follow.
 *
 * @example
 * const Ticks = Actor.stream("Ticks", { output: Schema.Int })
 */
export const StreamMember = { make }
