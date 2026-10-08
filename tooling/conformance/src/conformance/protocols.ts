import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpRouter } from "effect/http"
import { Unauthorized } from "../../../../packages/akter/src/index.ts"
import { InvalidInput } from "../../../../packages/akter/src/errors/actor.ts"
import { CommandConflict, CommandExpired } from "../../../../packages/akter/src/errors/actor.ts"
import { InternalActors } from "../../../../packages/akter/src/runtime/actors.ts"
import { MCP_VERSION } from "../../../../packages/akter/src/serve/mcp/endpoint.ts"
import type { ConformanceCase, ConformanceSuite } from "../conformance.ts"
import {
  envelope,
  HttpLobby,
  HttpRoom,
  isDefectBody,
  reasonOf,
  receipts,
  runs,
  type Server,
  serveHttp,
  tenantOf,
  tokens,
  httpSuite,
} from "./http.ts"
import { serve } from "../../../../packages/akter/src/serve/layer.ts"

const options = { openapi: { path: "/openapi.json" }, mcp: { path: "/mcp" } } as const

const META = {
  "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const Content = Schema.Struct({
  "application/json": Schema.optionalKey(Schema.Struct({ schema: Schema.Json })),
})

const Spec = Schema.Struct({
  paths: Schema.Record(
    Schema.String,
    Schema.Record(
      Schema.String,
      Schema.Struct({
        operationId: Schema.String,
        "x-durable-transport": Schema.optionalKey(Schema.String),
        parameters: Schema.optionalKey(
          Schema.Array(Schema.Struct({ name: Schema.String, in: Schema.String })),
        ),
        requestBody: Schema.optionalKey(Schema.Struct({ content: Content })),
        responses: Schema.Struct({
          "200": Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Content) })),
        }),
      }),
    ),
  ),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Json) }),
})

const ToolList = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.String,
    ttlMs: Schema.Int,
    cacheScope: Schema.String,
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Struct({
          type: Schema.String,
          properties: Schema.Record(Schema.String, Schema.Json),
          required: Schema.Array(Schema.String),
          additionalProperties: Schema.Boolean,
          $defs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
        }),
        outputSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          idempotentHint: Schema.Boolean,
        }),
      }),
    ),
  }),
})

const ToolReply = Schema.Struct({
  result: Schema.Struct({
    resultType: Schema.Literal("complete"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    isError: Schema.optionalKey(Schema.Boolean),
    structuredContent: Schema.optionalKey(Schema.Json),
  }),
})

const RpcError = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Int,
    message: Schema.String,
    data: Schema.optionalKey(Schema.Json),
  }),
})

interface RpcCall {
  readonly token?: string | undefined
  readonly method: string
  readonly params?: Schema.JsonObject
  readonly headers?: Readonly<Record<string, string>>
}

const rpc = (server: Server, call: RpcCall) =>
  server.send("/mcp", {
    token: call.token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: call.method,
      params: Object.assign({}, call.params, { _meta: META }),
    },
    headers: { "mcp-protocol-version": MCP_VERSION, "mcp-method": call.method, ...call.headers },
  })

/** One `tools/call`, with its text content decoded as the JSON it carries. */
const callTool = Effect.fnUntraced(function* (
  server: Server,
  token: string | undefined,
  name: string,
  args: Schema.JsonObject,
) {
  const reply = yield* rpc(server, {
    token,
    method: "tools/call",
    params: { name, arguments: args },
    headers: { "mcp-name": name },
  })

  const { result } = yield* Schema.decodeUnknownEffect(ToolReply)(reply.body).pipe(Effect.orDie)
  const text = result.content[0]?.text

  return {
    status: reply.status,
    isError: result.isError === true,
    empty: result.content.length === 0,
    text,
    body: text === undefined ? undefined : yield* decodeJson(text).pipe(Effect.orDie),
    structured: result.structuredContent,
  }
})

const rpcError = Effect.fnUntraced(function* (reply: { readonly body: Schema.Json | undefined }) {
  const { error } = yield* Schema.decodeUnknownEffect(RpcError)(reply.body).pipe(Effect.orDie)

  return error
})

const mint = Effect.fnUntraced(function* (server: Server, token: string) {
  const minted = yield* callTool(server, token, "durable.commandIds", {})

  return yield* Schema.decodeUnknownEffect(Schema.Struct({ commandId: Schema.String }))(
    minted.body,
  ).pipe(
    Effect.map(({ commandId }) => commandId),
    Effect.orDie,
  )
})

