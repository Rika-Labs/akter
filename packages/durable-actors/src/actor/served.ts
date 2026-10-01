import { Effect, type Result, Schema, SchemaAST } from "effect"
import {
  type DeclaredError,
  declaredErrors,
  type MemberKind,
  type ValueSchema,
} from "../members/command.ts"
import type { ProgressJob } from "../members/job.ts"

/** A public member as a served endpoint sees it: wire schemas and the runtime's payload codec. */
export interface ServedMember {
  readonly kind: MemberKind
  readonly tag: string
  readonly input: ValueSchema
  readonly output: ValueSchema
  readonly errors: ReadonlyArray<DeclaredError>
  /** Decodes a JSON request body (`undefined` when empty) into the runtime payload. */
  readonly payload: (body: Schema.Json | undefined) => Effect.Effect<string, Schema.SchemaError>
  /** Status per declared error, in declaration order. */
  readonly failureStatus: (value: string) => Effect.Effect<number, Schema.SchemaError>
  /** A reducer's pure transition, which a client applies before its receipt arrives. */
  readonly reducer: OptimisticReducer | undefined
  /** True for a query declared `watch: true`, which is also served as a watch. */
  readonly watch: boolean
}

/** An actor's decoded state. */
export type StateValue = Schema.Struct.Type<Schema.Struct.Fields>

/** What a client needs to run a reducer on its own copy of committed state. */
export interface OptimisticReducer {
  /** The actor's state schema. */
  readonly state: ValueSchema & { readonly Type: StateValue }
  readonly reduce: (
    state: StateValue,
    input: ValueSchema["Type"],
  ) => Result.Result<StateValue, unknown>
  /**
   * True for a batched reducer, which replies nothing, so its receipt carries
   * no committed state. The field keeps its served name for the client.
   */
  readonly commutative: boolean
}

/** A connection member as a served WebSocket route sees it. */
export interface ServedConnection {
  readonly tag: string
  readonly params: ValueSchema
  readonly server: ValueSchema
  readonly client: ValueSchema
  readonly errors: ReadonlyArray<DeclaredError>
  /** False when frames carry no cursors, so clients always resync from state. */
  readonly stampCursor: boolean
  /** Decodes a `hello` frame's `params` (`undefined` when absent) into the runtime's encoding. */
  readonly openParams: (json: Schema.Json | undefined) => Effect.Effect<string, Schema.SchemaError>
  /** Decodes a client member frame into the runtime's encoding. */
  readonly clientFrame: (json: Schema.Json) => Effect.Effect<string, Schema.SchemaError>
  /** A runtime-encoded server frame as the JSON value a client reads. */
  readonly serverFrame: (encoded: string) => Effect.Effect<Schema.Json, Schema.SchemaError>
  /** A declared `open` failure, as the runtime stores it, as the JSON a client reads. */
  readonly openFailure: (encoded: string) => Effect.Effect<Schema.Json, Schema.SchemaError>
  /** The progress schema of each job whose executor progress this member receives, by tag. */
  readonly progress: ReadonlyMap<string, ValueSchema>
}

/** What `Actor.serve` and `X.client` need of one actor definition. */
export interface ServedDefinition {
  /** The actor type's name, its path segment in served routes. */
  readonly name: string
  /** How a client addresses instances: by id, as the singleton, or by an id it mints. */
  readonly key: "keyed" | "singleton" | "minted"
  /** Decodes an id path segment into the runtime's id; fails when it breaks the key schema. */
  readonly decodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  /** The path segment a client sends for a typed id. */
  readonly encodeId: (id: string) => Effect.Effect<string, Schema.SchemaError>
  /** `api` members only; `internal` commands are never served. */
  readonly members: ReadonlyArray<ServedMember>
  /** Connection members, served as WebSocket upgrades. */
  readonly connections: ReadonlyArray<ServedConnection>
  /** Tags of the events served as SSE event feeds. */
  readonly feeds: ReadonlyArray<string>
  /** Names of the declared content blobs, served for download and grants. */
  readonly contents: ReadonlyArray<string>
  /** `Actor.stream` members, served over SSE; each element is one encoded `success` value. */
  readonly streams: ReadonlyArray<ServedMember>
}

/** Statuses the served protocol assigns to framework outcomes; a declared failure can't claim one. */
const RESERVED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 410, 413, 415, 429,
])

/** Error tags the served protocol uses for framework outcomes; a declared error can't claim one. */
const RESERVED_TAGS: ReadonlySet<string> = new Set(["ActorError", "Defect"])

/** The HTTP status of a declared failure whose error sets no `httpApiStatus`. */
const DECLARED_FAILURE_STATUS = 422

