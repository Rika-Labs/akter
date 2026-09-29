import { Effect, Schema } from "effect"
import type { ServedDefinition, ServedMember } from "../../actor/served.ts"
import { memberPath, MINT_OPERATION } from "../api.ts"

const JsonObject = Schema.Record(Schema.String, Schema.Json)

const Content = Schema.Struct({
  "application/json": Schema.optionalKey(Schema.Struct({ schema: JsonObject })),
})

const Operation = Schema.Struct({
  parameters: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        in: Schema.String,
        schema: Schema.optionalKey(
          Schema.Struct({ description: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
  ),
  requestBody: Schema.optionalKey(
    Schema.Struct({ required: Schema.optionalKey(Schema.Boolean), content: Content }),
  ),
  responses: Schema.Struct({
    "200": Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Content) })),
  }),
})

/** The parts of a served OpenAPI document that tools are derived from. */
const Document = Schema.Struct({
  paths: Schema.Record(Schema.String, Schema.Struct({ post: Schema.optionalKey(Operation) })),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, JsonObject) }),
})

const decodeDocument = Schema.decodeUnknownEffect(Document)

const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))

const encodeText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const COMMAND_ID_PARAMETER = "idempotency-key"

const REFERENCE = /"\$ref":"#\/components\/schemas\/([^"]+)"/g

const REFERENCE_TARGET = '"$ref":"#/$defs/$1"'

/** What a tool call's `input` argument carries. */
export type ToolInput = "none" | "optional" | "required"

/** The served member a tool runs. */
export interface ToolRoute {
  readonly definition: ServedDefinition
  readonly member: ServedMember
}

/** One MCP tool with the arguments its OpenAPI operation takes. */
export interface McpTool {
  readonly name: string
  /** The tool as `tools/list` describes it. */
  readonly descriptor: Schema.JsonObject
  /** Whether the tool declares an output schema, so its result carries structured content. */
  readonly structured: boolean
  /** The member the tool runs; absent for the tool that mints command ids. */
  readonly route: ToolRoute | undefined
  /** Whether the call names the actor, which every operation with an `{id}` path parameter needs. */
  readonly takesId: boolean
  /** Whether the call carries a command id, which every operation with an `Idempotency-Key` header needs. */
  readonly takesCommandId: boolean
  readonly input: ToolInput
}

/**
 * A schema a tool can carry alone. A tool list has no document for a `$ref`
 * to resolve against, so the components a schema references, and the ones
 * those reference, move into its `$defs`. A reference is a `$ref` property
 * whose value is a whole string, so scanning the serialized schema finds them
 * all.
 */
const standalone = Effect.fnUntraced(function* (
  schema: Schema.JsonObject,
  components: Readonly<Record<string, Schema.JsonObject>>,
) {
  const names: Array<string> = []
  const pending = [yield* encodeText(schema)]

  for (let index = 0; index < pending.length; index += 1)
    for (const [, name = ""] of pending[index]!.matchAll(REFERENCE)) {
      if (names.includes(name)) continue
      names.push(name)
      pending.push(yield* encodeText(components[name]!))
    }

  const defs = Object.fromEntries(names.map((name) => [name, components[name]!]))
  const carried = names.length === 0 ? schema : Object.assign({}, schema, { $defs: defs })
  const text = yield* encodeText(carried)

  return yield* decodeObject(text.replaceAll(REFERENCE, REFERENCE_TARGET))
}, Effect.orDie)

const toolDescription = (name: string, kind: ServedMember["kind"]) =>
  kind === "query"
    ? `Reads ${name}. It takes no command id and is safe to retry.`
    : `Runs ${name} once per commandId. Retrying with the same commandId and input returns the stored result without running it again; the same commandId with different input is refused, and an expired commandId is never replaced.`

const MINT_DESCRIPTION =
  "Mints a command id. Send it with a command call and reuse it, with the same input, on every retry of that call; a new id is a new operation."

const ID_DESCRIPTION = "The actor's id: the key the served route takes as its `{id}` path segment."

/**
 * The MCP tools of a served OpenAPI document: one per public command,
 * reducer, and query, and one that mints command ids. Each tool takes exactly
 * the parameters and body its operation takes, and its schemas are that
 * operation's, so the two protocols cannot describe a member differently.
 * Internal members have no operation and so no tool.
 */
export const mcpTools = Effect.fnUntraced(function* (options: {
  readonly document: unknown
  readonly basePath: string
  readonly definitions: ReadonlyArray<ServedDefinition>
}) {
  const { paths, components } = yield* decodeDocument(options.document).pipe(Effect.orDie)

  const derive = Effect.fnUntraced(function* (path: string, route: ToolRoute | undefined) {
    const operation = paths[path]?.post

    if (operation === undefined)
      return yield* Effect.die(
        new Error(`Actor.serve: the OpenAPI document has no POST operation at ${path}`),
      )

    const parameters = operation.parameters ?? []
    const takesId = parameters.some(
      (parameter) => parameter.in === "path" && parameter.name === "id",
    )

    const commandId = parameters.find(
      (parameter) => parameter.in === "header" && parameter.name === COMMAND_ID_PARAMETER,
    )

    const body = operation.requestBody?.content["application/json"]?.schema
    const output = operation.responses["200"]?.content?.["application/json"]?.schema

    const input: ToolInput =
      body === undefined
        ? "none"
        : operation.requestBody?.required === true
          ? "required"
          : "optional"

    const properties: Record<string, Schema.Json> = {}
    const required: Array<string> = []

    if (takesId) {
      properties["id"] = { type: "string", description: ID_DESCRIPTION }
      required.push("id")
    }

    if (commandId !== undefined) {
      properties["commandId"] = {
        type: "string",
        description: commandId.schema?.description ?? "The command id.",
      }
      required.push("commandId")
    }

    if (body !== undefined) properties["input"] = body

    if (input === "required") required.push("input")

    const name =
      route === undefined ? MINT_OPERATION : `${route.definition.name}.${route.member.tag}`
    const isQuery = route?.member.kind === "query"

    const base = {
      name,
      description:
        route === undefined ? MINT_DESCRIPTION : toolDescription(name, route.member.kind),
      inputSchema: yield* standalone(
        { type: "object", properties, required, additionalProperties: false },
        components.schemas,
      ),
      annotations: { readOnlyHint: isQuery, idempotentHint: route !== undefined },
    }

    const descriptor =
      output === undefined
        ? base
        : Object.assign({}, base, { outputSchema: yield* standalone(output, components.schemas) })

    const tool: McpTool = {
      name,
      descriptor,
      structured: output !== undefined,
      route,
      takesId,
      takesCommandId: commandId !== undefined,
      input,
    }

    return tool
  })

  const tools = [yield* derive(`${options.basePath}/command-ids`, undefined)]

  for (const definition of options.definitions)
    for (const member of definition.members) {
      const path = `${options.basePath}${memberPath({ definition, member })}`

      tools.push(yield* derive(path.replace(":id", "{id}"), { definition, member }))
    }

  return tools
})
