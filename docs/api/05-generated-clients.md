# Generating clients

**Responsibility:** explain how to call a served actor from a client generated in any language.  
**Authority:** API guidance.  
**Owner role:** API/SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

`Actor.serve` with `openapi: { path: "/openapi.json" }` serves an OpenAPI 3.1 document (JSON Schema 2020-12) generated from the served actors. Any OpenAPI 3.1 generator can produce a client from it, for example:

```sh
curl -s localhost:3000/openapi.json > openapi.json
npx @openapitools/openapi-generator-cli generate -i openapi.json -g python -o chat-client
```

Each actor member is one operation with `operationId` `<Actor>.<Member>`. `durable.protocol` (`GET /protocol`) and `durable.commandIds` (`POST /command-ids`) are the protocol routes.

## Command ids

Every command requires an `Idempotency-Key` header, the command id `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`. The server never mints one for a command, because a client that lost the reply to a server-minted id could not retry it.

- Mint an id before the first attempt, either with `POST /command-ids` (authenticated like a command; answers `{ commandId }` from the database clock and writes nothing) or locally from `GET /protocol`'s `now` and `retryWindowMs`, with a fresh UUIDv4.
- Store the id with the pending operation, and send the same id and the same body on every retry. The same id with the same body returns the stored result without running the command again; the same id with a different body is `409 CommandConflict`.
- The response echoes the id in `x-request-id`.
- An id older than the retry window is `410 CommandExpired`: surface it to the caller rather than minting a replacement, because an earlier attempt may have committed.

## Retries

Error bodies are `{ _tag: "ActorError", reason, isRetryable, retryAfter? }`. Retry with the same id, never a new one:

| Outcome                                                             | Retry with the same id?                   | Wait                                                 |
| ------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `503 ActorUnavailable`, `503 RunnerAtCapacity`, `429 MailboxFull`   | yes                                       | `retryAfter` ms (`retry-after` in seconds), jittered |
| `504 Timeout`                                                       | yes; the turn may have committed          | 0–250 ms of jitter                                   |
| no response (network failure)                                       | yes; the outcome is unknown               | exponential, from 100 ms, capped at 5 s, with jitter |
| `400 InvalidCommandId` with code `future`                           | yes, once `durable-now` passes `issuedAt` | until then                                           |
| `401 Unauthorized` with code `expired`                              | once, with a fresh credential             | none                                                 |
| `410 CommandExpired`                                                | no; surface it, never remint              | –                                                    |
| `409`, other `400`, `401`, `403`, `404`, `413`, `415`, `422`, `500` | no                                        | –                                                    |

Stop retrying once the id's `expiresAt` is less than a second away on the client's clock corrected by `durable-now`.

Queries take no `Idempotency-Key` and can be retried freely.

## Authentication

The document's `securitySchemes` come from the server's auth provider, and every operation except `durable.protocol` lists them as alternatives, any one of which authenticates:

| Scheme   | Provider                                                        | Send                                                   |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| `bearer` | `Actor.auth.jwt` (`bearerFormat: JWT`), `Actor.auth.make`       | `authorization: Bearer <token>`                        |
| `cookie` | `Actor.auth.make({ cookies: { name } })`, an `apiKey` in cookie | the cookie `name`, as a browser or cookie jar sends it |

A server under `Actor.auth.none` declares no schemes. Never put a credential in the URL. A `401` carries `www-authenticate: Bearer` whatever the scheme.

## MCP

`Actor.serve` with `mcp: { path: "/mcp" }` serves the same members as MCP tools, derived from the same OpenAPI document ([ADR 0058](../decisions/0058-generated-protocols-mcp-and-python-client.md)). The endpoint speaks MCP revision 2026-07-28 over Streamable HTTP and nothing earlier: send each JSON-RPC message as its own `POST` with `MCP-Protocol-Version`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name` headers, and the protocol version and client capabilities in `params._meta`. Send the same credentials as any route.

- Tool names are operation ids, `<Actor>.<Member>`. `durable.commandIds` mints a command id.
- Arguments: `id` (the actor's key; absent for a singleton), `commandId` (commands and reducers only), and `input`.
- A command's `commandId` is the same id `Idempotency-Key` carries. Mint it once with `durable.commandIds`, keep it with the pending call, and send it with the same `input` on every retry. The JSON-RPC `id` is not a command id and may change on each attempt. A call retried over HTTP with the same id replays the same receipt.
- A result is `isError: false` with the output as JSON text (and as `structuredContent` when the tool has an `outputSchema`), or `isError: true` with the text holding exactly the error body of the HTTP route: a declared error, `{ _tag: "ActorError", reason, isRetryable, retryAfter? }`, or `{ _tag: "Defect", traceId }`. The retry table above applies to `isRetryable` and `retryAfter`. Failed authentication is an HTTP `401` with the `Unauthorized` body, not a JSON-RPC error.
- Internal commands, connections, streams, feeds, and content have no tool, and a call to one is `-32602 Unknown tool`.

## Python

`packages/python-client` generates a Python 3.9+ package, using only the standard library, from an OpenAPI document ([ADR 0058](../decisions/0058-generated-protocols-mcp-and-python-client.md)):

```sh
bun packages/python-client/src/main.ts http://localhost:8080/openapi.json --out ./clients --name chat_client
```

The package has `models.py` (a `TypedDict` for every schema the public members use), `client.py` (one class per actor, one method per public command, reducer, and query, in snake case), and `_runtime.py`, the fixed runtime that holds the command-id rules above.

```python
from chat_client import Client, CommandExpired, DeclaredError

client = Client("http://localhost:8080", token=lambda: current_token())
key = client.mint_command_id()
client.room.post("room-1", {"body": "hi"}, command_id=key)
client.room.post("room-1", {"body": "hi"}, command_id=key)  # replays the stored result
client.room.recent("room-1", {"limit": 20})
```

- `base_url` is the origin: each method carries its full path, `basePath` included. A method takes the actor id (unless the actor is a singleton), the input (unless the member has none), and, for commands, a keyword-only `command_id`. Without one, the runtime mints an id and keeps it across every retry of that call. Keep an id you mint yourself with the pending operation.
- `token` is a bearer string or a function called before every attempt; a command refused with `401 expired` is retried once, with a fresh call to it and the same id.
- Failures are exceptions: framework reasons are `ActorError` subclasses (`CommandExpired`, `CommandConflict`, `Unauthorized`, ...) with `tag`, `code`, `status`, `is_retryable`, and `retry_after_ms`; a declared failure is `DeclaredError` with `tag` and `body` (`DECLARED_ERRORS` maps each operation to its tags); a defect is `Defect` with `trace_id`; no reply after every attempt is `TransportError`. `CommandExpired` is raised, never replaced.
- `OPERATIONS` maps each operation id to its attribute and method, so the names agree with OpenAPI and the other clients. Internal commands, streams, feeds, connections, and content have no method.
- Not included: `durable-min-version` read-your-writes tokens.
