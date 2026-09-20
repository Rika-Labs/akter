# 13 — SDKs and transports

**Status:** Effect-first plus derived TypeScript SDK is accepted. Exact generated exports, HTTP routes and transport wire formats are proposals.

[Index](../../README.md) · [Context](../01-actor-context/README.md) · [Realtime](../04-realtime/README.md) · [Commands](../03-commands-messaging/README.md)

## One contract, multiple clients

```diagram
┌───────────────────────────────┐
│ Actor schemas and definitions │
└───────────────┬───────────────┘
                ▼
┌───────────────────────────────┐
│ Client-safe protocol contract │
└───────┬───────────┬───────────┘
        ▼           ▼           ▼
   Effect API   Promise SDK   HTTP/OpenAPI
   + Streams   + async iter  CLI / console
```

The Promise client adapts Effect execution/results and streams. It does not run an independent actor implementation. Contracts include runtime schemas, errors and protocol versions but exclude handlers, server imports, credentials and connection pools.

## Proposed TypeScript client

```ts
import { createClient } from "durable-actors/client"
import { contract } from "./generated/actor-contracts"

const client = createClient(contract, {
  endpoint: "/actors",
  transport: "websocket",
  authenticate: getAccessToken,
})
const room = client.chat({ tenantId: "acme", id: "general" })

// Retain this pair across retries of this one operation.
const pending = {
  commandId: crypto.randomUUID(),
  input: { id: crypto.randomUUID(), body: "Hello!" },
}
const message = await room.commands.sendMessage(pending.input, {
  commandId: pending.commandId,
})

for await (const frame of room.subscriptions.messages({ signal })) {
  if (frame.type === "snapshot") replaceRecentMessages(frame.data)
  else upsertMessage(frame.event.data)
}
```

UI callbacks, access token acquisition and `signal` are application placeholders. Authentication is verified server-side; a tenant argument never grants permission. Rejected Promises need a documented error representation; TypeScript does not statically type Promise rejection channels as Effect does.

## Proposed Effect client

```ts
const program = Effect.gen(function* () {
  const client = yield* ActorClient
  const room = client.chat({ tenantId: "acme", id: "general" })
  yield* room.commands.sendMessage(input, { commandId })
  yield* Stream.runForEach(room.subscriptions.messages(), consumeFrame)
})
```

Client interruption stops waiting/listening. It does not automatically cancel an accepted durable command or undo an external effect. Cancellation of durable work is a separate authorized operation.

## Transport semantics

| Surface | Intended behavior |
| --- | --- |
| HTTP commands | POST with stable idempotency identity; committed result or durable acceptance handle |
| HTTP queries | Authorized read; conditional responses only with a correct dependency-aware validator |
| WebSocket | Commands, queries, subscriptions and signals with distinct frame types and acknowledgements |
| SSE | One-way durable event delivery and cursor resume; commands still use another channel |
| In-process | Same actor authority/protocol rules without unnecessary public HTTP round trips |
| CLI/console | Derived clients plus authorized read-only SQL, not a secret mutation bypass |

An ETag for a query depending on other actors, caller permissions, parameters or time cannot simply be the current actor's version. Bind validators to the actual representation or omit caching. Do not inherit the old global-ETag shortcut.

Protocol schemas must distinguish accepted, committed, rejected, unknown/wait-timeout and expired receipt states. Reconnect dedupes pending operations by their stable identity. Batch transport, if later added, does not imply one database transaction across commands.

## Compatibility and exposure

- Public commands and internal completions have separate exposure/auth rules.
- Versioned wire schemas and rolling-deployment compatibility are required for replayed commands/events.
- Browser clients receive no database credentials or arbitrary privileged query execution.
- Pin/test compatible Effect/Drizzle versions. Re-exported query operators and direct imports must interoperate.
- Framework API examples use one package name for clarity, not a final package/license commitment.

## Validation gates

1. Run equivalent Effect and Promise operations; outcomes, schemas and retry identity agree.
2. Inspect a browser bundle: no server-only imports, runtime secrets or database factories.
3. Reconnect after acceptance and after commit-before-response; same operation is recovered rather than duplicated.
4. Test old/new protocol versions and malformed plain-JavaScript requests against runtime decoders.
5. Abort a client request; accepted work remains observable through its receipt rather than falsely cancelled.
6. Change authorization/parameters while exercising HTTP validators; no cached cross-principal disclosure.
