# ADR 0060: Generated protocols: an MCP endpoint and a Python client derived from the served OpenAPI document

**Status:** proposed (2026-09-30). It gates M6.6 ([#337](https://github.com/Rika-Labs/akter/issues/337)) and is the fifth item of [ADR 0014](0014-adoption-observation-and-client-reach.md)'s order. It builds on [ADR 0027](0027-served-protocol.md) without changing its wire. When accepted it amends rule 41, the [server API](../api/01-server-api.md), [generating clients](../api/05-generated-clients.md), and the [post-foundation sketch](../api/post-foundation-sketches.md).

**Responsibility:** decide how an MCP endpoint and a Python client are derived from a served application, so that they agree with HTTP and OpenAPI on schemas, member names, errors, and command identity.

**Authority:** design decision record.

**Owner role:** SDK/protocol.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0027](0027-served-protocol.md) fixes one route per public member, a client-minted command id in `Idempotency-Key`, typed error bodies, and an OpenAPI 3.1 document derived from the same `HttpApi` as the routes. [ADR 0014](0014-adoption-observation-and-client-reach.md) decided that public members may derive MCP and non-Effect clients from the same schemas, that internal commands stay absent from every derivation, and that an MCP tool call must preserve command identity across retries. [M6.6](../milestones/M6.md) names two deliverables, an MCP endpoint and a Python client, and one check, **Generated protocols**. What is left open:

- **Where MCP comes from.** A second description of each member would drift from OpenAPI. The rule no AI-only surface also forbids `Actor.mcp`, tool or prompt options, and MCP glue as written, while the [vision](../vision/06-developer-experience.md) says MCP is a transport, not an AI runtime.
- **Which MCP revision.** The current revision, 2026-07-28, dropped the `initialize` handshake, protocol sessions, and the standalone GET stream. Every request names its protocol version in `_meta` and in the `MCP-Protocol-Version` header, and `server/discover` replaces negotiation. That matches a stateless served protocol.
- **Command identity.** An MCP client has a JSON-RPC request id and possibly a transport event id, neither of which is stable across a retry that a client makes after losing a reply.
- **The Python client.** Which package it lives in, what is generated and what is fixed, and how it is tested.

## Decision

### 1. MCP is a transport of `Actor.serve`, derived from the OpenAPI document

`Actor.serve({ …, mcp: { path, name?, version? } })` adds one endpoint at `{basePath}{path}`, off unless given, beside `openapi`. It is a route of the served protocol, like `/protocol`, not an API of its own: there is no `Actor.mcp`, no tool, prompt, or agent option, and no annotation a definition can add. Its tools are computed at startup from the same OpenAPI document that `openapi.path` serves, so a member has one description. `mcp.path` may not take a protocol route, an `/actors` path, or `openapi.path`.

Rule 41 is amended to allow this one option and no other MCP surface: a framework feature that exists only for LLM consumers is still a violation, and MCP here is the same members over a second wire.

### 2. Only the 2026-07-28 revision, stateless, over Streamable HTTP

- One endpoint accepting `POST`; `GET` and `DELETE` answer `405` with `allow: POST`. There are no sessions, no `Mcp-Session-Id`, no server-initiated stream, and no `subscriptions/listen`.
- A request carries `MCP-Protocol-Version`, `Mcp-Method`, and, for `tools/call`, `Mcp-Name` (plain, or in the `=?base64?…?=` sentinel form). A missing header, or one that disagrees with the body, is `400` with JSON-RPC `-32020`; a version other than `2026-07-28` is `400` with `-32022` and `data.supported`; a request without `_meta` version and client capabilities is `400` with `-32602`; an unknown method is `404` with `-32601`. A notification is `202` with no body. A body that is not one JSON-RPC request is `400` with `-32700` or `-32600`. Earlier revisions are not served.
- Methods: `server/discover` (supported versions, `tools` capability, server info, `ttlMs: 0`, `cacheScope: "public"`), `tools/list`, and `tools/call`. No pagination, so a `cursor` is `-32602`. Resources and prompts are not served: a query takes input, and a resource is addressed by URI alone, so a resource per query cannot carry it.
- Responses are always one `application/json` body; an accepted command continues if the client disconnects, as over HTTP.

### 3. Tools: one per public command, reducer, and query, named by operation id

- The tool name is the OpenAPI `operationId`, `<Actor>.<Member>`, so the name agrees with OpenAPI and the Promise client. `durable.commandIds` is a tool that mints a command id from the database clock, as `POST /command-ids` does. Members reserved or absent from OpenAPI (internal commands, connections, streams, feeds, content) have no tool, and a call to one is `-32602 Unknown tool`, indistinguishable from a name that does not exist.
- `inputSchema` is an object with `id` (the actor's key, when the operation has an `{id}` path parameter), `commandId` (when it has an `Idempotency-Key` header), and `input` (the operation's request body schema, required when its `requestBody` is). Schemas are the operation's own; components an operation references move into the tool's `$defs`. `outputSchema` is the `200` schema, when there is one. `additionalProperties` is false, and an unexpected argument is `InvalidInput`.
- Annotations: `readOnlyHint` for queries, `idempotentHint` for commands and queries. Descriptions state the identity rule below.

### 4. Command identity is the caller's `commandId`

A command tool requires `commandId`, the same `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>` id the HTTP route takes in `Idempotency-Key`. It is minted before the first attempt, with `durable.commandIds`, and reused with the same `input` on every retry. The JSON-RPC id and any transport event id play no part, because nothing guarantees they survive a retry. The id is admitted by the same path as HTTP, so a call retried over either transport replays the stored receipt, and the same id with other input is `CommandConflict`. An expired id is `CommandExpired`; the endpoint never mints a replacement. A command without `commandId` is `InvalidInput { code: "missing_command_id" }`; queries take none.

### 5. The same authentication, authorization, and errors as HTTP

Every request is authenticated per request by the `auth` provider before any JSON-RPC is read, and a failure is the HTTP `401` body, not a JSON-RPC error, so an MCP client and an HTTP client see the same `Unauthorized` codes. Origin, body-size, and credential-size limits, request binding for assertion credentials, and `authorize` are the ones a route uses, because a tool call runs the route's own execution path with the request's principal. A tool result is `200` with `isError: false` and the encoded output as JSON text (and as `structuredContent` when there is an `outputSchema`), or `isError: true` and, as JSON text, exactly the body the route would answer: a declared error, an `ActorError` envelope, or the opaque `Defect { traceId }`. Nothing in an error body differs between the two transports.

### 6. The Python client is generated from the OpenAPI document by `packages/python-client`

`@akter/python-client` reads an OpenAPI document (a file or `GET /openapi.json`) and writes a self-contained Python package with the standard library only: dataclass models for the document's schemas, one method per operation named by its operation id, and a runtime that holds what OpenAPI cannot say and the [generating clients](../api/05-generated-clients.md) guide already requires: minting ids from `GET /protocol`, the same id and body on every retry, the retry table, and decoding error bodies into exceptions that carry the declared tag and fields. Stdlib only means the client runs wherever Python 3.9 or later does. The runtime is not generated: `python/runtime.py` is copied verbatim into each generated package as `_runtime.py`, and its tests, `python/test_runtime.py`, run against a real local HTTP server. The generator is TypeScript (`bun packages/python-client/src/main.ts <openapi.json or URL> --out <dir> --name <package>`); the package needs no structure exemption, since the checker reads TypeScript and `package.json`, and the Python files sit beside their tests. The Python tests use `unittest`, run by `python3 -m unittest` (Verify's runners have Python but not uv), and also run under `uv run --no-project --with pytest python -m pytest` through the package's `pyproject.toml`.

