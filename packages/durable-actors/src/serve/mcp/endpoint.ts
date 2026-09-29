import { Effect, Encoding, Option, Result, Schema } from "effect"
import { Headers, HttpServerResponse } from "effect/unstable/http"
import { ActorError, InvalidInput } from "../../errors/actor.ts"
import { actorErrorBody, invalidInput, undecodable } from "../wire.ts"
import type { McpTool } from "./tools.ts"

/** The MCP revision this endpoint speaks. */
export const MCP_VERSION = "2026-07-28"

const PARSE_ERROR = -32700

const INVALID_REQUEST = -32600

const METHOD_NOT_FOUND = -32601

const INVALID_PARAMS = -32602

const HEADER_MISMATCH = -32020

const UNSUPPORTED_VERSION = -32022

const VERSION_META = "io.modelcontextprotocol/protocolVersion"

const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"

const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"

const BASE64_SENTINEL = /^=\?base64\?(.*)\?=$/

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

const Message = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

const Params = Schema.Struct({
  _meta: Schema.Struct({
    [VERSION_META]: Schema.String,
    [CAPABILITIES_META]: Schema.Record(Schema.String, Schema.Json),
  }),
})

const ListParams = Schema.Struct({ cursor: Schema.optionalKey(Schema.String) })

const CallParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
})

const Arguments = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  commandId: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Json),
})

const decodeText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const decodeMessage = Schema.decodeUnknownEffect(Message)

const decodeParams = Schema.decodeUnknownEffect(Params)

const decodeListParams = Schema.decodeUnknownEffect(ListParams)

const decodeCallParams = Schema.decodeUnknownEffect(CallParams)

const decodeArguments = Schema.decodeUnknownEffect(Arguments)

/** What a tool call runs with, after its arguments passed the tool's own parameters. */
export interface ToolCall {
  readonly tool: McpTool
  readonly id: string | undefined
  readonly commandId: string | undefined
  readonly input: Schema.Json | undefined
}

/** A tool call's outcome as the same JSON its HTTP route answers: the value on success, an error body otherwise. */
export type ToolResult =
  | { readonly ok: true; readonly value: Schema.Json | undefined }
  | { readonly ok: false; readonly body: Schema.Json }

export interface McpEndpoint {
  readonly tools: ReadonlyArray<McpTool>
  readonly info: { readonly name: string; readonly version: string }
  readonly call: (call: ToolCall) => Effect.Effect<ToolResult>
}

type RpcId = string | number

interface RpcFailure {
  readonly id: RpcId | undefined
  readonly status: number
  readonly code: number
  readonly message: string
  readonly data?: Schema.Json
}

const rpcFailure = (failure: RpcFailure) =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: failure.id ?? null,
      error: { code: failure.code, message: failure.message, data: failure.data },
    },
    { status: failure.status },
  )

const rpcResult = (id: RpcId, result: Schema.JsonObject) =>
  HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id, result })

const mismatch = (id: RpcId, message: string) =>
  rpcFailure({ id, status: 400, code: HEADER_MISMATCH, message: `Header mismatch: ${message}` })

const invalidParams = (id: RpcId, message: string) =>
  rpcFailure({ id, status: 400, code: INVALID_PARAMS, message })

const argumentError = (path: string, message: string) =>
  ActorError.make({ reason: InvalidInput.make({ code: "decode", issues: [{ path, message }] }) })

/** The value a header carries, decoded when a client sent it in the Base64 sentinel form. */
const headerValue = (value: string) => {
  const encoded = BASE64_SENTINEL.exec(value)?.[1]

  if (encoded === undefined) return Option.some(value)

  return Result.match(Encoding.decodeBase64String(encoded), {
    onFailure: () => Option.none(),
    onSuccess: Option.some,
  })
}

/**
 * Checks a call's arguments against the parameters its tool advertises, in
 * the order the HTTP route checks its own: a command without a command id is
 * `missing_command_id`, and every other fault names the argument.
 */
const toolCall = Effect.fnUntraced(function* (
  tool: McpTool,
  args: Readonly<Record<string, Schema.Json>>,
) {
  const allowed = new Set<string>()

  if (tool.takesId) allowed.add("id")

  if (tool.takesCommandId) allowed.add("commandId")

  if (tool.input !== "none") allowed.add("input")

  const unexpected = Object.keys(args).find((key) => !allowed.has(key))

  if (unexpected !== undefined) return yield* argumentError(unexpected, "Unexpected key")

  const { id, commandId, input } = yield* decodeArguments(args).pipe(
    Effect.mapError((error) => undecodable(error)),
  )

  if (tool.takesId && id === undefined) return yield* argumentError("id", "Missing key")

  if (tool.takesCommandId && commandId === undefined)
    return yield* invalidInput("missing_command_id")

  if (tool.input === "required" && input === undefined)
    return yield* argumentError("input", "Missing key")

  return { tool, id, commandId, input } satisfies ToolCall
})

