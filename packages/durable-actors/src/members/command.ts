import { Cause, Schema } from "effect"

/** A schema that needs no Effect services to encode or decode, so a member codec runs anywhere. */
export type ValueSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/** A tagged error class a member declares in `errors`; its handler may fail with it and callers receive it as a typed failure. */
export type DeclaredError = ValueSchema & {
  readonly Type: Cause.YieldableError & { readonly _tag: string }
}

/** The kinds of member an actor definition lists. */
export type MemberKind = "command" | "query" | "reducer" | "connection" | "stream" | "workflow"

/**
 * An `api` or `internal` member. Commands and reducers run as fenced,
 * receipted turns; queries read committed state without an activation.
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

/** A command member: a fenced, receipted turn that may change state, emit events, and stage intents and effects. */
export type Command<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> = Member<"command", Tag, Input, Output, Errors>

/** A query member: reads committed state without activating the actor, taking the fence, or writing a receipt. */
export type Query<
  Tag extends string,
  Input extends ValueSchema,
  Output extends ValueSchema,
  Errors extends ReadonlyArray<DeclaredError>,
> = Member<"query", Tag, Input, Output, Errors>

/** Any `api` or `internal` member, whatever its schemas. */
export type AnyMember = Member<
  MemberKind,
  string,
  ValueSchema,
  ValueSchema,
  ReadonlyArray<DeclaredError>
>

/** Any command, whatever its schemas. */
export type AnyCommand = Command<string, ValueSchema, ValueSchema, ReadonlyArray<DeclaredError>>

/** A record of members keyed by tag, as used by the `api` and `internal` definition sections. */
export type MemberRecord = Readonly<Record<string, AnyMember>>

/** A record of commands keyed by tag. */
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

/**
 * `Command.make` is `Actor.command`: declares a command by tag. `input` and
 * `output` default to `void`; `errors` lists the tagged errors its handler may
 * fail with, which callers receive as typed failures.
 *
 * @example
 * const Increment = Actor.command("Increment", {
 *   input: Schema.Struct({ by: Schema.Int }),
 *   output: Schema.Int,
 * })
 */
export const Command = { make: member("command") }

/**
 * `Query.make` is `Actor.query`: declares a query by tag, with the same
 * options as a command. A query reads committed state only and never
 * activates the actor.
 *
 * @example
 * const Total = Actor.query("Total", { output: Schema.Int })
 */
export const Query = { make: member("query") }