Behavior of the runtime, from the [generating clients](../api/05-generated-clients.md) guide: it reads `GET /protocol` once and mints `v1` ids from the corrected server clock, a second behind it; it sends one id and one body on every attempt; it retries 503, 429, 504, lost replies, `InvalidCommandId` `future`, and, once with a fresh credential from a callable `token`, `401 expired`, with the table's waits and jitter, and stops when the id expires within a second; and it raises `CommandExpired`, `CommandConflict`, and every other framework reason as its own exception, a declared failure as `DeclaredError` with its `tag` and body, and a defect as `Defect`. Read-your-writes tokens (`durable-min-version`) and streams, feeds, connections, and content are not part of the Python client.

## Alternatives

- **A hand-written tool list.** Rejected: it would drift from OpenAPI, and the check's point is that they cannot.
- **Serving the earlier handshake revisions as well.** Rejected: dual-era code for clients that can upgrade, and this repository takes no compatibility layers.
- **Taking the command id from the JSON-RPC id or a transport event id.** Rejected by ADR 0014: neither is stable across a retry.
- **Server-minted ids for a call without one.** Rejected as in ADR 0027: a caller that lost the reply could not retry it.
- **MCP resources for queries.** Rejected above.
- **`Actor.mcp({ tools })`.** Rejected: it invites a second description and is what rule 41 exists to prevent.
- **A hosted Python package with a hand-written client.** Rejected: hand-written Python SDKs are out of scope (M3), and a generated one cannot drift.