const toolResult = (
  tool: McpTool,
  result: ToolResult,
  _meta: Schema.JsonObject,
): Schema.JsonObject => {
  if (!result.ok)
    return {
      resultType: "complete",
      content: [{ type: "text", text: JSON.stringify(result.body) }],
      isError: true,
      _meta,
    }

  if (result.value === undefined) return { resultType: "complete", content: [], _meta }

  const content = [{ type: "text", text: JSON.stringify(result.value) }]

  return tool.structured
    ? { resultType: "complete", content, structuredContent: result.value, _meta }
    : { resultType: "complete", content, _meta }
}

/**
 * Answers one MCP request over Streamable HTTP for the caller the endpoint's
 * route already authenticated. The revision is stateless: every request names
 * its protocol version, so there is no handshake, session, or stream, and a
 * tool call is one HTTP response. A notification is accepted and ignored.
 */
export const handleMcp = Effect.fnUntraced(function* (
  endpoint: McpEndpoint,
  request: { readonly headers: Headers.Headers; readonly body: Uint8Array },
) {
  const json = yield* Effect.try(() => strictUtf8.decode(request.body)).pipe(
    Effect.flatMap(decodeText),
    Effect.option,
  )

  if (Option.isNone(json))
    return rpcFailure({ id: undefined, status: 400, code: PARSE_ERROR, message: "Parse error" })

  const parsed = yield* decodeMessage(json.value).pipe(Effect.option)

  if (Option.isNone(parsed))
    return rpcFailure({
      id: undefined,
      status: 400,
      code: INVALID_REQUEST,
      message: "Invalid request",
    })

  const message = parsed.value
  const id = message.id

  if (id === undefined) return HttpServerResponse.empty({ status: 202 })

  const meta = yield* decodeParams(message.params ?? {}).pipe(Effect.option)

  if (Option.isNone(meta))
    return invalidParams(id, `Missing ${VERSION_META} or ${CAPABILITIES_META} in _meta`)

  const requested = meta.value._meta[VERSION_META]
  const versionHeader = Headers.get(request.headers, "mcp-protocol-version")

  if (Option.isNone(versionHeader)) return mismatch(id, "MCP-Protocol-Version is required")

  if (versionHeader.value.trim() !== requested)
    return mismatch(id, "MCP-Protocol-Version does not match the request's protocol version")

  if (requested !== MCP_VERSION)
    return rpcFailure({
      id,
      status: 400,
      code: UNSUPPORTED_VERSION,
      message: "Unsupported protocol version",
      data: { supported: [MCP_VERSION], requested },
    })

  const methodHeader = Headers.get(request.headers, "mcp-method")

  if (Option.isNone(methodHeader) || methodHeader.value !== message.method)
    return mismatch(id, "Mcp-Method does not match the request's method")

  const serverInfo = { [SERVER_INFO_META]: endpoint.info }

  if (message.method === "server/discover")
    return rpcResult(id, {
      resultType: "complete",
      supportedVersions: [MCP_VERSION],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: "public",
      _meta: serverInfo,
    })

  if (message.method === "tools/list") {
    const list = yield* decodeListParams(message.params ?? {}).pipe(Effect.option)

    if (Option.isNone(list) || list.value.cursor !== undefined)
      return invalidParams(id, "Invalid params")

    return rpcResult(id, {
      resultType: "complete",
      tools: endpoint.tools.map((tool) => tool.descriptor),
      ttlMs: 0,
      cacheScope: "public",
      _meta: serverInfo,
    })
  }

  if (message.method !== "tools/call")
    return rpcFailure({ id, status: 404, code: METHOD_NOT_FOUND, message: "Method not found" })

  const params = yield* decodeCallParams(message.params ?? {}).pipe(Effect.option)

  if (Option.isNone(params)) return invalidParams(id, "Invalid params")

  const nameHeader = Option.flatMap(Headers.get(request.headers, "mcp-name"), headerValue)

  if (Option.isNone(nameHeader) || nameHeader.value !== params.value.name)
    return mismatch(id, "Mcp-Name does not match the request's tool name")

  const tool = endpoint.tools.find((candidate) => candidate.name === params.value.name)

  if (tool === undefined) return invalidParams(id, `Unknown tool: ${params.value.name}`)

  const call = yield* toolCall(tool, params.value.arguments ?? {}).pipe(Effect.result)

  const result: ToolResult = Result.isFailure(call)
    ? { ok: false, body: yield* actorErrorBody(call.failure) }
    : yield* endpoint.call(call.success)

  return rpcResult(id, toolResult(tool, result, serverInfo))
})
