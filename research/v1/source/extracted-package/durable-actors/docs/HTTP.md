# HTTP boundary

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Use Effect HttpApi to declare endpoints, payload/result schemas, typed errors and generated client/OpenAPI shapes. The actor protocol remains transport-neutral. The HTTP layer performs authentication, authorization context construction, request size limits and error mapping.

## Suggested resource API

```
POST /v1/apps/:app/envs/:env/todos/:id/commands/rename
GET  /v1/apps/:app/envs/:env/todos/:id
GET  /v1/apps/:app/envs/:env/submissions/:submissionId
GET  /v1/apps/:app/envs/:env/todos/:id/events
```

Do not encode arbitrary actor IDs with slashes directly into unescaped route segments. Canonicalize/encode them or use a stable external handle. Do not trust a caller-supplied application ID without checking access.

## Status semantics

200/201 represents completed work or a created resource, not just queue acceptance. 202 returns a durable submission receipt and status location. 404 is a domain NotFound or hidden inaccessible resource according to policy. 409 is version/idempotency/state conflict. 422 is a validated domain rejection where appropriate. 429 includes admission/backlog limits. 503 means temporary infrastructure unavailability. Avoid returning 500 with raw SQL/provider error details.

A timed-out wait can still leave accepted work running. Return the known receipt when possible. A retry uses the same idempotency key and payload digest. Client disconnect closes the HTTP wait/subscription, not the logical command by default.

## Realtime

SSE encodes the retained event cursor as event ID and includes heartbeats. The gateway handles reconnect cursors and authorization. WebSocket command envelopes use the same schema and submission semantics; they are not privileged compared with HTTP.

## Code generation and tests

One endpoint schema source should drive client types and OpenAPI. Test domain-error mapping, unknown command/schema versions, content negotiation, streaming proxy behavior and repeated idempotent submission. HttpApiTest/RpcTest can cover adapter behavior; real Bun/Node and Railway proxy integration tests cover transport details.

## Sources and evidence

- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [B08: Bun HTTP server](https://bun.com/docs/runtime/http/server) — Server/WebSocket APIs belong in Bun adapter, not portable actor core.
- [D01: Railway monorepos](https://docs.railway.com/guides/monorepo) — Service build/start boundaries and watch paths.
