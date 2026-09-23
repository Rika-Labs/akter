import { Cause, Schema } from "effect"

export type ValueSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

export type DeclaredError = ValueSchema & {
  readonly Type: Cause.YieldableError & { readonly _tag: string }
}

export interface Command<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> {
  readonly tag: Tag
  readonly input: Input
  readonly output: Output
  readonly errors: Errors
}

export type AnyCommand = Command<string, ValueSchema, ValueSchema, ReadonlyArray<DeclaredError>>

/** A record of commands keyed by tag, as used by the `api` and `internal` definition sections. */
export type CommandRecord = Readonly<Record<string, AnyCommand>>

export const Command = {
  make: <
    const Tag extends string,
    Input extends ValueSchema = Schema.Void,
    Output extends ValueSchema = Schema.Void,
    const Errors extends ReadonlyArray<DeclaredError> = readonly [],
  >(
    tag: Tag,
    options?: { readonly input?: Input; readonly output?: Output; readonly errors?: Errors },
  ): Command<Tag, Input, Output, Errors> => {
    const input = (options?.input ?? Schema.Void) as Input
    const output = (options?.output ?? Schema.Void) as Output
    const errors = (options?.errors ?? []) as Errors

    return { tag, input, output, errors }
  },
}
