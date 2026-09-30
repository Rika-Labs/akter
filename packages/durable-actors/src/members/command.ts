import { type Cause, Predicate, Schema, SchemaAST } from "effect"

/** A schema that needs no Effect services to encode or decode, so a member codec runs anywhere. */
export type ValueSchema = Schema.Top & {
  readonly DecodingServices: never
  readonly EncodingServices: never
}

/**
 * The `error` schema of a member: a tagged error class, a `Schema.Union` of
 * them, or `Schema.Never`. A handler may fail with its values and callers
 * receive them as typed failures; a framework reason can never masquerade as one.
 */
export type DeclaredError = ValueSchema & {
  readonly Type: Cause.YieldableError & { readonly _tag: string }
}

/** The struct fields a `payload` option may name instead of a schema. */
export type PayloadFields = Readonly<Record<string, ValueSchema>>

/** A `payload` option: a schema, or struct fields that stand for `Schema.Struct(fields)`. */
export type PayloadOption = ValueSchema | PayloadFields

/** The schema a `payload` option stands for. */
export type PayloadOf<P extends PayloadOption> = P extends ValueSchema
  ? P
  : P extends Schema.Struct.Fields
    ? Schema.Struct<P>
    : never

/** The kinds of member an actor definition lists. */
export type MemberKind = "command" | "query" | "reducer" | "connection" | "stream" | "workflow"

/**
 * An `api` or `internal` member. Commands and reducers run as fenced,
 * receipted turns; queries read committed state without an activation.
 */
export interface Member<
  Kind extends MemberKind,
  Tag extends string,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
> {
  readonly kind: Kind
  readonly tag: Tag
  readonly payload: Payload
  readonly success: Success
  readonly error: Error
}

/** A command member: a fenced, receipted turn that may change state, emit events, and stage intents and jobs. */
export type Command<
  Tag extends string,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
> = Member<"command", Tag, Payload, Success, Error>

/**
 * A query member: reads committed state without activating the actor, taking
 * the fence, or writing a receipt. A `watch` query can also be observed: its
 * handler may use only `Read`, so the runtime can record what it read.
 */
export type Query<
  Tag extends string,
  Payload extends ValueSchema,
  Success extends ValueSchema,
  Error extends DeclaredError,
  Watch extends boolean = boolean,
> = Member<"query", Tag, Payload, Success, Error> & { readonly watch: Watch }

/** Any `api` or `internal` member, whatever its schemas. */
export type AnyMember = Member<MemberKind, string, ValueSchema, ValueSchema, DeclaredError>

/** Any command, whatever its schemas. */
export type AnyCommand = Command<string, ValueSchema, ValueSchema, DeclaredError>

/** A record of members keyed by tag, as used by the `api` and `internal` definition sections. */
export type MemberRecord = Readonly<Record<string, AnyMember>>

/** A record of commands keyed by tag. */
export type CommandRecord = Readonly<Record<string, AnyCommand>>

/** Normalizes a `payload` option once: struct fields become `Schema.Struct(fields)`. */
export const payloadSchema = <P extends PayloadOption>(payload: P | undefined): PayloadOf<P> =>
  (payload === undefined
    ? Schema.Void
    : Schema.isSchema(payload)
      ? payload
      : Schema.Struct(payload as PayloadFields)) as PayloadOf<P>

/**
 * The tagged error classes an `error` schema admits, flattening unions;
 * `Schema.Never` admits none. The served protocol assigns each one its status.
 */
export const declaredErrors = (error: DeclaredError): ReadonlyArray<DeclaredError> => {
  if (SchemaAST.isNever(error.ast)) return []

  if (Predicate.hasProperty(error, "members") && Array.isArray(error.members))
    return (error.members as ReadonlyArray<DeclaredError>).flatMap(declaredErrors)

  return [error]
}

/**
 * Builds a member of `kind`: `payload` and `success` default to `Schema.Void`
 * and `error` to `Schema.Never`.
 */
export const member =
  <Kind extends MemberKind>(kind: Kind) =>
  <
    const Tag extends string,
    const P extends PayloadOption = Schema.Void,
    Success extends ValueSchema = Schema.Void,
    Error extends DeclaredError = Schema.Never,
  >(
    tag: Tag,
    options?: { readonly payload?: P; readonly success?: Success; readonly error?: Error },
  ): Member<Kind, Tag, PayloadOf<P>, Success, Error> => ({
    kind,
    tag,
    payload: payloadSchema(options?.payload),
    success: (options?.success ?? Schema.Void) as Success,
    error: (options?.error ?? Schema.Never) as Error,
  })

/**
 * `Command.make` is `Actor.command`: declares a command by tag. `payload` is a
 * schema or struct fields and `success` a schema, both `Schema.Void` when
 * omitted; `error` is the tagged error class, or `Schema.Union` of them, its
 * handler may fail with, which callers receive as typed failures.
 *
 * @example
 * const Increment = Actor.command("Increment", {
 *   payload: { by: Schema.Int },
 *   success: Schema.Int,
 * })
 */
export const Command = { make: member("command") }

/**
 * `Query.make` is `Actor.query`: declares a query by tag, with the same
 * options as a command. A query reads committed state only and never
 * activates the actor. With `watch: true` the query can also be observed
 * (`handle.Total.watch()`): its handler may require nothing but `X.Read`,
 * because the runtime records which state, event classes, tables, and blobs
 * each rerun reads and reruns only after a commit that wrote one of them. It
 * sees the clock and random sources as of its rerun, and they trigger no
 * rerun of their own.
 *
 * @example
 * const Total = Actor.query("Total", { success: Schema.Int, watch: true })
 */
export const Query = {
  make: <
    const Tag extends string,
    const P extends PayloadOption = Schema.Void,
    Success extends ValueSchema = Schema.Void,
    Error extends DeclaredError = Schema.Never,
    const Watch extends boolean = false,
  >(
    tag: Tag,
    options?: {
      readonly payload?: P
      readonly success?: Success
      readonly error?: Error
      readonly watch?: Watch
    },
  ): Query<Tag, PayloadOf<P>, Success, Error, Watch> => ({
    ...member("query")(tag, options),
    watch: (options?.watch ?? false) as Watch,
  }),
}
