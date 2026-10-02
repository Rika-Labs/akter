import type { Schema } from "effect"
import {
  type DeclaredError,
  member,
  type Member,
  type PayloadOf,
  type PayloadOption,
  type ValueSchema,
} from "./command.ts"
import type { ProgressJob } from "./job.ts"

/**
 * A live, read-only feed that runs on the actor's activation for one
 * subscriber. `payload` is the subscription's input and `success` the schema
 * of each element; nothing it emits is stored.
 */
export interface Stream<
  Tag extends string,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
> extends Member<"stream", Tag, Payload, Success, Error> {
  /** Jobs whose executor progress its handler may read with `read.progress`. */
  readonly progress: { readonly jobs: ReadonlyArray<ProgressJob> } | undefined
}

/** Any stream member, whatever its schemas. */
export type AnyStream = Stream<string, ValueSchema, ValueSchema, DeclaredError>

const make = <
  const Tag extends string,
  Success extends ValueSchema,
  const P extends PayloadOption = Schema.Void,
  Error extends DeclaredError = Schema.Never,
>(
  tag: Tag,
  options: {
    readonly success: Success
    readonly payload?: P
    readonly error?: Error
    readonly progress?: { readonly jobs: ReadonlyArray<ProgressJob> }
  },
): Stream<Tag, PayloadOf<P>, Success, Error> => ({
  ...member("stream")(tag, options),
  progress: options.progress,
})

/**
 * `StreamMember.make` is `Actor.stream`: declares a live, read-only feed by
 * tag. `success` types each element; `payload` defaults to `Schema.Void`, and
 * `progress.jobs` lists the jobs whose executor progress the handler may follow.
 *
 * @example
 * const Ticks = Actor.stream("Ticks", { success: Schema.Int })
 */
export const StreamMember = { make }
