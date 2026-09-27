import { Schema, SchemaAST } from "effect"
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi"
import { declaredStatus, type ServedDefinition, type ServedMember } from "../actor/served.ts"
import type { AuthProvider } from "./auth.ts"
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

const commandErrors = errorSchemas(COMMAND_ERRORS, "Command")

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
  readonly member: ServedMember
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

/** Protocol routes live in their own group. */
const PROTOCOL_GROUP = "durable"

/** Operation ids of the protocol routes; no served member may reuse one. */
export const PROTOCOL_OPERATIONS: ReadonlySet<string> = new Set([
  `${PROTOCOL_GROUP}.protocol`,
  `${PROTOCOL_GROUP}.commandIds`,
])

export interface ServedRoutes {
  readonly definitions: ReadonlyArray<ServedDefinition>
  readonly basePath: string
}

export const build = ({ definitions, basePath }: ServedRoutes) => {
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
    ),
  ]

  for (const definition of definitions) {
    const endpoints = definition.members.map((member) => endpoint(basePath, definition, member))

    if (endpoints.length > 0)
      groups.push(HttpApiGroup.make(definition.name).add(endpoints[0]!, ...endpoints.slice(1)))
  }

  const api: HttpApi.HttpApi<string, HttpApiGroup.Constraint> = HttpApi.make("durable-actors").add(
    groups[0]!,
    ...groups.slice(1),
  )

  return api
}

export type ServedApi = ReturnType<typeof build>

const SECURITY_NAME = "bearer"

export interface DocumentOptions {
  readonly api: ServedApi
  readonly auth: AuthProvider<unknown>
  readonly title: string
  readonly version: string
}

/** The OpenAPI 3.1 document of `api`, with the provider's security on every authenticated operation. */
export const document = ({ api, auth, title, version }: DocumentOptions) => {
  const spec = OpenApi.fromApi(api)
  const secured = auth.scheme !== "none"

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
                  secured &&
                  !("operationId" in operation && operation.operationId === "durable.protocol")
                    ? [{ [SECURITY_NAME]: [] }]
                    : [],
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
      securitySchemes: secured
        ? {
            [SECURITY_NAME]:
              auth.scheme === "jwt"
                ? { type: "http", scheme: "bearer", bearerFormat: "JWT" }
                : { type: "http", scheme: "bearer" },
          }
        : {},
    },
  }
}
