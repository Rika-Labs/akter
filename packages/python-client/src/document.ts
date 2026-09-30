import { Effect, Schema } from "effect"
import { SchemaNode as SchemaNodeCodec, type SchemaNode } from "./types.ts"

/** The document is not one a served application produces. */
export class InvalidDocument extends Schema.TaggedError<InvalidDocument>()("InvalidDocument", {
  reason: Schema.String,
}) {}

const Content = Schema.Record(
  Schema.String,
  Schema.Struct({ schema: Schema.optionalKey(SchemaNodeCodec) }),
)

const Operation = Schema.Struct({
  operationId: Schema.String,
  parameters: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, in: Schema.String })),
  ),
  requestBody: Schema.optionalKey(
    Schema.Struct({ required: Schema.optionalKey(Schema.Boolean), content: Content }),
  ),
  responses: Schema.Record(Schema.String, Schema.Struct({ content: Schema.optionalKey(Content) })),
  "x-durable-transport": Schema.optionalKey(Schema.String),
})

const Document = Schema.Struct({
  openapi: Schema.String,
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, Operation)),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, SchemaNodeCodec) }),
})

const decodeDocument = Schema.decodeUnknownEffect(Document)

const MEMBER_OPERATION = /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/

const PROTOCOL_GROUP = "durable"

const PROTOCOL_OPERATION = "durable.protocol"

const FRAMEWORK_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 409, 410, 413, 415, 429, 500, 503, 504,
])

/** One public command, reducer, or query of a served actor, as its OpenAPI operation describes it. */
export interface MemberOperation {
  readonly operationId: string
  readonly actor: string
  readonly member: string
  readonly path: string
  readonly keyed: boolean
  readonly command: boolean
  readonly input: SchemaNode | undefined
  readonly inputRequired: boolean
  readonly output: SchemaNode | undefined
  /** The schemas of the failures the member declares: every response that is not a framework status. */
  readonly declared: ReadonlyArray<SchemaNode>
}

/** What a client needs from a served OpenAPI document. */
export interface ServedDocument {
  readonly protocolPath: string
  readonly operations: ReadonlyArray<MemberOperation>
  readonly components: Readonly<Record<string, SchemaNode>>
}

const jsonSchema = (content: typeof Content.Type | undefined) =>
  content?.["application/json"]?.schema

/**
 * Reads the operations a generated client wraps. A member is an operation
 * named `<Actor>.<Member>` that answers a plain `POST` under `/actors`;
 * protocol routes, streams, connections, feeds, and content have no method.
 */
export const readDocument = Effect.fnUntraced(function* (document: Schema.Json) {
  const { paths, components } = yield* decodeDocument(document)

  const protocol = Object.entries(paths).find(([, methods]) =>
    Object.values(methods).some((operation) => operation.operationId === PROTOCOL_OPERATION),
  )

  if (protocol === undefined)
    return yield* InvalidDocument.make({
      reason: "The OpenAPI document has no durable.protocol operation",
    })

  const operations: Array<MemberOperation> = []

  for (const [path, methods] of Object.entries(paths)) {
    const operation = methods["post"]
    const named = MEMBER_OPERATION.exec(operation?.operationId ?? "")

    if (
      operation === undefined ||
      named === null ||
      named[1] === PROTOCOL_GROUP ||
      !path.includes("/actors/") ||
      operation["x-durable-transport"] !== undefined
    )
      continue

    const statuses = Object.keys(operation.responses).map(Number)

    operations.push({
      operationId: operation.operationId,
      actor: named[1]!,
      member: named[2]!,
      path,
      keyed: path.includes("{id}"),
      command: (operation.parameters ?? []).some(
        (parameter) => parameter.in === "header" && parameter.name === "idempotency-key",
      ),
      input: jsonSchema(operation.requestBody?.content),
      inputRequired: operation.requestBody?.required === true,
      output: jsonSchema(operation.responses["200"]?.content),
      declared: statuses
        .filter((status) => status >= 400 && !FRAMEWORK_STATUSES.has(status))
        .flatMap((status) => jsonSchema(operation.responses[String(status)]?.content) ?? []),
    })
  }

  return {
    protocolPath: protocol[0],
    operations,
    components: components.schemas,
  } satisfies ServedDocument
})