type FailingCall = {
  readonly id: string
  readonly commandId: string
  readonly input: Schema.Json
}

const mcpConformanceOptions = options

export const protocolsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "lists every public command, reducer, and query as a tool with its OpenAPI operation's parameters and schemas, and no internal member",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const token = `${yield* tenantOf}:alice`

          const spec = yield* server.send("/openapi.json", { method: "GET" }).pipe(
            Effect.flatMap((reply) => Schema.decodeUnknownEffect(Spec)(reply.body)),
            Effect.orDie,
          )

          const listed = yield* rpc(server, { token, method: "tools/list" }).pipe(
            Effect.flatMap((reply) => Schema.decodeUnknownEffect(ToolList)(reply.body)),
            Effect.orDie,
          )

          expect(listed.result).toMatchObject({ resultType: "complete", ttlMs: 0 })
          expect(listed.result.cacheScope).toBe("public")

          const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
            methods["post"] !== undefined &&
            methods["post"]["x-durable-transport"] === undefined &&
            (path.startsWith("/actors/") || methods["post"].operationId === "durable.commandIds")
              ? [{ path, operation: methods["post"] }]
              : [],
          )

          expect(listed.result.tools.map((tool) => tool.name)).toEqual(
            operations.map(({ operation }) => operation.operationId),
          )

          expect(listed.result.tools.map((tool) => tool.name)).not.toContain("HttpRoom.Secret")

          for (const { path, operation } of operations) {
            const tool = listed.result.tools.find(
              (candidate) => candidate.name === operation.operationId,
            )!

            const parameters = operation.parameters ?? []
            const body = operation.requestBody?.content["application/json"]?.schema
            const success = operation.responses["200"]?.content?.["application/json"]?.schema

            expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(
              [
                ...(path.includes("{id}") ? ["id"] : []),
                ...(parameters.some((parameter) => parameter.name === "idempotency-key")
                  ? ["commandId"]
                  : []),
                ...(body === undefined ? [] : ["input"]),
              ].sort(),
            )

            expect(tool.inputSchema.type).toBe("object")
            expect(tool.inputSchema.additionalProperties).toBe(false)
            expect(tool.inputSchema.required).toEqual([
              ...(path.includes("{id}") ? ["id"] : []),
              ...(parameters.some((parameter) => parameter.name === "idempotency-key")
                ? ["commandId"]
                : []),
              ...(body === undefined ? [] : ["input"]),
            ])

            if (body !== undefined && tool.inputSchema.$defs === undefined)
              expect(tool.inputSchema.properties["input"]).toEqual(body)

            if (
              success !== undefined &&
              tool.outputSchema !== undefined &&
              tool.outputSchema["$defs"] === undefined
            )
              expect(tool.outputSchema).toEqual(success)

            expect(tool.outputSchema === undefined).toBe(success === undefined)
            expect(tool.annotations.readOnlyHint).toBe(
              path.endsWith("/Count") ||
                path.endsWith("/Peek") ||
                path.endsWith("/Snapshot") ||
                path.endsWith("/Level"),
            )
          }

          const named = listed.result.tools.find((tool) => tool.name === "HttpRoom.Post")!
          expect(named.inputSchema.required).toEqual(["id", "commandId", "input"])
          expect(named.annotations).toEqual({ readOnlyHint: false, idempotentHint: true })

          const lobby = listed.result.tools.find((tool) => tool.name === "HttpLobby.Join")!
          expect(lobby.inputSchema.required).toEqual(["commandId"])

          const mintTool = listed.result.tools.find((tool) => tool.name === "durable.commandIds")!
          expect(mintTool.inputSchema.properties).toEqual({})
          expect(mintTool.annotations).toEqual({ readOnlyHint: false, idempotentHint: false })
        }),
      ),
  },
  {
    name: "answers server/discover with the supported revision and the tools capability",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ mcp: { path: "/mcp", name: "rooms", version: "7" } })
          const token = `${yield* tenantOf}:alice`
          const reply = yield* rpc(server, { token, method: "server/discover" })

          expect(reply.status).toBe(200)
          expect(reply.body).toMatchObject({
            jsonrpc: "2.0",
            id: 1,
            result: {
              resultType: "complete",
              supportedVersions: [MCP_VERSION],
              capabilities: { tools: {} },
              cacheScope: "public",
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "rooms", version: "7" } },
            },
          })
        }),
      ),
  },
  {
    name: "runs a command once per command id across MCP and HTTP, and refuses a reused id with other input on either",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const commandId = yield* mint(server, token)
          const before = runs.count

          const first = yield* callTool(server, token, "HttpRoom.Post", {
            id: "shared",
            commandId,
            input: { text: "a" },
          })

          expect(first).toMatchObject({ isError: false, body: 1, structured: 1 })
          expect(runs.count).toBe(before + 1)

          const overHttp = yield* server.send("/actors/HttpRoom/shared/Post", {
            token,
            key: commandId,
            body: { text: "a" },
          })

          expect(overHttp).toMatchObject({ status: 200, body: 1 })

          const again = yield* callTool(server, token, "HttpRoom.Post", {
            id: "shared",
            commandId,
            input: { text: "a" },
          })

          expect(again).toMatchObject({ isError: false, body: 1 })
          expect(runs.count).toBe(before + 1)
          expect(yield* receipts(tenant, "HttpRoom", "shared")).toBe(1)

          const conflict = yield* callTool(server, token, "HttpRoom.Post", {
            id: "shared",
            commandId,
            input: { text: "b" },
          })

          const conflictOverHttp = yield* server.send("/actors/HttpRoom/shared/Post", {
            token,
            key: commandId,
            body: { text: "b" },
          })

          expect(conflict.isError).toBe(true)
          expect(conflict.body).toEqual(yield* envelope(CommandConflict.make({ commandId })))
          expect(conflict.body).toEqual(conflictOverHttp.body)
          expect(runs.count).toBe(before + 1)
        }),
      ),
  },
  {
    name: "answers declared and framework failures with the same bodies as HTTP, and never mints a replacement for an expired id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const actors = yield* InternalActors
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`

          for (const [text, status] of [
            ["full", 422],
            ["closed", 423],
          ] as const) {
            const overHttp = yield* server.send(`/actors/HttpRoom/${text}-http/Post`, {
              token,
              key: yield* server.mint(),
              body: { text },
            })

            const overMcp = yield* callTool(server, token, "HttpRoom.Post", {
              id: `${text}-mcp`,
              commandId: yield* mint(server, token),
              input: { text },
            })

            expect(overHttp.status).toBe(status)
            expect(overMcp.isError).toBe(true)
            expect(overMcp.body).toEqual(overHttp.body)
          }

          const before = runs.count
          const expired = yield* server.mint(-actors.retryWindowMs - 1)

          const cases: ReadonlyArray<FailingCall> = [
            { id: "failures", commandId: expired, input: { text: "a" } },
            { id: "failures", commandId: "v1.not-an-id", input: { text: "a" } },
            { id: "failures", commandId: yield* server.mint(60 * 60_000), input: { text: "a" } },
            { id: "failures", commandId: yield* server.mint(), input: { text: 5 } },
            { id: "failures", commandId: yield* server.mint(), input: {} },
          ]

          for (const arguments_ of cases) {
            const overHttp = yield* server.send(`/actors/HttpRoom/${arguments_.id}/Post`, {
              token,
              key: arguments_.commandId,
              body: arguments_.input,
            })

            const overMcp = yield* callTool(server, token, "HttpRoom.Post", arguments_)

            expect(overHttp.status >= 400).toBe(true)
            expect(overMcp.isError).toBe(true)
            expect(overMcp.body).toEqual(overHttp.body)
          }

          const expiredOverMcp = yield* callTool(server, token, "HttpRoom.Post", cases[0]!)
          expect(expiredOverMcp.body).toEqual(
            yield* envelope(CommandExpired.make({ commandId: expired })),
          )

          const withoutId = yield* callTool(server, token, "HttpRoom.Post", {
            id: "failures",
            input: { text: "a" },
          })

          const withoutKey = yield* server.send("/actors/HttpRoom/failures/Post", {
            token,
            body: { text: "a" },
          })

          expect(withoutId.body).toEqual(withoutKey.body)
          expect(yield* reasonOf(withoutId.body)).toEqual({
            tag: "InvalidInput",
            code: "missing_command_id",
          })
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "failures")).toBe(0)
        }),
      ),
  },
  {
    name: "answers a defect with the opaque Defect body, and a caller's own principal is the only one a tool call runs as",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const tenant = yield* tenantOf

          const crash = yield* callTool(server, `${tenant}:alice`, "HttpRoom.Crash", {
            id: "defect",
            commandId: yield* mint(server, `${tenant}:alice`),
          })

          expect(crash.isError).toBe(true)
          expect(isDefectBody(crash.body)).toBe(true)
          expect(Object.keys(crash.body as object).sort()).toEqual(["_tag", "traceId"])
          expect(crash.text?.includes("secret")).toBe(false)
          expect(yield* receipts(tenant, "HttpRoom", "defect")).toBe(0)

          for (const subject of ["alice", "bob"]) {
            const token = `${tenant}:${subject}`

            const whoami = yield* callTool(server, token, "HttpRoom.Whoami", {
              id: "principals",
              commandId: yield* mint(server, token),
            })

            expect(whoami.body).toBe(`${tenant}/${subject}`)
          }

          const smuggled = yield* callTool(server, `${tenant}:alice`, "HttpRoom.Whoami", {
            id: "principals",
            commandId: yield* mint(server, `${tenant}:alice`),
            tenant: "other",
          })

          expect(smuggled.isError).toBe(true)

          expect(smuggled.body).toEqual(
            yield* envelope(
              InvalidInput.make({
                code: "decode",
                issues: [{ path: "tenant", message: "Unexpected key" }],
              }),
            ),
          )
        }),
      ),
  },
  {
    name: "fails missing, invalid, and expired credentials with the HTTP body before any JSON-RPC, and applies authorize to tool calls",
    run: ({ expect, environment, access }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const before = runs.count

          for (const [credential, code] of [
            [undefined, "missing_credentials"],
            ["no-colon", "invalid_credentials"],
            ["expired", "expired"],
          ] as const) {
            const reply = yield* rpc(server, { token: credential, method: "server/discover" })

            expect(reply.status).toBe(401)
            expect(reply.headers.get("www-authenticate")).toBe("Bearer")
            expect(reply.body).toEqual(yield* envelope(Unauthorized.make({ code })))
          }

          expect(runs.count).toBe(before)

          const commandId = yield* mint(server, token)

          access.denied.add("Post")
          access.denied.add("Count")

          const denied = yield* Effect.gen(function* () {
            const command = yield* callTool(server, token, "HttpRoom.Post", {
              id: "denied",
              commandId,
              input: { text: "a" },
            })

            const overHttp = yield* server.send("/actors/HttpRoom/denied/Post", {
              token,
              key: commandId,
              body: { text: "a" },
            })

            const query = yield* callTool(server, token, "HttpRoom.Count", { id: "denied" })

            return { command, overHttp, query }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                access.denied.clear()
              }),
            ),
          )

          const accessDenied = yield* envelope(Unauthorized.make({ code: "access_denied" }))

          expect(denied.command).toMatchObject({ isError: true, body: accessDenied })
          expect(denied.overHttp.body).toEqual(accessDenied)
          expect(denied.query).toMatchObject({ isError: true, body: accessDenied })
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "denied")).toBe(0)
        }),
      ),
  },
  {
    name: "refuses a request whose protocol headers are missing or disagree with its body, an unsupported revision, or an unknown method, tool, or internal member, before any turn",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const before = runs.count

          const call = (name: string, extra: Schema.JsonObject = {}) => ({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: Object.assign({ name, arguments: { id: "headers" }, _meta: META }, extra),
          })

          const headers = {
            "mcp-protocol-version": MCP_VERSION,
            "mcp-method": "tools/call",
            "mcp-name": "HttpRoom.Count",
          }

          const refusals = [
            [{ "mcp-method": headers["mcp-method"], "mcp-name": headers["mcp-name"] }, -32020],
            [{ ...headers, "mcp-protocol-version": "2025-11-25" }, -32020],
            [{ ...headers, "mcp-method": "tools/list" }, -32020],
            [{ ...headers, "mcp-name": "HttpRoom.Peek" }, -32020],
            [{ "mcp-protocol-version": MCP_VERSION, "mcp-method": "tools/call" }, -32020],
          ] as const

          for (const [sent, code] of refusals) {
            const reply = yield* server.send("/mcp", {
              token,
              body: call("HttpRoom.Count"),
              headers: sent,
            })

            expect(reply.status).toBe(400)
            expect((yield* rpcError(reply)).code).toBe(code)
          }

          const unsupported = yield* server.send("/mcp", {
            token,
            body: call("HttpRoom.Count", {
              _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
            }),
            headers: { ...headers, "mcp-protocol-version": "2099-01-01" },
          })

          expect(unsupported.status).toBe(400)

          expect(yield* rpcError(unsupported)).toMatchObject({
            code: -32022,
            data: { supported: [MCP_VERSION], requested: "2099-01-01" },
          })

          const incomplete: ReadonlyArray<Schema.JsonObject> = [
            { name: "HttpRoom.Count" },
            {
              name: "HttpRoom.Count",
              _meta: { "io.modelcontextprotocol/protocolVersion": MCP_VERSION },
            },
          ]

          for (const params of incomplete) {
            const reply = yield* server.send("/mcp", {
              token,
              body: { jsonrpc: "2.0", id: 1, method: "tools/call", params },
              headers,
            })

            expect(reply.status).toBe(400)
            expect((yield* rpcError(reply)).code).toBe(-32602)
          }

          const unknownMethod = yield* rpc(server, { token, method: "resources/list" })
          expect(unknownMethod.status).toBe(404)
          expect((yield* rpcError(unknownMethod)).code).toBe(-32601)

          const paged = yield* rpc(server, { token, method: "tools/list", params: { cursor: "x" } })
          expect(paged.status).toBe(400)
          expect((yield* rpcError(paged)).code).toBe(-32602)

          for (const name of ["HttpRoom.Secret", "HttpRoom.Nope"]) {
            const reply = yield* server.send("/mcp", {
              token,
              body: call(name),
              headers: { ...headers, "mcp-name": name },
            })

            expect(reply.status).toBe(400)

            expect(yield* rpcError(reply)).toEqual({
              code: -32602,
              message: `Unknown tool: ${name}`,
            })
          }

          const encoded = yield* server.send("/mcp", {
            token,
            body: call("HttpRoom.Count"),
            headers: {
              ...headers,
              "mcp-name": `=?base64?${Base64.encode("HttpRoom.Count")}?=`,
            },
          })

          expect(encoded.status).toBe(200)
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "headers")).toBe(0)
        }),
      ),
  },
  {
    name: "accepts a notification with 202, refuses GET and DELETE with 405, and answers a body that is not one JSON-RPC request with a JSON-RPC error",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({
            ...mcpConformanceOptions,
            limits: { requestBytes: 4096 },
          })

          const token = `${yield* tenantOf}:alice`

          const notification = yield* server.send("/mcp", {
            token,
            body: { jsonrpc: "2.0", method: "notifications/initialized" },
          })

          expect(notification.status).toBe(202)
          expect(notification.text).toBe("")

          for (const method of ["GET", "DELETE"] as const) {
            const reply = yield* server.send("/mcp", { method, token })

            expect(reply.status).toBe(405)
            expect(reply.headers.get("allow")).toBe("POST")
          }

          const malformed = [
            [{ raw: "{not json" }, -32700],
            [{ raw: "" }, -32700],
            [{ bytes: new Uint8Array([0xff, 0xfe, 0x7b]) }, -32700],
            [{ raw: "[]" }, -32600],
            [{ raw: '{"jsonrpc":"1.0","id":1,"method":"tools/list"}' }, -32600],
            [{ raw: '{"jsonrpc":"2.0","id":1}' }, -32600],
          ] as const

          for (const [body, code] of malformed) {
            const reply = yield* server.send("/mcp", { token, ...body })

            expect(reply.status).toBe(400)
            expect((yield* rpcError(reply)).code).toBe(code)
          }

          const other = yield* server.send("/mcp", {
            token,
            raw: "{}",
            headers: { "content-type": "text/plain" },
          })

          expect(other.status).toBe(415)
          expect(yield* reasonOf(other.body)).toEqual({
            tag: "InvalidInput",
            code: "unsupported_media_type",
          })

          const large = yield* server.send("/mcp", {
            token,
            raw: `{"pad":"${"x".repeat(5000)}"}`,
          })

          expect(large.status).toBe(413)

          const foreign = yield* server.send("/mcp", {
            token,
            body: { jsonrpc: "2.0", id: 1, method: "server/discover" },
            headers: { origin: "https://evil.example" },
          })

          expect(foreign.status).toBe(403)
          expect(yield* reasonOf(foreign.body)).toEqual({
            tag: "InvalidInput",
            code: "origin_not_allowed",
          })
        }),
      ),
  },
  {
    name: "answers queries, void commands, singletons, and minted actors like their routes, and refuses arguments a tool does not take",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp(mcpConformanceOptions)
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`

          const peek = yield* callTool(server, token, "HttpRoom.Peek", { id: "reads" })
          const peekOverHttp = yield* server.send("/actors/HttpRoom/reads/Peek", { token })

          expect(peekOverHttp.body).toBe(null)
          expect(peek).toMatchObject({ isError: false, body: null, structured: null })

          const snapshot = yield* callTool(server, token, "HttpTally.Snapshot", { id: "reads" })
          const snapshotOverHttp = yield* server.send("/actors/HttpTally/reads/Snapshot", { token })

          expect(snapshot.structured).toEqual(snapshotOverHttp.body)
          expect(snapshot.body).toEqual(snapshotOverHttp.body)

          const join = yield* callTool(server, token, "HttpLobby.Join", {
            commandId: yield* mint(server, token),
          })

          expect(join).toMatchObject({ isError: false, body: 1, structured: 1 })

          const leave = yield* callTool(server, token, "HttpLobby.Leave", {
            commandId: yield* mint(server, token),
          })

          expect(leave).toMatchObject({ isError: false, empty: true, structured: undefined })

          const leaveOverHttp = yield* server.send("/actors/HttpLobby/Leave", {
            token,
            key: yield* server.mint(),
          })

          expect(leaveOverHttp.status).toBe(204)

          const unexpected = [
            ["HttpLobby.Join", { id: "x", commandId: yield* mint(server, token) }, "id"],
            ["HttpRoom.Count", { id: "reads", commandId: yield* mint(server, token) }, "commandId"],
            [
              "HttpRoom.Crash",
              { id: "reads", commandId: yield* mint(server, token), input: {} },
              "input",
            ],
            ["durable.commandIds", { id: "x" }, "id"],
          ] as const

          for (const [name, args, path] of unexpected) {
            const reply = yield* callTool(server, token, name, args)

            expect(reply.isError).toBe(true)

            expect(reply.body).toEqual(
              yield* envelope(
                InvalidInput.make({
                  code: "decode",
                  issues: [{ path, message: "Unexpected key" }],
                }),
              ),
            )
          }

          const missing = [
            ["HttpRoom.Count", {}, "id"],
            ["HttpRoom.Post", { id: "reads", commandId: yield* mint(server, token) }, "input"],
          ] as const

          for (const [name, args, path] of missing) {
            const reply = yield* callTool(server, token, name, args)

            expect(reply.body).toEqual(
              yield* envelope(
                InvalidInput.make({ code: "decode", issues: [{ path, message: "Missing key" }] }),
              ),
            )
          }

          const dots = yield* callTool(server, token, "HttpRoom.Count", { id: ".." })
          expect(yield* reasonOf(dots.body)).toEqual({ tag: "InvalidInput", code: "unservable_id" })

          const ticket = yield* callTool(server, token, "HttpTicket.Join", {
            id: "not-a-uuid",
            commandId: yield* mint(server, token),
          })

          const ticketOverHttp = yield* server.send("/actors/HttpTicket/not-a-uuid/Join", {
            token,
            key: yield* server.mint(),
          })

          expect(ticket.isError).toBe(true)
          expect(ticket.body).toEqual(ticketOverHttp.body)
        }),
      ),
  },
  {
    name: "fails Actor.serve at startup when mcp.path collides with a protocol route or the OpenAPI path",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const internal = Layer.succeed(InternalActors, yield* InternalActors)

          for (const path of ["/protocol", "/command-ids", "/ready", "/actors/Room"] as const) {
            const exit = yield* HttpRouter.toHttpEffect(
              serve({ actors: [HttpRoom], auth: tokens, mcp: { path } }).pipe(
                Layer.provide(internal),
              ),
            ).pipe(Effect.exit)

            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
              `mcp.path ${path} collides with a protocol route`,
            )
          }

          const same = yield* HttpRouter.toHttpEffect(
            serve({
              actors: [HttpRoom],
              auth: tokens,
              openapi: { path: "/docs" },
              mcp: { path: "/docs" },
            }).pipe(Layer.provide(internal)),
          ).pipe(Effect.exit)

          expect(Exit.isFailure(same) && Cause.pretty(same.cause)).toContain(
            "mcp.path and openapi.path are both /docs",
          )

          const lobby = yield* HttpRouter.toHttpEffect(
            serve({ actors: [HttpLobby], auth: tokens, mcp: { path: "/mcp" } }).pipe(
              Layer.provide(internal),
            ),
          ).pipe(Effect.exit)

          expect(Exit.isSuccess(lobby)).toBe(true)
        }),
      ),
  },
]

/** Protocol cases call the served HTTP actors. */
export const protocolsSuite: ConformanceSuite = {
  uses: [httpSuite],
}
