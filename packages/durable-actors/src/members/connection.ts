import { Schema, SchemaAST } from "effect"
import {
  type DeclaredError,
  member,
  type Member,
  type PayloadOf,
  type PayloadOption,
  type ValueSchema,
} from "./command.ts"
import type { ProgressJob } from "./job.ts"

/** Tags reserved for framework control frames, which travel in their own envelope variant. */
const CONTROL_TAGS = new Set(["Resync", "ResyncReplayed", "ResyncDone"])

/**
 * A long-lived session between one client and one actor. Its `payload` is
 * the open params; `server` frames flow to the client and `client` frames to the
 * actor; `session` is the per-connection state the handlers may set.
 */
export interface Connection<
  Tag extends string,
  Params extends ValueSchema,
  Server extends ValueSchema,
  Client extends ValueSchema,
  Session extends ValueSchema | undefined,
  Error extends DeclaredError,
  Jobs extends ProgressJob = never,
> extends Member<"connection", Tag, Params, typeof Schema.Void, Error> {
  readonly server: Server
  readonly client: Client
  readonly session: Session
  /** Stamp member frames with the flushed-through cursor and event cursor. Default true. */
  readonly stampCursor: boolean
  /** Executor progress this member's connections receive, if any. */
  readonly progress: ConnectionProgress<Jobs> | undefined
}

/**
 * The jobs whose executor progress a connection member receives, and to
 * whom: `"principal"` (the default) only connections whose caller has the
 * enqueueing turn's principal, `"all"` every open connection of the member.
 */
interface ConnectionProgress<Jobs extends ProgressJob> {
  readonly jobs: ReadonlyArray<Jobs>
  readonly to: "principal" | "all"
}

/** Any connection member, whatever its schemas. */
export type AnyConnection = Connection<
  string,
  ValueSchema,
  ValueSchema,
  ValueSchema,
  ValueSchema | undefined,
  DeclaredError,
  ProgressJob
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
  const P extends PayloadOption = typeof Schema.Void,
  Client extends ValueSchema = typeof Schema.Never,
  Session extends ValueSchema | undefined = undefined,
  Error extends DeclaredError = typeof Schema.Never,
  Jobs extends ProgressJob = never,
>(
  tag: Tag,
  options: {
    readonly server: Server
    readonly payload?: P
    readonly client?: Client
    readonly session?: Session
    readonly error?: Error
    readonly stampCursor?: boolean
    readonly progress?: {
      readonly jobs: ReadonlyArray<Jobs>
      readonly to?: "principal" | "all"
    }
  },
): Connection<Tag, PayloadOf<P>, Server, Client, Session, Error, Jobs> => {
  if (tag.startsWith("$")) throw new Error(`Connection ${tag} may not start with $`)

  for (const schema of [options.server, options.client])
    if (schema !== undefined)
      for (const reserved of taggedIdentifiers(schema))
        if (CONTROL_TAGS.has(reserved))
          throw new Error(`Connection ${tag} frames may not use the control tag ${reserved}`)

  return {
    ...member("connection")<Tag, P, typeof Schema.Void, Error>(tag, {
      payload: options.payload,
      error: options.error,
    }),
    server: options.server,
    client: (options.client ?? Schema.Never) as Client,
    session: options.session as Session,
    stampCursor: options.stampCursor ?? true,
    progress:
      options.progress === undefined
        ? undefined
        : { jobs: options.progress.jobs, to: options.progress.to ?? "principal" },
  }
}

/**
 * `Connection.make` is `Actor.connection`: declares a connection by tag.
 * `server` types the frames sent to the client; `payload` the open params,
 * `client` the frames it may send, and `session` the per-connection state
 * handlers may set. Throws when the tag starts with `$`, which names framework
 * members such as the one an event feed opens, or when a frame schema uses a
 * reserved control tag (`Resync`, `ResyncReplayed`, `ResyncDone`).
 *
 * @example
 * const Room = Actor.connection("Room", { server: Message, client: Say })
 */
export const Connection = { make }
