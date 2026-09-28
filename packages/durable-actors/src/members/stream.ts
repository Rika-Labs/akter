import { Schema } from "effect"
import type { DeclaredError, Member, ValueSchema } from "./command.ts"

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
> extends Member<"stream", Tag, Input, Output, Errors> {}

export type AnyStream = Stream<string, ValueSchema, ValueSchema, ReadonlyArray<DeclaredError>>

const make = <
  const Tag extends string,
  Output extends ValueSchema,
  Input extends ValueSchema = typeof Schema.Void,
  const Errors extends ReadonlyArray<DeclaredError> = readonly [],
>(
  tag: Tag,
  options: { readonly output: Output; readonly input?: Input; readonly errors?: Errors },
): Stream<Tag, Input, Output, Errors> => ({
  kind: "stream",
  tag,
  input: (options.input ?? Schema.Void) as Input,
  output: options.output,
  errors: (options.errors ?? []) as Errors,
})

export const StreamMember = { make }
