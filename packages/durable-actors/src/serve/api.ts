import { Schema, SchemaAST } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi"
import {
  declaredStatus,
  type ServedConnection,
  type ServedDefinition,
  type ServedMember,
} from "../actor/served.ts"
import { type AuthProvider, Credential } from "./auth.ts"
import { ASSERTION_HEADER } from "./assertion/binding.ts"
import { SUBPROTOCOL } from "./frames.ts"
import { ContentRef } from "../identity/content.ts"
import { Defect, envelope, type WireTag } from "./wire.ts"

const COMMAND_ERRORS = {
  400: ["InvalidCommandId", "InvalidInput"],
  401: ["Unauthorized"],
  403: ["Unauthorized", "InvalidInput"],
  404: ["NotCreated", "InvalidInput"],
  409: ["CommandConflict"],
  410: ["CommandExpired"],
  413: ["InvalidInput"],
  415: ["InvalidInput"],
  429: ["MailboxFull"],
  503: ["ActorUnavailable", "RunnerAtCapacity"],
  504: ["Timeout"],
} as const

const QUERY_ERRORS = {
  400: ["InvalidInput"],
  401: ["Unauthorized"],
  403: ["Unauthorized", "InvalidInput"],
  404: ["InvalidInput"],
  413: ["InvalidInput"],
  415: ["InvalidInput"],
  503: ["ActorUnavailable"],
  504: ["Timeout"],
} as const

const errorSchemas = (errors: Readonly<Record<number, ReadonlyArray<WireTag>>>, prefix: string) =>
  Object.entries(errors).map(([status, tags]) =>
    envelope({ tags, identifier: `${prefix}ActorError${status}` }).annotate({
      httpApiStatus: Number(status),
    }),
  )

/** A refused upgrade; once upgraded, a session ends with an `end` message instead. */
const UPGRADE_ERRORS = {
  400: ["InvalidInput"],
  401: ["Unauthorized"],
  403: ["InvalidInput"],
  404: ["InvalidInput"],
  413: ["InvalidInput"],
  503: ["RunnerAtCapacity"],
} as const

/** A refused feed; a feed that ends later sends an `end` message instead. */
const FEED_ERRORS = {
  400: ["InvalidInput"],
  401: ["Unauthorized"],
  403: ["Unauthorized", "InvalidInput"],
  404: ["NotCreated", "InvalidInput"],
  503: ["ActorUnavailable", "RunnerAtCapacity"],
} as const

/** A refused content operation; a download a sweep cut short ends its body early instead. */
const CONTENT_ERRORS = {
  400: ["InvalidInput"],
  401: ["Unauthorized"],
  403: ["Unauthorized", "InvalidInput"],
  404: ["InvalidInput"],
  413: ["InvalidInput"],
  503: ["ActorUnavailable"],
} as const

const contentErrors = errorSchemas(CONTENT_ERRORS, "Content")

const commandErrors = errorSchemas(COMMAND_ERRORS, "Command")

const feedErrors = errorSchemas(FEED_ERRORS, "Feed")

const upgradeErrors = errorSchemas(UPGRADE_ERRORS, "Upgrade")

const queryErrors = errorSchemas(QUERY_ERRORS, "Query")

const defect = Defect.annotate({ httpApiStatus: 500 })

const ProtocolInfo = Schema.Struct({
  protocol: Schema.Literal(1),
  retryWindowMs: Schema.Int,
  now: Schema.Int,
}).annotate({ identifier: "Protocol" })

export const MintedCommandId = Schema.Struct({ commandId: Schema.String }).annotate({
  identifier: "MintedCommandId",
})

const IdempotencyKey = Schema.String.annotate({
  description: "The command id, v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>; retries send the same one.",
})

/** The path of one served member, with `:id` for keyed and minted actors. */
export interface ServedRoute {
  readonly definition: ServedDefinition
  readonly member: { readonly tag: string }
}

export const memberPath = ({ definition, member }: ServedRoute) =>
  definition.key === "singleton"
    ? `/actors/${definition.name}/${member.tag}`
    : `/actors/${definition.name}/:id/${member.tag}`

const endpoint = (basePath: string, definition: ServedDefinition, member: ServedMember) => {
  const isQuery = member.kind === "query"
  const path = `${basePath}${memberPath({ definition, member })}` as `/${string}`

  const declared = member.errors.map((error) =>
    SchemaAST.resolveAt<number>("httpApiStatus")(error.ast) === undefined
      ? error.annotate({ httpApiStatus: declaredStatus(error) })
      : error,
  )

  return HttpApiEndpoint.post(member.tag, path, {
    params: definition.key === "singleton" ? undefined : { id: Schema.String },
    headers: isQuery ? undefined : { "idempotency-key": IdempotencyKey },
    payload: SchemaAST.isVoid(member.input.ast) ? undefined : member.input,
    success: SchemaAST.isVoid(member.output.ast) ? HttpApiSchema.NoContent : member.output,
    error: [...declared, ...(isQuery ? queryErrors : commandErrors), defect],
  })
}

