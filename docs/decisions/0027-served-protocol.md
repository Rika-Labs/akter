# ADR 0027: The served protocol: HTTP, WebSocket, SSE, and OpenAPI

**Status:** proposed (2026-09-26)

## Context

`Actor.serve` and `Actor.auth` are named in the [server API](../api/01-server-api.md) and required by [contract 10](../contracts/10-security.md), but nothing says what goes over the wire. The [protocol contract](../contracts/protocol.md) lists what a request must carry (actor identity, edge-derived tenant, a client-minted command id, caller attribution, trace context, and encoded input) and one concrete rule, that HTTP echoes the command id as `x-request-id`. The rest is open:

- **Routes.** No URL exists for a command, query, reducer, event feed, stream, or connection, and nothing says how a key, a singleton, or a minted actor appears in one.
- **Command ids from outside the process.** [ADR 0007](0007-foundation-command-protocol.md) fixes the v1 id, `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`. Admission requires `issuedAt <= databaseNow < expiresAt`, an `expiresAt − issuedAt` equal to the deployment's retry window, and no future-clock grace. Today only the embedded runtime mints ids, from the database clock. A browser has neither the database clock nor the window, and a browser clock one second fast makes every id it mints `InvalidCommandId`.
- **Authentication.** [Contract 10](../contracts/10-security.md) requires per-request callers, `Actor.auth.none` as the only way to be public, and `Unauthorized` codes `missing_credentials`, `invalid_credentials`, and `expired`. The shipped `Unauthorized` has only `access_denied` and `receipt_access_denied`, and there is no provider interface, tenant source, or principal size limit (the **Cluster header size** gate).
- **Errors.** The [error model](../contracts/error-model.md) reserves 410, 400, and 403 for three reasons and says `InvalidInput` and `TransportError` exist only at this boundary. Their fields, the other statuses, `retryAfter` values, the declared-error body, defects, and WebSocket and SSE endings are undefined. `retryAfter` is never populated.
- **Queries and read-your-writes.** [ADR 0011](0011-direct-commands-outbox-and-performance.md) says a handle sends the highest commit version it has seen with each query. M4.9 builds that. The token has no wire name or format, so the M3.4 client can't carry it yet.
- **OpenAPI.** [Generated contracts](../api/generated-contracts.md) says served actors expose OpenAPI and that internal members never appear. How it is generated, and what it describes, is open.
- **Streaming.** [ADR 0023](0023-connections-parking-and-streams.md) (accepted 2026-09-26) builds connections, parking, and streams behind a transport interface, and leaves the wire to this ADR: the envelope that keeps `Resync`, `ResyncReplayed`, and `ResyncDone` apart from member frames, how a served transport caps the revocation bound at a credential's expiry, and "a reauthenticate frame". Dallen's two changes to ADR 0023 shape this ADR: broadcasts may wake parked actors (through the trigger that makes them broadcast), and an ungraceful owner death resyncs sockets in place instead of closing them.
- **Order of work.** On 2026-09-26 Dallen moved M3.1, M3.2 (`Actor.serve` over HTTP, [#92](https://github.com/Rika-Labs/durable-actors/issues/92)) and M3.4 (the Promise client, [#93](https://github.com/Rika-Labs/durable-actors/issues/93)) ahead of the rest of M2. M3.2 and M3.4 must be buildable from this ADR while M2.10 (connections) is still unbuilt, so the HTTP half stands alone and the streaming half only has to fit ADR 0023.

This ADR decides the wire for all three transports. M3.2 builds the HTTP half, M3.4 the client for it, and M3.3 the WebSocket and SSE half on top of M2.10.

## Decision

### 1. One server, one base path, one route per member

`Actor.serve` returns a layer that adds routes to Effect's `HttpRouter`, so it composes with the application's own routes and runs on any `HttpServer` (Bun or Node). It names the actor definitions it serves; their layers are provided as usual, and startup fails if a served actor's command or query layer is missing from the process.

```ts
// examples/chat/src/main.ts
const ChatServer = Actor.serve({
  actors: [Room, Digest], // definitions, not layers
  auth: Actor.auth.jwt({
    issuer: "https://auth.example.com/",
    audience: "chat",
    jwks: new URL("https://auth.example.com/.well-known/jwks.json"),
    tenant: (claims) => claims.org_id, // optional; default "default"
  }),
  basePath: "/api",
  openapi: { path: "/openapi.json" }, // off unless given
  origins: ["https://chat.example.com"], // browser origins allowed for CORS and WebSocket upgrades
})

BunRuntime.runMain(
  Layer.launch(
    HttpRouter.serve(ChatServer).pipe(
      Layer.provide(BunHttpServer.layer({ port: 8080 })),
      Layer.provide([RoomLive, RoomReads, RoomEffects, DigestLive]),
      Layer.provideMerge(Actors.layer({ authorize })),
      Layer.provide(Database.postgres({ url: Redacted.make(url) })),
    ),
  ),
)
```

Routes, under `basePath`:

| Member                          | Method and path                                                         | Body          | Response                                        |
| ------------------------------- | ----------------------------------------------------------------------- | ------------- | ----------------------------------------------- |
| Command, reducer                | `POST /actors/{Actor}/{id}/{Member}`                                    | encoded input | encoded output (a reducer: the committed state) |
| Query                           | `POST /actors/{Actor}/{id}/{Member}`                                    | encoded input | encoded output                                  |
| Workflow start                  | `POST /actors/{Actor}/{id}/{Workflow}`                                  | encoded input | `{ executionId }`                               |
| Workflow run                    | `GET /actors/{Actor}/{id}/{Workflow}/runs/{executionId}?wait=<seconds>` | –             | `{ status: "running" }` or the encoded `Exit`   |
| Workflow interrupt              | `POST /actors/{Actor}/{id}/{Workflow}/runs/{executionId}/interrupt`     | –             | `204`                                           |
| Event feed                      | `GET /actors/{Actor}/{id}/events?event={Event}&event=…&after={cursor}`  | –             | `text/event-stream` (section 7)                 |
| Stream (`Actor.stream`)         | `POST /actors/{Actor}/{id}/{Stream}` with `accept: text/event-stream`   | encoded input | `text/event-stream` (section 7)                 |
| Connection (`Actor.connection`) | `GET /actors/{Actor}/{id}/{Connection}`, WebSocket upgrade              | –             | WebSocket (section 8)                           |
| Protocol discovery              | `GET /protocol`                                                         | –             | `{ protocol, retryWindowMs, now }` (section 2)  |
| Command id mint                 | `POST /command-ids`                                                     | –             | `{ commandId }` (section 2)                     |
| OpenAPI                         | `GET {openapi.path}`                                                    | –             | OpenAPI 3.1 document (section 6)                |

- **Actor and member names** appear verbatim and case-sensitive. `Actor.serve` fails at startup if a served actor's name or member tag is not `[A-Za-z][A-Za-z0-9_]*`, or if a member is named `events`, which the feed route reserves.
- **The id segment** is the key schema's encoded string, percent-encoded as one RFC 3986 path segment; `/` in an id is `%2F`. The server decodes the segment exactly once after routing and never normalizes it, so an id of `..`, `a/b`, or `%2F` is an ordinary id. The key schema then decodes it, and a decode failure is `InvalidInput`.
- **Singletons** have no id segment: `POST /actors/{Actor}/{Member}`. The actor's key mode decides which form a route has, so the two never overlap.
- **Minted actors** (`X.create()`) use the keyed form with a UUIDv7 id that the client mints, the same as the Effect handle does in process. The server accepts only a UUIDv7 in that segment. The id is input, not authority: `authorize` and `createdBy` still decide who may create or reach the actor.
- **Internal members** (the `internal` section), effect executors, and effect routes have no route. A request for one gets the same `404` as a member that does not exist, so a route's absence reveals nothing.
- **Queries use `POST`**, like commands, so every member takes its input the same way and inputs never land in URLs, access logs, or caches. A query carries no command id and is safe to retry.
- **Tenant is never in the URL or a header.** The auth provider derives it (section 3), as [contract 10](../contracts/10-security.md) requires.
- **Content type.** Requests and responses are `application/json`, encoded with the member's runtime schemas through the same JSON codec used for persistence (`Schema.toCodecJson`), so `Uint8Array`, dates, and tagged classes encode the way receipts store them. Any other request content type is `415 InvalidInput { code: "unsupported_media_type" }`.
- **Limits.** A request body is at most `limits.requestBytes` (default 1 MiB) and the credential header at most `limits.credentialBytes` (default 8 KiB); either past its limit is `413 InvalidInput { code: "too_large" }`, rejected before decoding.
- **Protocol version.** Every response carries `durable-protocol: 1`. A request may send it; a request naming a major version the server doesn't serve is `400 InvalidInput { code: "unsupported_protocol" }`. Paths carry no version, so a later protocol version is a header change, not a new URL space.
- **Tracing.** The server accepts W3C `traceparent` and `tracestate`, continues the trace into the turn span `durable-actors.<Actor>/<Command>`, and never records bodies or credentials on spans.
- **Waiting.** A command request waits for its reply up to the actor's `deliveryTimeout` (default 30 s), then answers `504 Timeout`. A client that disconnects does not cancel the command: accepted work continues, as it does for an Effect caller that stops waiting.
- **Any runner serves any route.** A command is dispatched through Cluster to the actor's owner, a query reads committed rows on the serving runner, and a socket is held by the runner that accepted it (ADR 0023's holder). Load balancers need no actor affinity.

### 2. Command ids on the wire

**Transport.** A command request carries its v1 id in `Idempotency-Key` (the IETF `httpapi` working-group header, which client generators and API gateways already understand). Every response to it, success or failure, carries the same id in `x-request-id`, as [the protocol contract](../contracts/protocol.md) requires. The id is never taken from `x-request-id` on a request, because proxies inject their own. Expiry travels inside the id, so there is no separate expiry header to refresh, and an edited time is a different operation, per ADR 0007.

- A command without `Idempotency-Key` is `400 InvalidInput { code: "missing_command_id" }`. The server never mints an id for a caller, because a caller that loses the response to a server-minted id can't retry it.
- A malformed, future, wrong-window, or unsupported id is `400 InvalidCommandId`. An expired id is `410 CommandExpired`. A reused id with different input is `409 CommandConflict`. All three carry the id, and none runs the handler.
- A query ignores `Idempotency-Key` and does not echo it.

**Minting without the database clock.** Clients mint ids against the server's clock, never their own:

1. `GET /protocol` returns `{ protocol: 1, retryWindowMs, now }`, where `now` is the database clock in milliseconds. It needs no credentials, reveals nothing tenant-specific, and runs no turn. Every other response also carries `durable-now: <ms>`.
2. The client keeps `offset = now − (sent + received) / 2` from its latest response, and mints `issuedAt = localNow + offset − max(1000, rtt)` and `expiresAt = issuedAt + retryWindowMs`, with a fresh UUIDv4. The subtracted margin absorbs its estimate's error; the id loses at most that much of its retry window.
3. A client that can't keep a clock offset (a shell script, a generated client) calls `POST /command-ids`, which returns an id minted from the database clock in one round trip and writes nothing. It requires the same credentials as a command, so it isn't an anonymous oracle.

`InvalidCommandId` gains `code`: `malformed`, `future`, `window`, or `version`. Ids rejected for `window` or `version` can never be admitted by any server with the current configuration, so a client may refresh `/protocol` and mint a new id for that operation; this is the one case where a new id replaces one that was sent, and it can't duplicate work. `future` stays terminal: an earlier attempt of the same id may still be in flight and become admissible once the clock passes it.

**Retries.** A client retries with the same `Idempotency-Key` and never mints a replacement for an id that expired:

| Outcome                                                           | Retry with the same id?                    | Wait                                                 |
| ----------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| `503 ActorUnavailable`, `503 RunnerAtCapacity`, `429 MailboxFull` | yes                                        | `retryAfter`, with jitter                            |
| `504 Timeout`                                                     | yes; the turn may have committed           | none                                                 |
| `TransportError` with `retryable: true` (no envelope arrived)     | yes; the outcome is unknown                | exponential, from 100 ms, capped at 5 s, with jitter |
| `410 CommandExpired`                                              | no; surfaced to the caller, never reminted | –                                                    |
| `409`, `400`, `401`, `403`, `404`, `413`, `415`, `422`, `500`     | no                                         | –                                                    |

Retries stop at the caller's `timeoutInMs`, at `signal` abort, or once `expiresAt − 1 s` passes on the client's offset clock; the last error is surfaced, and the outcome of earlier attempts stays unknown. A retry after the stop is the caller's explicit choice with the same id, which replays the receipt or fails `CommandExpired`. A new id is a new operation.

### 3. Authentication at the edge

`Actor.serve` requires `auth`, and there is no default. A provider turns a request into an authenticated caller or an `Unauthorized`:

```ts
interface Authenticated {
  readonly caller: User | Anonymous // never System
  readonly tenant: string
  readonly expiresAt?: DateTime.Utc // the credential's own expiry, which caps live sessions (section 8)
}

Actor.auth.make((request: AuthRequest) => Effect<Authenticated, Unauthorized>) // custom providers
Actor.auth.jwt({ issuer, audience, jwks, algorithms?, subject?, tenant?, clockTolerance? }) // the first provider
Actor.auth.none // every request is Anonymous in the "default" tenant
```

- **Per request.** The provider runs for every HTTP request, every WebSocket `hello` and `reauthenticate`, and every SSE request. It sets `CurrentCaller` and `Tenant` for that request only, so concurrent requests with different tokens get different principals (invariant H1). `AuthRequest` exposes headers and cookies, never the body.
- **Codes.** No credentials is `401 Unauthorized { code: "missing_credentials" }`; a bad signature, issuer, audience, or algorithm is `invalid_credentials`; a credential past its expiry is `expired`. These three codes join the shipped `access_denied` and `receipt_access_denied` (both `403`) and ADR 0023's `reauthorization_unavailable`. A `401` carries `www-authenticate: Bearer`. None of them runs a turn or falls back to `Anonymous`.
- **Authentication is not authorization.** After the provider succeeds, the runtime's `authorize` hook decides every command, query, receipt replay, open, feed, and stream, as today and as ADR 0023 extends it.
- **`Actor.auth.jwt`** verifies against a JWKS URL (cached, refreshed on an unknown `kid`, at most once a minute) or static keys, accepts only asymmetric algorithms (default `RS256`, `ES256`, `EdDSA`), requires `exp`, and allows 30 s of clock tolerance. `subject` defaults to the `sub` claim and `tenant` to `"default"`; both are functions of the verified claims only. The credential is read from `authorization: Bearer`, or, for WebSockets, from the `hello` frame.
- **`Actor.auth.none`** ignores any credential the request carries, so a stray `authorization` header can't change the caller. It is an explicit, greppable opt-out; there is no implicit public mode.
- **No System callers.** A provider that returns a `System` caller is a defect (`500`) at the edge. System attribution comes only from the runtime's own delivery paths, per [contract 10](../contracts/10-security.md).
- **Principal limit.** A `User.subject` is 1 to 512 UTF-8 bytes, and the encoded `Caller` at most 1 KiB, which is what the **Cluster header size** gate must prove fits a Cluster envelope. A provider result past either is `401 invalid_credentials`, logged without the credential.
- **Mixed public and private actors** use two `Actor.serve` layers at two base paths, each with its own `auth` (Q4).
- **Browsers.** `origins` lists the origins allowed to call the server. Preflight allows `authorization`, `content-type`, `idempotency-key`, `durable-protocol`, `durable-min-version`, `traceparent`, and `tracestate`, and exposes `x-request-id`, `durable-now`, `durable-version`, and `retry-after`. A WebSocket upgrade from an origin not listed is refused with `403` before `hello`, which stops cross-site WebSocket hijacking when a provider reads cookies. Credentials never travel in a URL.

**Signed edge assertions (hosted, M4).** A hosted edge authenticates the tenant's API key and forwards a short-lived signed assertion to runners over TLS ([ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md)). This ADR reserves its place in the protocol so M3 clients don't change when M4 lands: the runner-side provider is `Actor.auth.assertion({ issuer, audience, keys })`, the assertion travels in `durable-assertion`, and it binds at least the actor ref, the member, the command id where one exists, a SHA-256 of the request body, and an expiry of at most 60 seconds. The edge strips any client-supplied `durable-assertion`. Key rotation, revocation, canonical request binding, and streaming sessions are ADR 0031's (M4.1). Until then `Actor.auth.assertion` doesn't exist, and a runner never trusts the header.

### 4. Errors on the wire

A failure body is one of three things, told apart by `_tag`:

```jsonc
// a framework failure: ActorError, with reason, isRetryable, and retryAfter (milliseconds) spelled out
{ "_tag": "ActorError", "reason": { "_tag": "RunnerAtCapacity" }, "isRetryable": true, "retryAfter": 1000 }
// a declared failure: the member's own error, schema-encoded, exactly as its receipt stores it
{ "_tag": "RoomFull", "capacity": 50 }
// a defect: no details, so nothing internal leaks
{ "_tag": "Defect", "traceId": "4bf92f3577b34da6a3ce929d0e0e4736" }
```

`Actor.make` already rejects declared errors that aren't tagged; it also rejects a declared error tagged `ActorError` or `Defect`. The two boundary-only reasons get fields:

- `InvalidInput { code, issues? }`, where `code` is `decode`, `missing_command_id`, `too_large`, `unsupported_media_type`, `unsupported_protocol`, or `unknown_route`, and `issues` lists schema issues by path and message, never the offending values.
- `TransportError { code, status?, retryable }`, produced only by clients, when no valid envelope arrived: `network` (the request may or may not have reached the server; retryable), `status` (a non-envelope `502`, `503`, or `504` from a proxy; retryable; any other status is not), `decode` (a body that isn't a valid envelope; not retryable), or `defect` (the server answered `Defect`; not retryable, because a defect writes no receipt and would run again).

| Outcome                                                                           | HTTP                                           | WebSocket and SSE ending                                                |
| --------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Success                                                                           | `200` (`204` for `void` output)                | –                                                                       |
| Declared failure                                                                  | the error's `httpApiStatus`, else `422`        | `end` with the declared error; close `4400`                             |
| `ActorUnavailable`                                                                | `503`, `retry-after`                           | `1013`                                                                  |
| `RunnerAtCapacity`                                                                | `503`, `retry-after`                           | `1013`                                                                  |
| `MailboxFull`                                                                     | `429`, `retry-after`                           | –                                                                       |
| `Timeout`                                                                         | `504`                                          | –                                                                       |
| `CommandConflict`                                                                 | `409`                                          | –                                                                       |
| `CommandExpired`                                                                  | `410`                                          | –                                                                       |
| `InvalidCommandId`                                                                | `400`                                          | –                                                                       |
| `NotCreated`                                                                      | `404`                                          | `4404`                                                                  |
| `Unauthorized` `missing_credentials`, `invalid_credentials`, `expired`            | `401`, `www-authenticate: Bearer`              | `1008`                                                                  |
| `Unauthorized` `access_denied`, `receipt_access_denied`                           | `403`                                          | `1008`                                                                  |
| `Unauthorized` `reauthorization_unavailable`                                      | –                                              | `1013`                                                                  |
| `InvalidInput`                                                                    | `400`; `404` for `unknown_route`; `413`; `415` | `4400`; a frame over 64 KiB `1009`                                      |
| `SessionEnded` `ClientClosed`, `ServerClosed`, `Terminated`                       | –                                              | `1000`                                                                  |
| `SessionEnded` `HolderShutdown`                                                   | –                                              | `1012`                                                                  |
| `SessionEnded` `SlowConsumer`, `OwnerLost`, `ActivationEnded`, `ActorUnavailable` | –                                              | `1013`                                                                  |
| `SessionEnded` `Defect`, or a defect                                              | `500 Defect`                                   | `1011`                                                                  |
| Socket or stream drops with no `end`                                              | –                                              | the client reports `SessionEnded { cause: "HolderLost", resync: true }` |

- The body, or the `end` frame, is authoritative. Status and close codes are coarse, for proxies, logs, and tools; clients decode the body.
- **`retryAfter`** is populated for the first time, in milliseconds, on the envelope and as `retry-after` in whole seconds (rounded up): 250 ms for `ActorUnavailable`, 1,000 ms for `RunnerAtCapacity`, 100 ms for `MailboxFull`, each with ±50% jitter, and ADR 0023's jittered value on a third resync. The in-process handle uses the same values for its own retries, so `ActorError.retryAfter` means the same thing everywhere.
- `R3` holds over the wire: a replayed declared failure has the same `_tag`, fields, and status as the first.

### 5. Queries and read-your-writes tokens

- A command response carries `durable-version: <token>`, the commit version of that turn, once M4.9 adds it. A query request may carry `durable-min-version: <token>`, and the answering reader must have caught up to it, or fall through to the primary ([ADR 0011](0011-direct-commands-outbox-and-performance.md), invariant Q1).
- **Format.** A token is a non-negative decimal integer string without leading zeros, so a client keeps the greatest it has seen by comparing length and then characters, without knowing what the number is. M4.9 decides what it counts (for example the commit LSN). Clients never do arithmetic on it.
- **Before M4.9** servers send no `durable-version` and ignore `durable-min-version`, because every query reads the primary, which trivially satisfies any token. So M3.4 builds the client half now, and M4.9 changes no client.
- The client keeps one token per `baseUrl`: the maximum of every `durable-version` it has received. Tokens are not secrets and carry no authority; a forged high token only makes a query wait or fall through to the primary.
- Queries keep their framework reasons (`ActorUnavailable` and `Unauthorized`) plus the boundary ones. A query never needs a command id, and a retried query is a new read.

### 6. OpenAPI from the same definitions

- `Actor.serve` builds each served actor type as an Effect `HttpApiGroup`, and each public member as an `HttpApiEndpoint` whose payload, success, and error schemas are the member's own runtime schemas. The server and the document come from the same `HttpApi` value, so a route can't be documented without being served or served without being documented. `/openapi.json` is `OpenApi.fromApi` of that value, served only when `openapi` is configured.
- The document is OpenAPI 3.1 (JSON Schema 2020-12). Each operation has `operationId` `<Actor>.<Member>`, the `Idempotency-Key` header as a required parameter on commands, reducers, and workflow starts, the declared errors under their statuses, and `ActorError` under the statuses in section 4. The auth provider contributes its security scheme (`bearer` with format `JWT` for `Actor.auth.jwt`, none for `Actor.auth.none`).
- Internal members, executors, routes, and connection internals never appear (the **Internal section** check). Connections, feeds, and streams appear as operations with `x-durable-transport: websocket | sse` and their frame schemas under `components`, so tools can find them, but OpenAPI can't describe their message flow; AsyncAPI is deferred (Q10).
- The document is generated at startup, is deterministic for a given set of definitions (stable key order, no timestamps), and is covered by a snapshot test in each example, so a schema change shows up in review.
- M3.2 ships a guide to generating clients in other languages from `/openapi.json` with standard generators; it covers minting ids through `POST /command-ids` and retrying with the same `Idempotency-Key`.

### 7. Server-sent events: event feeds and streams

**Event feeds** follow an actor's durable events: `GET /actors/Room/r1/events?event=MessagePosted&after=42`.

- **Framing.** Each event is one SSE message: `id` is its cursor, `event` is its tag, and `data` is `{ event, commandId, timestamp }` with the event schema-encoded. A comment line every 15 seconds keeps idle proxies from closing the stream.
- **Resume.** `after` is exclusive, like every event cursor ([contract 07](../contracts/07-realtime.md)). On reconnect, `Last-Event-ID` overrides `after`, so a browser's own reconnect resumes where it stopped. `UnknownCursor` and `RetentionGap` detected at the start answer `404` and `410` with the error body before any stream starts, which also stops `EventSource` from reconnecting in a loop. Pruning that overtakes an open feed ends it with an `end` message carrying `RetentionGap`, and the next reconnect gets the `410`.
- **Filters.** At least one `event` is required; there is no wildcard, so `authorize` sees every event tag a caller reads.
- **Authorization.** The hook is called with `kind: "feed"` and `command` set to each event tag before anything is read, then reauthorized every `reauthorizeEvery` with `kind: "reauthorize"` (ADR 0023). SSE can't carry a `reauthenticate` frame back, so a feed ends with `Unauthorized { code: "expired" }` at its credential's `expiresAt`, and the client reconnects with a fresh credential and its last cursor. Nothing is lost.
- **How feeds work under ADR 0023.** A feed is a framework connection with no application handler, held by the runner that serves the SSE response and parked like any other connection. So an idle feed never keeps its actor resident (ADR 0023's streams do, which is why feeds are not streams).
  1. Opening a feed runs ADR 0023's open on the owner, which inserts the connection row and returns the baseline cursor. The holder then reads committed events after `after` from `actor_events` itself, without the activation, sends them, and then sends live frames above the last cursor it sent. Live frames that arrive during the read wait, so the race between snapshot and live delivery neither loses nor repeats an event.
  2. Every turn that emits events broadcasts them to the actor's feeds after commit, stamped with their cursors. Under ADR 0023's accepted Q3, any trigger that makes a parked actor commit (a command, intent, timer, cron tick, effect route, or cross-actor subscription delivery) wakes it, and its first emitting turn loads the feed rows, so parked feeds on any runner receive the event.
  3. On a broadcast gap or an unsealed generation, where ADR 0023 would send a connection `Resync`, the feed's holder resyncs by itself: it rereads `actor_events` after the last cursor it sent and resumes live delivery, deduplicating by cursor. The client sees an unbroken, gap-free feed. If the reread hits `RetentionGap`, the feed ends with it.
  4. The cost is one extra statement, the actor-scoped load of feed rows, on the first emitting turn of each activation, and only for actor types that `Actor.serve` serves feeds for. Embedded-only deployments pay nothing.
- **HTTP/1.1** browsers allow six connections per origin, so a page following many feeds should be served over HTTP/2 or HTTP/3, where streams share one connection. M3.3 documents that; multiplexing feeds over one socket is Q8's alternative.

**Streams** (`Actor.stream`) use `POST` with `accept: text/event-stream` and the stream's input as the body. Each element is `event: element` with the encoded output as `data`, and the stream ends with `end` (ADR 0023: `ActivationEnded`, `SlowConsumer`, or the handler's own end). Streams have no framework cursor, so there is no `Last-Event-ID` resume; a stream that uses `read.follow` takes its cursor in its input.

Browsers' `EventSource` can only send cookies, so it works with cookie-reading providers. The Promise client reads SSE over `fetch`, so it can send `authorization`.

### 8. WebSocket connections

A connection member is served at `GET /actors/{Actor}/{id}/{Connection}` as a WebSocket upgrade with subprotocol `durable-actors.v1`; an upgrade without it is refused, which versions the frame format. Every message is one JSON text frame with a `t` discriminator. Member frames only ever travel inside `frame`, so control frames live in their own envelope variant, as ADR 0023 requires, and an application class tagged `Resync` can't be mistaken for one.

| Direction        | `t`               | Fields                                          | Meaning                                                                                                                      |
| ---------------- | ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| client to server | `hello`           | `authorization?`, `params`                      | first frame, within 10 s of the upgrade; nothing wakes before it authenticates                                               |
| server to client | `open`            | `connectionId`, `baseline`, `reauthenticateBy?` | ADR 0023's open acknowledgment, sent after `open` committed and its frames were flushed                                      |
| both             | `frame`           | `frame`, `cursor?` (server to client)           | a member frame; `cursor` is ADR 0023's flushed-through stamp                                                                 |
| server to client | `resync`          | `after`, `reason`, `deadline`                   | ADR 0023's `Resync` after an ungraceful owner death                                                                          |
| server to client | `resyncReplayed`  | `through`                                       | the member's `resync` handler replayed through `through`                                                                     |
| client to server | `resyncDone`      | `through`                                       | the client resynchronized; consumed by the holder                                                                            |
| server to client | `reauthenticate`  | `by`                                            | send a fresh credential before `by`                                                                                          |
| client to server | `reauthenticate`  | `authorization`                                 | the fresh credential                                                                                                         |
| server to client | `reauthenticated` | `by?`                                           | accepted; `by` is the new credential's deadline                                                                              |
| server to client | `end`             | `error?`                                        | the session's last message: an `ActorError` envelope (usually `SessionEnded` or `Unauthorized`) or a declared `open` failure |

- **`hello`** carries the credential, because browsers can't set headers on a WebSocket and credentials must not go in URLs. A non-browser client may send `authorization` on the upgrade request instead, and a cookie-reading provider reads the upgrade's cookies. `params` are validated like command input. A `hello` that doesn't arrive in 10 s, or doesn't decode, ends with `InvalidInput` before anything wakes.
- **Opening** follows ADR 0023 section 4: the holder authenticates, calls `authorize` with `kind: "open"`, and sends `open` to the owner. A declared failure of the member's `open` handler becomes `end` with that error and close `4400`.
- **The revocation bound on the wire** is the earlier of `reauthorizeEvery` after the last successful check and the credential's `expiresAt`. Sixty seconds before `expiresAt` (or at half the credential's remaining life, if that is shorter) the holder sends `reauthenticate { by }`. The client answers with a fresh credential; the holder verifies it with the same provider and requires the same caller and tenant (a different identity is `end` with `Unauthorized { code: "invalid_credentials" }`, because identity doesn't change mid-session: reconnect instead). It then runs `authorize` with `kind: "reauthorize"` and answers `reauthenticated`. At `by` without a valid answer, the session ends with `Unauthorized { code: "expired" }`, and buffered frames are discarded as ADR 0023 section 8 requires. With `Actor.auth.none`, or a credential without an expiry, only `reauthorizeEvery` applies.
- **Resync** is ADR 0023 section 7, carried as the frames above: `resync` is queued behind the dead generation's frames and exempt from buffer limits, the deadline is enforced on the holder's clock, `resyncDone` is consumed by the holder and never forwarded, and a client that never sends it is closed with `OwnerLost` at the deadline.
- **Backpressure** is TCP's. The holder stops reading a socket beyond ADR 0023's 32 frames in flight, and closes a connection whose outbound buffer overflows with `SlowConsumer`. Inbound frames over 64 KiB close with `1009`. Binary messages are refused with `1003`.
- **Liveness.** The holder sends a WebSocket ping every 30 seconds and treats a socket without a pong for 60 seconds as closed by the client.
- **Commands don't travel over the socket.** A client sends a command as an HTTP request with its `Idempotency-Key`, even while it holds a connection (Q7). Connection handlers still call commands through handles, with ADR 0023's HMAC-derived ids.

A connection is one socket to one actor member. There is no multiplexing of several actors on one socket in v1 (Q8).

### 9. What the Promise client (M3.4) needs

M3.4 builds commands and queries over HTTP; M3.5 adds feeds, streams, and connections over sections 7 and 8.

```ts
import { Room } from "../room/contract.ts" // imports schemas and definitions only

const rooms = Room.client({
  baseUrl: "/api",
  headers: () => ({ authorization: `Bearer ${token()}` }),
})
const room = rooms.get("r1")

const id = await rooms.commandId() // optional; the client mints one per call otherwise
const result = await room.Post({ body: "hello" }, { commandId: id, signal, timeoutInMs: 10_000 })
const state = await room.Recent() // a query; carries durable-min-version

try {
  await room.Post({ body: "again" }, { commandId: id }) // same id: replays the stored outcome
} catch (error) {
  if (error instanceof RoomFull)
    showFull(error.capacity) // declared errors are their own classes
  else if (error instanceof ActorError && error.reason._tag === "CommandExpired")
    askUser() // never reminted
  else throw error
}
```

- **Route table.** `X.client` derives routes, codecs, and the declared-error decoder from the actor definition, never from a fetched OpenAPI document. The client imports only definitions and schemas, never runtime, SQL, or Cluster modules; M3.4's browser-build test enforces it.
- **Headers** may be a function, called per attempt, so a retry after a token refresh sends the new credential with the same command id. Credential rotation for the same caller keeps receipt access ([contract 04](../contracts/04-receipts.md)).
- **Minting** is section 2: `/protocol` once per `baseUrl`, lazily before the first command and shared by concurrent calls, then the offset from every `durable-now`. `client.commandId()` mints one ahead of a call, for callers that store it before sending (offline queues, M6). An explicit `commandId` is used as given.
- **Retries** are section 2's table, with `retryAfter` honored, and the stop conditions there. `signal` and `timeoutInMs` only stop waiting; the error says the outcome is unknown and carries the command id so the caller can retry it later.
- **Errors.** Declared errors are thrown as their schema classes, framework failures as `ActorError` with `reason`, `isRetryable`, and `retryAfter`, and the boundary reasons as `ActorError` with `InvalidInput` or `TransportError`. Nothing is thrown as a plain `Error` except a defect in the client itself.
- **Read-your-writes.** The client keeps section 5's token per `baseUrl` and sends it on every query.
- **Reducers** are called like commands in M3.4 and replied with committed state; optimistic application is M3.5.
- **Workflow starts** return `{ executionId }` wrapped as a `WorkflowRun` with `poll`, `result` (long-polls with `wait=30`), and `interrupt`, once M2.7 has shipped the engine.

### 10. Where we differ from Rivet and Durable Objects

Rivet's documentation, read 2026-09-26: [actions](https://rivet.dev/docs/actors/actions), [authentication](https://rivet.dev/docs/actors/authentication), [debugging and gateway endpoints](https://rivet.dev/docs/actors/debugging), [endpoints](https://rivet.dev/actors/docs/general/endpoints/), [connections](https://rivet.dev/actors/docs/connections/), [WebSocket handler](https://rivet.dev/docs/actors/websocket-handler/), and the 2.3 release notes on OpenAPI, AsyncAPI, and WebSocket hibernation ([changelog](https://rivet.dev/changelog/)). Cloudflare's: [invoking Durable Object methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/), [namespaces](https://developers.cloudflare.com/durable-objects/api/namespace/), and [WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

| Topic                 | Rivet                                                                                                                                                                                                                                                                | Durable Objects                                                                                                                         | Us                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Routing               | A gateway at `/gateway/{actor_id}/…` that accepts actor ids only; actions at `…/action/{name}`. Names and keys resolve to ids through the management API (`GET /actors?name=&key=`, or `PUT /actors` to get or create), which the client hides behind `getOrCreate`. | No public routing. The application's own Worker maps a request to `idFromName` or `getByName` and calls the stub by RPC or `fetch()`.   | The key is in the URL, `/actors/{Actor}/{id}/{Member}`, so no lookup round trip and no create endpoint: the first command creates the actor, and `createdBy` and `authorize` gate it. Any runner serves any route. |
| Retries and identity  | Actions carry no idempotency key or dedup; docs ask handlers to be idempotent where it matters.                                                                                                                                                                      | None built in.                                                                                                                          | Every command carries a v1 id in `Idempotency-Key`; a retry replays the receipt, including declared failures, and expiry is enforced after pruning.                                                                |
| Authentication        | Self-hosted actors are public by default; per-actor `onBeforeConnect` or `createConnState` validates connection `params`; headers work only for stateless HTTP actions.                                                                                              | Whatever the Worker implements.                                                                                                         | `Actor.serve` has no default: a provider or the explicit `Actor.auth.none`. A per-request caller, then the `authorize` hook for every member, with a stated revocation bound on sessions.                          |
| Errors                | `UserError` with `code` and `metadata`; any other error becomes `internal_error`.                                                                                                                                                                                    | RPC rethrows the error without a stack trace.                                                                                           | Declared errors as their schemas and statuses, `ActorError` reasons with `isRetryable` and `retryAfter`, and opaque defects.                                                                                       |
| Realtime              | `.connect()` over WebSocket with live, non-durable events; WebSocket hibernation keeps sockets across sleep.                                                                                                                                                         | The Hibernation WebSocket API keeps clients connected while the object is evicted; per-socket state goes through `serializeAttachment`. | SSE feeds of durable events that resume from a cursor, and WebSocket connections that park, survive graceful moves, and resync in place after a crash (ADR 0023).                                                  |
| Machine-readable spec | OpenAPI and AsyncAPI.                                                                                                                                                                                                                                                | None.                                                                                                                                   | OpenAPI 3.1 derived from the same `HttpApi` that serves the routes; AsyncAPI deferred.                                                                                                                             |
| Wire encoding         | JSON or CBOR.                                                                                                                                                                                                                                                        | Structured clone over RPC.                                                                                                              | JSON through the persistence codec only, in v1.                                                                                                                                                                    |

We're behind on wire encodings (no CBOR) and on AsyncAPI, and both are cheap additions later. Actions over the socket are a deliberate difference (Q7). The rest is the product's position: the key in the URL, a command id on every write, and auth that can't be forgotten.

## Amendments

| Document                                                                         | Was                                                                         | Becomes                                                                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Protocol](../contracts/protocol.md)                                             | transport-neutral frames; `x-request-id` echo                               | Adds the served mapping: routes, `Idempotency-Key`, `/protocol` and `/command-ids`, tokens, the WebSocket envelope, and SSE framing, by reference to this ADR.   |
| [Error model](../contracts/error-model.md)                                       | 410, 400, 403 reserved; `retryAfter` never populated                        | The status and close-code table; fields of `InvalidInput` and `TransportError`; `InvalidCommandId.code`; `Unauthorized`'s credential codes; `retryAfter` values. |
| [TypeScript SDK](../api/03-typescript-sdk.md)                                    | "identity format, expiry metadata, and error mappings still require design" | Minting against the server clock, the retry table, header functions, and the read-your-writes token.                                                             |
| [Server API](../api/01-server-api.md)                                            | `Actor.serve` requires auth                                                 | `Actor.serve({ actors, auth, basePath?, openapi?, origins?, limits? })` and the `Actor.auth` providers.                                                          |
| [10 security](../contracts/10-security.md)                                       | per-call callers; `Actor.auth.none`                                         | Tenant only from the provider; no System callers from providers; the principal limit; credentials never in URLs; the origin check on upgrades.                   |
| `authorize` hook ([ADR 0023](0023-connections-parking-and-streams.md) section 8) | `kind` is `command`, `query`, `open`, `stream`, or `reauthorize`            | Adds `feed`, with `command` set to the event tag.                                                                                                                |
| [Failure matrix](../verification/02-failure-matrix.md)                           | –                                                                           | Adds the served-protocol rows listed under Evidence.                                                                                                             |

## Open questions and recommended defaults

These need Dallen's decision. Each has a default that M3.2, M3.3, and M3.4 build if nobody objects, the cases that prove it, and the benchmark that measures it.

**Q1. Route shape: one path per member, or one RPC endpoint?** Default: one path per member (section 1). OpenAPI describes it naturally, proxies and access logs see which member ran, and per-route metrics and rate limits need no body parsing. The alternative, `POST /rpc` with `{ actor, id, member, input }` in the body, is simpler to route but opaque to every HTTP tool.

```sh
curl -X POST https://chat.example.com/api/actors/Room/r1/Post \
  -H "authorization: Bearer $TOKEN" -H "idempotency-key: $(curl -s -X POST -H "authorization: Bearer $TOKEN" https://chat.example.com/api/command-ids | jq -r .commandId)" \
  -H "content-type: application/json" -d '{"body":"hello"}'
```

- Cases: `routes keyed, singleton, and minted actors to the right ref`; `treats ids containing /, %, .., and non-ASCII as one opaque segment`; `answers an internal member exactly like an unknown one`.
- Benchmark: `http` measures routing cost within transport overhead.

**Q2. How does a client without the database clock mint a valid v1 id?** Default: it learns the database clock from `/protocol` and `durable-now`, subtracts a margin, and thin clients use `POST /command-ids` (section 2). The alternatives are a future-clock grace at admission, which supersedes ADR 0007's "no future-clock grace" and lets a fast clock mint ids that live past the retry window, or a server-minted id when the header is missing, which can't be retried after a lost response.

```ts
const { now, retryWindowMs } = await (await fetch("/api/protocol")).json()
const offset = now - (sent + received) / 2
const issuedAt = Math.floor(Date.now() + offset - Math.max(1000, received - sent))
const commandId = `v1.${issuedAt}.${issuedAt + retryWindowMs}.${crypto.randomUUID()}`
```

- Cases: `admits ids minted by a client whose clock is 10 minutes fast or slow`; `rejects a future id with InvalidCommandId code future and never reminted by the client`; `lets the client remint after InvalidCommandId code window, and the old id is never admitted`; `rejects a command without Idempotency-Key before any turn`; `mints ids from the database clock at /command-ids without writing`.
- Benchmark: `client` reports the cost of the first `/protocol` call and of the minting path.

**Q3. Which header carries the id?** Default: `Idempotency-Key` in, `x-request-id` out (section 2). A custom `durable-command-id` would avoid depending on an IETF draft, but generators, gateways, and API consoles already know `Idempotency-Key`, and the draft's `409` and `422` meanings agree with ours.

```http
POST /api/actors/Room/r1/Post
idempotency-key: v1.1790000000000.1790086400000.9b2f0c1e-2a4d-4c61-8e7a-3f1d2c0b9a77

HTTP/1.1 409 Conflict
x-request-id: v1.1790000000000.1790086400000.9b2f0c1e-2a4d-4c61-8e7a-3f1d2c0b9a77
{ "_tag": "ActorError", "reason": { "_tag": "CommandConflict", "commandId": "v1.…" }, "isRetryable": false }
```

- Cases: `echoes the command id as x-request-id on success, declared failure, and every ActorError`; `ignores an x-request-id request header injected by a proxy`.
- Benchmark: none beyond `http`; a header adds no statement.

**Q4. One auth provider per server, or per actor?** Default: one per `Actor.serve`; an application with public and private actors mounts two servers at two base paths. A per-actor map is flexible, but it puts the choice of which actors are public far from the routes, and a missing entry would have to default to something.

```ts
const Public = Actor.serve({ actors: [Status], auth: Actor.auth.none, basePath: "/public" })
const Private = Actor.serve({
  actors: [Room, Digest],
  auth: Actor.auth.jwt({ issuer, audience, jwks }),
  basePath: "/api",
})
HttpRouter.serve(Layer.mergeAll(Public, Private))
```

- Cases: `gives concurrent requests with different tokens different principals` (H1); `fails missing, invalid, and expired credentials with their codes before any turn and never as Anonymous`; `ignores an authorization header under Actor.auth.none`; `takes the tenant only from the provider`; `refuses a provider that returns a System caller`.
- Benchmark: `http` with `Actor.auth.jwt` (ES256) against `Actor.auth.none`, to price verification per request.

**Q5. Principal size limit.** Default: `subject` at most 512 UTF-8 bytes and the encoded caller at most 1 KiB (section 3). The limit protects the Cluster envelope header on every command, so it is fixed rather than a policy.

```ts
Actor.auth.jwt({ issuer, audience, jwks, subject: (claims) => claims.email }) // an email over 512 bytes fails invalid_credentials
```

- Cases: `serializes a 512-byte subject through a cross-runner command` (harness, the **Cluster header size** gate); `fails a 513-byte subject with invalid_credentials and logs no credential`.
- Benchmark: T9's largest-principal run, with a 1 KiB caller on the `http` scenario.

**Q6. Where does a WebSocket carry its credential?** Default: in the first `hello` frame, or on the upgrade for non-browser clients and cookie providers (section 8). A query-string token works with every browser API but lands in access logs and `Referer`; `Sec-WebSocket-Protocol` smuggling is a hack that some proxies rewrite.

```ts
const socket = new WebSocket(
  "wss://chat.example.com/api/actors/Room/r1/Presence",
  "durable-actors.v1",
)
socket.onopen = () =>
  socket.send(
    JSON.stringify({ t: "hello", authorization: `Bearer ${token}`, params: { user: me } }),
  )
```

- Cases: `wakes nothing before hello authenticates`; `ends with InvalidInput when hello does not arrive in 10 seconds`; `refuses an upgrade from an origin not listed`; `ends with Unauthorized expired at the credential's expiry without a reauthenticate reply`; `accepts reauthenticate for the same caller and ends the session for a different one`.
- Benchmark: `ws` measures `hello`-to-`open` latency and `reauthenticate` load at 10^4 sessions.

**Q7. May commands travel over an open WebSocket?** Default: no. Commands are HTTP requests even while a socket is open, so there is one way to send a command, one retry story, and one place where `Idempotency-Key` is enforced. Rivet sends actions over its connection; the saving is a request's headers, which HTTP/2 mostly removes. Revisit if `ws` shows the difference matters.

```ts
const presence = await room.Presence.connect({ user: me }) // frames only
await room.Post({ body: "hi" }) // always HTTP, with its own command id
```

- Cases: `answers a command-shaped message on a socket as InvalidInput and runs nothing`.
- Benchmark: `ws` compares a command over HTTP/2 with a frame round trip on an open socket.

**Q8. Event feeds: a parked framework connection over SSE, or something else?** Default: SSE, one response per feed, backed by a framework connection that parks and that its holder resyncs from `actor_events` by itself (section 7). An `Actor.stream` with `read.follow` would keep its actor resident for as long as anyone watches (ADR 0023 Q7). Multiplexing every feed and connection over one WebSocket avoids HTTP/1.1's six-connection limit, but adds a session layer and loses `EventSource` and `Last-Event-ID`.

```ts
for await (const entry of room.events(MessagePosted, { after: cursor })) render(entry) // M3.5, over fetch-based SSE
```

```sh
curl -N -H "authorization: Bearer $TOKEN" -H "last-event-id: 42" \
  "https://chat.example.com/api/actors/Room/r1/events?event=MessagePosted"
```

- Cases: contract 07's four transport tests over SSE (snapshot and live race, loss, replay, revocation); `resumes from Last-Event-ID with no gap or repeat`; `answers RetentionGap with 410 before streaming`; `keeps an idle feed parked, then delivers an event from a timer that woke the actor on another runner` (harness); `resyncs a feed at its holder after an owner kill with no client-visible gap` (harness, C4); `ends a feed at credential expiry and resumes after reconnect with nothing lost`.
- Benchmark: `sse`: fan-out to 10^4 feeds on one actor across two runners, commit-to-last-delivery p99, a reconnect wave of 10^4 `Last-Event-ID` clients, and the extra statement on the first emitting turn.

**Q9. Wire encoding.** Default: JSON only, through the persistence codec (section 1). CBOR or MessagePack would shrink binary payloads and parse faster, but every client, proxy log, and generator reads JSON, and a second encoding doubles the conformance matrix. Revisit when a benchmark shows encoding dominating latency.

```http
content-type: application/json
{ "body": "hello", "attachment": "aGVsbG8=" }
```

- Cases: `round-trips Uint8Array, DateTimeUtc, and tagged classes over HTTP exactly as receipts store them`; `answers another content type with 415`.
- Benchmark: `http` reports encode and decode time per request for a 64 KiB payload.

**Q10. OpenAPI only, or AsyncAPI too?** Default: OpenAPI 3.1 now, with feeds, streams, and connections listed and their frame schemas under `components`; AsyncAPI waits for a user who needs it. Rivet ships both.

```ts
Actor.serve({ actors: [Room], auth, openapi: { path: "/openapi.json" } })
// GET /api/openapi.json → operationId "Room.Post", x-durable-transport "websocket" on "Room.Presence"
```

- Cases: `omits internal members, executors, and routes from the document` (**Internal section**); `documents every served route and serves every documented one`; `produces a byte-identical document for the same definitions`.
- Benchmark: none; generation runs once at startup, and `http` reports startup time.

**Q11. Should an actor type's events be served by default?** Default: yes. Every declared event of a served actor is reachable at its feed route, and `authorize` with `kind: "feed"` decides who reads it. An opt-in per event is safer against accidental exposure, but hooks already deny unknown kinds, and a second switch is one more place to forget.

```ts
const authorize = ({ kind, caller, ref, command }) =>
  kind === "feed"
    ? rooms.isMember(caller, ref)
    : kind === "command"
      ? rooms.canPost(caller, ref, command)
      : Effect.succeed(false)
```

- Cases: `calls authorize with kind feed for each requested event before reading`; `denies a feed when the hook denies unknown kinds`.
- Benchmark: covered by `sse`.

## Alternatives

- **A future-clock grace for served ids.** Rejected (Q2): it weakens ADR 0007 for every caller to spare clients a clock offset.
- **Server-minted ids when the header is missing.** Rejected: the caller can't retry a lost response, which is the failure ids exist for.
- **The tenant in a header or path.** Rejected: client-supplied tenant is input, not authority ([contract 10](../contracts/10-security.md)).
- **Credentials in WebSocket or SSE URLs.** Rejected: they leak into logs, history, and `Referer`.
- **Event feeds as `Actor.stream`.** Rejected (Q8): every watcher would pin its actor.
- **A client generated from `/openapi.json`.** Rejected for TypeScript: the definition already has the schemas and declared-error classes, and a fetched document can drift from the bundle. Other languages use it.
- **GET for queries.** Rejected (section 1): inputs in URLs, and two input styles for one API.

## Consequences

- **M3.2 is buildable now.** Sections 1 to 6 need nothing from M2, so HTTP serving and OpenAPI can ship before M2.10. Streams and workflows appear on the wire only once their members exist.
- **Statements per operation don't change.** A served command runs exactly the embedded turn, so `http` must show the same statement count as the embedded path, which T2's gate can enforce. Feeds add one statement to the first emitting turn per activation, and only for served actor types.
- **Clients learn one clock.** Every client pays one `/protocol` request per `baseUrl` before its first command, or one `/command-ids` request per command if it can't keep a clock offset.
- **`retryAfter` becomes real.** `ActorError.retryAfter` returns a value for three reasons, which changes the in-process handle's backoff to match.
- **Error schemas grow.** `InvalidInput` and `TransportError` gain fields; `InvalidCommandId` gains `code`; `Unauthorized.code` gains `missing_credentials`, `invalid_credentials`, and `expired`. These are additive for existing embedded callers.
- **`authorize` hooks see a new kind.** A hook that denies unknown kinds keeps feeds closed until it handles `feed`.
- **Decisions still open elsewhere.** Signed assertions (ADR 0031), MCP and generated clients (M6.6), and offline commands (M6) build on this wire without changing it.

## Evidence required

M3.2 puts its cases in `conformance/http.ts`, M3.4 in `conformance/client.ts`, and M3.3 in `conformance/transports.ts`. All run against a real HTTP server on PGlite and Postgres; cross-runner, crash, and contention cases run on the M2.1 harness against real Postgres.

**M3.2 (`http`):**

- `gives concurrent requests with different tokens different principals` (**Per-call caller over HTTP**, H1)
- `fails missing, invalid, and expired credentials with their codes before any turn and never as Anonymous`
- `replays a declared failure with the same tag, fields, and status` (R3)
- `replays a committed output when a response is dropped and the same Idempotency-Key is retried`
- `returns 409 CommandConflict for a reused id with different input, without running the handler`
- `returns 410 CommandExpired for an expired id even after its receipt is pruned`
- `rejects a command without Idempotency-Key, and a malformed, future, or wrong-window id, before any turn`
- `echoes the command id as x-request-id on every command response`
- `sets retryAfter and retry-after on ActorUnavailable, RunnerAtCapacity, and MailboxFull`
- `answers an internal member exactly like an unknown one, and omits it from OpenAPI` (**Internal section**)
- `routes keyed, singleton, and minted actors, and treats special characters in ids as one segment`
- `keeps running a command whose HTTP client disconnected, and replays it on retry`
- `answers a defect with an opaque 500 and writes no receipt`
- `takes the tenant only from the provider, and refuses a provider that returns a System caller`
- `serializes a 512-byte subject through a cross-runner command and rejects 513 bytes` (**Cluster header size**, harness)
- `documents every served route and serves every documented one; the document is deterministic`
- `serves the same statement count per command as the embedded path`

**M3.4 (`client`):**

- R3 through the client, and the rows "Caller gives up before a reply" and "External identity expires before delivery or retry" through the client
- `keeps the command id across retries, a token refresh, and a TransportError`
- `never mints a replacement id after CommandExpired or InvalidCommandId code future`
- `mints valid ids with a client clock 10 minutes fast or slow`
- `sends the greatest durable-version it has seen as durable-min-version`
- `imports no runtime, SQL, or Cluster module in a browser build`

**M3.3 (`transports`),** in addition to ADR 0023's transport cases:

- contract 07's four transport tests over SSE feeds and WebSocket connections
- `resumes a feed from Last-Event-ID with no gap or repeat`, and `answers RetentionGap and UnknownCursor before streaming`
- `resyncs a feed at its holder after an owner kill with no client-visible gap` (harness, C4)
- `carries Resync, ResyncReplayed, and ResyncDone in their own envelope, and treats an application frame tagged Resync as a member frame`
- `reauthenticates a session before its credential expires, and ends it with Unauthorized expired when the client doesn't answer`
- `wakes nothing before hello authenticates`, and `refuses upgrades from origins not listed`
- `reports a socket dropped without end as SessionEnded HolderLost with resync`

**Failure-matrix rows added:** "Command response lost over HTTP", "Client clock ahead of the database clock", "Proxy injects its own request id", "Credential expires during a live session", "SSE feed reconnects after pruning", and "HTTP client disconnects mid-command".

**Benchmarks:** `http` (M3.2): warm command and query p50 and p99 over HTTP/1.1 keep-alive and HTTP/2 against the embedded handle, statements per operation (equal to embedded), JWT verification cost, and a 64 KiB payload. `client` (M3.4): the same through the Promise client, the first-call `/protocol` cost, and duplicate receipts under 1% injected response loss (must be zero). `sse` and `ws` (M3.3): as in Q8 and Q6, plus parked-socket memory and reconnect waves; T9 repeats them on a cloud VM.

## Revisit conditions

Revisit when a supported client can't keep a clock offset and `/command-ids` is too slow, when a workload needs commands over sockets (Q7) or a binary encoding (Q9), when HTTP/1.1 connection limits hurt feeds in practice (Q8), when hosted ingress (ADR 0031) moves authentication and holders to an edge tier, or when M4.9 needs a token that isn't a single integer.