## Consequences

- **No migration and no new wire for HTTP.** The refactor shares one execution path between a member route and a tool call, so the statement count per command is unchanged.
- **Tool lists are per deployment and public-shaped.** The list never varies per caller, and the schemas are the ones `/openapi.json` already publishes, so `server/discover` and `tools/list` are cacheable and reveal nothing new. They are still authenticated.
- **A client that needs a stateful MCP revision cannot use this endpoint.** It should use OpenAPI or the Promise client.
- **Rule 41 changes.** A reviewer flags an MCP option other than `serve.mcp`, and any tool-, prompt-, or agent-shaped framework surface.

## Evidence required

`conformance/protocols.ts` runs on PGlite and Postgres against a real Bun listener:

- `lists every public command, reducer, and query as a tool with its OpenAPI operation's parameters and schemas, and no internal member`
- `answers server/discover with the supported revision and the tools capability`
- `runs a command once per command id across MCP and HTTP, and refuses a reused id with other input on either`
- `answers declared and framework failures with the same bodies as HTTP, and never mints a replacement for an expired id`
- `answers a defect with the opaque Defect body, and a caller's own principal is the only one a tool call runs as`
- `fails missing, invalid, and expired credentials with the HTTP body before any JSON-RPC, and applies authorize to tool calls`
- `refuses a request whose protocol headers are missing or disagree with its body, an unsupported revision, or an unknown method, tool, or internal member, before any turn`
- `accepts a notification with 202, refuses GET and DELETE with 405, and answers a body that is not one JSON-RPC request with a JSON-RPC error`
- `answers queries, void commands, singletons, and minted actors like their routes, and refuses arguments a tool does not take`
- `fails Actor.serve at startup when mcp.path collides with a protocol route or the OpenAPI path`

The Python client's cases run in `packages/python-client`, whose dependency on the framework is one-way (a dev dependency), so they are not in `conformance/protocols.ts`; the ledger names them as part of the same check. `src/generate.test.ts` generates a client from a real `Actor.serve` document (with `basePath`) and runs it in Python against a real Bun listener:

- `names one method per public member by its OpenAPI operation id, and none for an internal member`
- `compiles and types every schema the public members use`
- `runs a command once per command id against a real server, replays it, and refuses reuse with other input` (replay, `CommandConflict`, `CommandExpired`, a declared error, and missing and invalid credentials)
- `answers queries, void commands, singletons, and per-token principals like the routes`
- `retries a command whose reply was lost with the same id, and the server runs it once`
- `refuses a package name that is not a Python module name, and a document without protocol routes`

`python/test_runtime.py` covers the runtime against a scripted server: id format and clock, one id and body across `503`, `429`, `504`, lost replies, and `future`; the fresh credential once; never retrying `410`, `409`, or missing credentials; stopping before the id expires without minting another; a caller-supplied id used verbatim; queries without an id; and declared, defect, and unknown bodies.

## Revisit conditions

Revisit when a supported MCP client needs resources, prompts, or subscriptions, when MCP adds a stable operation identity of its own, or when a second generated language client makes a shared generator worthwhile.