const frameSchemaName = (
  definition: ServedDefinition,
  connection: ServedConnection,
  part: string,
) => `${definition.name}.${connection.tag}.${part}`

/** The schemas a connection's messages carry: `hello` params, and frames each way. */
const frameParts = (connection: ServedConnection) => ({
  params: connection.params,
  server: connection.server,
  client: connection.client,
})

// OpenAPI can't describe a socket's message flow, so a connection is an upgrade
// operation that names its frame schemas; the envelope is the served protocol's.
const connectionEndpoint = (
  basePath: string,
  definition: ServedDefinition,
  connection: ServedConnection,
) =>
  HttpApiEndpoint.get(
    connection.tag,
    `${basePath}${memberPath({ definition, member: connection })}` as `/${string}`,
    {
      params: definition.key === "singleton" ? undefined : { id: Schema.String },
      error: [...upgradeErrors, defect],
    },
  ).annotate(OpenApi.Transform, (operation) => {
    const { 204: _, ...refusals }: { readonly [status: string]: Schema.Json } =
      operation.responses ?? {}

    return {
      ...operation,
      responses: {
        101: { description: `WebSocket upgrade with subprotocol ${SUBPROTOCOL}` },
        ...refusals,
      },
      "x-durable-transport": "websocket",
      "x-durable-subprotocol": SUBPROTOCOL,
      "x-durable-frames": Object.fromEntries(
        Object.keys(frameParts(connection)).map((part) => [
          part,
          { $ref: `#/components/schemas/${frameSchemaName(definition, connection, part)}` },
        ]),
      ),
    }
  })

// An event feed is served over SSE: one message per event, its cursor as the `id`.
const feedEndpoint = (basePath: string, definition: ServedDefinition) =>
  HttpApiEndpoint.get(
    "events",
    `${basePath}${memberPath({ definition, member: { tag: "events" } })}` as `/${string}`,
    {
      params: definition.key === "singleton" ? undefined : { id: Schema.String },
      query: {
        event: Schema.Array(Schema.Literals(definition.feeds)),
        after: Schema.optionalKey(Schema.String),
      },
      error: [...feedErrors, defect],
    },
  ).annotate(OpenApi.Transform, (operation) => {
    const { 204: _, ...refusals }: { readonly [status: string]: Schema.Json } =
      operation.responses ?? {}

    return {
      ...operation,
      responses: {
        200: {
          description:
            "Server-sent events: `id` is the event cursor, `event` its tag; `Last-Event-ID` resumes after it",
          content: { "text/event-stream": { schema: { type: "string" } } },
        },
        ...refusals,
        410: { description: "RetentionGap: events after the cursor were pruned" },
      },
      "x-durable-transport": "sse",
    }
  })

const frameSchemas = (definition: ServedDefinition, connection: ServedConnection) =>
  Object.entries(frameParts(connection)).map(([part, schema]) =>
    schema.annotate({ identifier: frameSchemaName(definition, connection, part) }),
  )

const ContentRefSchema = ContentRef.annotate({ identifier: "ContentRef" })

const OCTETS = { "application/octet-stream": { schema: { type: "string", format: "binary" } } }

/** The path segment an actor's content routes are served under, so no member may take it. */
export const CONTENT_ROUTE = "content"

const contentPath = (basePath: string, definition: ServedDefinition) =>
  `${basePath}${memberPath({ definition, member: { tag: CONTENT_ROUTE } })}/:blob/:name`

const contentParams = (definition: ServedDefinition) => {
  const entry = { blob: Schema.Literals(definition.contents), name: Schema.String }

  return definition.key === "singleton" ? entry : { id: Schema.String, ...entry }
}

// Downloads stream the entry's bytes; grants answer a fresh `ContentRef`.
const contentEndpoints = (basePath: string, definition: ServedDefinition) => [
  HttpApiEndpoint.get(CONTENT_ROUTE, contentPath(basePath, definition) as `/${string}`, {
    params: contentParams(definition),
    error: [...contentErrors, defect],
  }).annotate(OpenApi.Transform, (operation) => {
    const { 204: _, ...refusals }: { readonly [status: string]: Schema.Json } =
      operation.responses ?? {}

    return {
      ...operation,
      responses: {
        200: { description: "The referenced content's bytes", content: OCTETS },
        ...refusals,
      },
    }
  }),
  HttpApiEndpoint.post(
    `${CONTENT_ROUTE}.grant`,
    `${contentPath(basePath, definition)}/grant` as `/${string}`,
    {
      params: contentParams(definition),
      success: ContentRefSchema,
      error: [...contentErrors, defect],
    },
  ),
]