/** The HTTP status a served response uses for `error`: its `httpApiStatus`, or 422. */
export const declaredStatus = (error: DeclaredError): number =>
  SchemaAST.resolveAt<number>("httpApiStatus")(error.ast) ?? DECLARED_FAILURE_STATUS

/** Rejects declared errors a served response could not tell apart from a framework one. */
export const checkDeclaredErrors = (member: {
  readonly tag: string
  readonly error: DeclaredError
}) => {
  for (const error of declaredErrors(member.error)) {
    const tag = SchemaAST.resolveIdentifier(error.ast)

    if (tag !== undefined && RESERVED_TAGS.has(tag))
      throw new Error(`${member.tag} declares an error tagged ${tag}, which is reserved`)

    const status = declaredStatus(error)

    if (!Number.isInteger(status) || status < 400 || status > 499 || RESERVED_STATUSES.has(status))
      throw new Error(`${member.tag} declares httpApiStatus ${status}; use an unreserved 4xx`)
  }
}

/** A member and the codecs `servedMember` builds its served view from. */
interface ServedMemberSource {
  readonly member: {
    readonly kind: MemberKind
    readonly tag: string
    readonly payload: ValueSchema
    readonly success: ValueSchema
    readonly error: DeclaredError
    readonly state?: { readonly fields: Readonly<Record<string, ValueSchema>> }
    /** Method syntax keeps the parameters bivariant, so every reducer's `reduce` fits. */
    reduce?(state: StateValue, payload: ValueSchema["Type"]): Result.Result<StateValue, unknown>
    readonly batch?: object | undefined
    readonly watch?: boolean
  }
  readonly codecs: {
    readonly encodePayload: (value: {
      readonly value: unknown
    }) => Effect.Effect<string, Schema.SchemaError>
    readonly decodeError: (
      value: string,
    ) => Effect.Effect<DeclaredError["Type"], Schema.SchemaError>
  }
}

/** A public member's served view: its wire schemas, body decoder, and failure statuses. */
export const servedMember = ({ member, codecs }: ServedMemberSource): ServedMember => {
  const decodeBody = Schema.decodeUnknownEffect(Schema.toCodecJson(member.payload))
  const errors = declaredErrors(member.error)
  const statuses = errors.map((error) => [Schema.is(error), declaredStatus(error)] as const)

  return {
    kind: member.kind,
    tag: member.tag,
    input: member.payload,
    output: member.success,
    errors,
    payload: (body) =>
      decodeBody(body ?? null).pipe(Effect.flatMap((value) => codecs.encodePayload({ value }))),
    failureStatus: (value) =>
      codecs
        .decodeError(value)
        .pipe(
          Effect.map((error) => statuses.find(([is]) => is(error))?.[1] ?? DECLARED_FAILURE_STATUS),
        ),
    reducer:
      member.kind === "reducer" && member.state !== undefined && member.reduce !== undefined
        ? {
            state: Schema.Struct(member.state.fields),
            reduce: member.reduce.bind(member),
            commutative: member.batch !== undefined,
          }
        : undefined,
    watch: member.kind === "query" && member.watch === true,
  }
}

const ValueJson = Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) }))

const decodeValueJson = Schema.decodeUnknownEffect(ValueJson)

const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/** A connection member's served view: its WebSocket frame codecs and progress schemas. */
export const servedConnection = (member: {
  readonly tag: string
  readonly payload: ValueSchema
  readonly server: ValueSchema
  readonly client: ValueSchema
  readonly error: DeclaredError
  readonly stampCursor: boolean
  readonly progress: { readonly jobs: ReadonlyArray<ProgressJob> } | undefined
}): ServedConnection => {
  const valueOf = (schema: ValueSchema) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: schema }))))

  const decodeParams = Schema.decodeUnknownEffect(Schema.toCodecJson(member.payload))
  const encodeParams = valueOf(member.payload)
  const decodeClient = Schema.decodeUnknownEffect(Schema.toCodecJson(member.client))
  const encodeClient = valueOf(member.client)

  return {
    tag: member.tag,
    params: member.payload,
    server: member.server,
    client: member.client,
    errors: declaredErrors(member.error),
    stampCursor: member.stampCursor,
    openParams: (json) =>
      decodeParams(json ?? null).pipe(Effect.flatMap((value) => encodeParams({ value }))),
    clientFrame: (json) =>
      decodeClient(json).pipe(Effect.flatMap((value) => encodeClient({ value }))),
    serverFrame: (encoded) =>
      decodeValueJson(encoded).pipe(Effect.map(({ value }) => value ?? null)),
    openFailure: decodeJsonString,
    progress: new Map((member.progress?.jobs ?? []).map((job) => [job.tag, job.progress])),
  }
}
