import { Schema, SchemaAST } from "effect"
import type { DeclaredError, Member, ValueSchema } from "./command.ts"
import type { ProgressEffect } from "./effect.ts"

/** Tags reserved for framework control frames, which travel in their own envelope variant. */
const CONTROL_TAGS = new Set(["Resync", "ResyncReplayed", "ResyncDone"])

/**
 * A long-lived session between one client and one actor. Its `input` is the
 * open params; `server` frames flow to the client and `client` frames to the
 * actor; `session` is the per-connection state the handlers may set.
 */
export interface Connection<
  Tag extends string,
  Params extends ValueSchema,
  Server extends ValueSchema,
  Client extends ValueSchema,
  Session extends ValueSchema | undefined,
  Errors extends ReadonlyArray<DeclaredError>,
> extends Member<"connection", Tag, Params, typeof Schema.Void, Errors> {
  readonly server: Server
  readonly client: Client
  readonly session: Session
  /** Stamp member frames with the flushed-through cursor and event cursor. Default true. */
  readonly stampCursor: boolean
  /** Executor progress this member's connections receive, if any. */
  readonly progress: ConnectionProgress | undefined
}

/**
 * The effects whose executor progress a connection member receives, and to
 * whom: `"performer"` (the default) only connections whose caller has the
 * performing turn's principal, `"all"` every open connection of the member.
 */
export interface ConnectionProgress {
  readonly effects: ReadonlyArray<ProgressEffect>
  readonly to: "performer" | "all"
}

export type AnyConnection = Connection<
  string,
  ValueSchema,
  ValueSchema,
  ValueSchema,
  ValueSchema | undefined,
  ReadonlyArray<DeclaredError>
>

const taggedIdentifiers = (schema: Schema.Top): ReadonlyArray<string> => {
  const ast = SchemaAST.toEncoded(schema.ast)
  const members = SchemaAST.isUnion(ast) ? ast.types : [ast]
  const tags: Array<string> = []

  for (const member of members)
    if (SchemaAST.isObjects(member))
      for (const signature of member.propertySignatures)
        if (signature.name === "_tag" && SchemaAST.isLiteral(signature.type))
          tags.push(String(signature.type.literal))

  return tags
}

const make = <
  const Tag extends string,
  Server extends ValueSchema,
  Params extends ValueSchema = typeof Schema.Void,
  Client extends ValueSchema = typeof Schema.Never,
  Session extends ValueSchema | undefined = undefined,
  const Errors extends ReadonlyArray<DeclaredError> = readonly [],
>(
  tag: Tag,
  options: {
    readonly server: Server
    readonly params?: Params
    readonly client?: Client
    readonly session?: Session
    readonly errors?: Errors
    readonly stampCursor?: boolean
    readonly progress?: {
      readonly effects: ReadonlyArray<ProgressEffect>
      readonly to?: "performer" | "all"
    }
  },
): Connection<Tag, Params, Server, Client, Session, Errors> => {
  for (const schema of [options.server, options.client])
    if (schema !== undefined)
      for (const reserved of taggedIdentifiers(schema))
        if (CONTROL_TAGS.has(reserved))
          throw new Error(`Connection ${tag} frames may not use the control tag ${reserved}`)

  return {
    kind: "connection",
    tag,
    input: (options.params ?? Schema.Void) as Params,
    output: Schema.Void,
    errors: (options.errors ?? []) as Errors,
    server: options.server,
    client: (options.client ?? Schema.Never) as Client,
    session: options.session as Session,
    stampCursor: options.stampCursor ?? true,
    progress:
      options.progress === undefined
        ? undefined
        : { effects: options.progress.effects, to: options.progress.to ?? "performer" },
  }
}

export const Connection = { make }