const uploadEndpoint = (basePath: string) =>
  HttpApiEndpoint.post("uploadContent", `${basePath}/content` as `/${string}`, {
    success: ContentRefSchema,
    error: [...contentErrors, defect],
  }).annotate(OpenApi.Transform, (operation) => ({
    ...operation,
    requestBody: { required: true, content: OCTETS },
  }))

/** Protocol routes live in their own group. */
const PROTOCOL_GROUP = "durable"

/** Operation ids of the protocol routes; no served member may reuse one. */
export const PROTOCOL_OPERATIONS: ReadonlySet<string> = new Set([
  `${PROTOCOL_GROUP}.protocol`,
  `${PROTOCOL_GROUP}.commandIds`,
  `${PROTOCOL_GROUP}.uploadContent`,
])

export interface ServedRoutes {
  readonly definitions: ReadonlyArray<ServedDefinition>
  readonly basePath: string
  /** Whether the runtime serves content, so `POST /content` and the content routes exist. */
  readonly content: boolean
}

export const build = ({ definitions, basePath, content }: ServedRoutes) => {
  const groups: Array<HttpApiGroup.Constraint> = [
    HttpApiGroup.make(PROTOCOL_GROUP).add(
      HttpApiEndpoint.get("protocol", `${basePath}/protocol` as `/${string}`, {
        success: ProtocolInfo,
      }),
      HttpApiEndpoint.post("commandIds", `${basePath}/command-ids` as `/${string}`, {
        success: MintedCommandId,
        error: [
          ...errorSchemas({ 401: ["Unauthorized"], 503: ["ActorUnavailable"] }, "Mint"),
          defect,
        ],
      }),
      ...(content ? [uploadEndpoint(basePath)] : []),
    ),
  ]

  for (const definition of definitions) {
    const endpoints = [
      ...definition.members.map((member) => endpoint(basePath, definition, member)),
      ...definition.connections.map((connection) =>
        connectionEndpoint(basePath, definition, connection),
      ),
      ...(definition.feeds.length > 0 ? [feedEndpoint(basePath, definition)] : []),
      ...(content && definition.contents.length > 0 ? contentEndpoints(basePath, definition) : []),
    ]

    if (endpoints.length > 0)
      groups.push(HttpApiGroup.make(definition.name).add(endpoints[0]!, ...endpoints.slice(1)))
  }

  const api: HttpApi.HttpApi<string, HttpApiGroup.Constraint> = HttpApi.make("durable-actors")
    .add(groups[0]!, ...groups.slice(1))
    .annotate(
      HttpApi.AdditionalSchemas,
      definitions.flatMap((definition) =>
        definition.connections.flatMap((connection) => frameSchemas(definition, connection)),
      ),
    )

  return api
}

export type ServedApi = ReturnType<typeof build>

export interface DocumentOptions {
  readonly api: ServedApi
  readonly auth: AuthProvider<unknown>
  readonly title: string
  readonly version: string
}

/** The OpenAPI security scheme a credential is documented as; a provider has at most one per scheme. */
export const schemeName = Credential.$match({
  Bearer: () => "bearer",
  Jwt: () => "bearer",
  Cookie: () => "cookie",
  Assertion: () => "assertion",
})

const securityScheme = Credential.$match({
  Bearer: () => ({ type: "http", scheme: "bearer" }),
  Jwt: () => ({ type: "http", scheme: "bearer", bearerFormat: "JWT" }),
  Cookie: ({ name }) => ({ type: "apiKey", in: "cookie", name }),
  Assertion: () => ({ type: "apiKey", in: "header", name: ASSERTION_HEADER }),
})

/**
 * The OpenAPI 3.1 document of `api`. Every authenticated operation lists the
 * provider's credentials as alternatives, since any one of them authenticates.
 */
export const document = ({ api, auth, title, version }: DocumentOptions) => {
  const spec = OpenApi.fromApi(api)

  const security = auth.credentials.map((credential) => ({
    [schemeName(credential)]: [],
  }))

  const paths = Object.fromEntries(
    Object.entries(spec.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([method, operation]) => [
          method,
          Array.isArray(operation)
            ? operation
            : Object.assign({}, operation, {
                security:
                  "operationId" in operation && operation.operationId === "durable.protocol"
                    ? []
                    : security,
              }),
        ]),
      ),
    ]),
  )

  return {
    ...spec,
    info: { ...spec.info, title, version },
    paths,
    components: {
      ...spec.components,
      securitySchemes: Object.fromEntries(
        auth.credentials.map((credential) => [schemeName(credential), securityScheme(credential)]),
      ),
    },
  }
}
