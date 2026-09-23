import { Cause, Schema } from "effect"

export type ValueSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

export type DeclaredError = ValueSchema & {
  readonly Type: Cause.YieldableError & { readonly _tag: string }
}

export type MemberKind = "command" | "query"

/**
 * An `api` or `internal` member. Commands run as fenced, receipted turns;
 * queries read committed state without an activation (ADR 0010).
 */
export interface Member<
  Kind extends MemberKind,
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> {
  readonly kind: Kind
  readonly tag: Tag
  readonly input: Input
  readonly output: Output
  readonly errors: Errors
}

export type Command<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> = Member<"command", Tag, Input, Output, Errors>

export type Query<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> = Member<"query", Tag, Input, Output, Errors>

export type AnyMember = Member<
  MemberKind,
  string,
  ValueSchema,
  ValueSchema,
  ReadonlyArray<DeclaredError>
>

export type AnyCommand = Command<string, ValueSchema, ValueSchema, ReadonlyArray<DeclaredError>>

/** A record of members keyed by tag, as used by the `api` and `internal` definition sections. */
export type MemberRecord = Readonly<Record<string, AnyMember>>

export type CommandRecord = Readonly<Record<string, AnyCommand>>

const member =
  <Kind extends MemberKind>(kind: Kind) =>
  <
    const Tag extends string,
    Input extends ValueSchema = Schema.Void,
    Output extends ValueSchema = Schema.Void,
    const Errors extends ReadonlyArray<DeclaredError> = readonly [],
  >(
    tag: Tag,
    options?: { readonly input?: Input; readonly output?: Output; readonly errors?: Errors },
  ): Member<Kind, Tag, Input, Output, Errors> => {
    const input = (options?.input ?? Schema.Void) as Input
    const output = (options?.output ?? Schema.Void) as Output
    const errors = (options?.errors ?? []) as Errors

    return { kind, tag, input, output, errors }
  }

export const Command = { make: member("command") }

export const Query = { make: member("query") }
