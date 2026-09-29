# Wire protocol

**Responsibility:** define transport-neutral frames.  
**Authority:** normative API contract.  
**Owner role:** protocol/SDK.
**Change policy:** a change requires an ADR and a conformance-suite update.

Each command request MUST carry actor identity, tenant routing derived at the trusted edge, a client-minted command id, caller attribution, trace context, and encoded input. HTTP MUST echo the command id as `x-request-id`. Retries MUST preserve the command id.

External receipt reads and replay MUST require current authorization for the original logical caller or explicit operator authority. External command delivery MUST reject expired identities even after pruning, under the [receipt contract](04-receipts.md). Trusted internal recovery of accepted work MUST remain distinct from new external admission. Any identity-bound expiry metadata MUST survive retries unchanged; transport adapters MUST NOT silently refresh it or mint a replacement id. The first embedded encoding is specified in [ADR 0007](../decisions/0007-foundation-command-protocol.md): `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`, database-clock admission, and an immutable deployment retry window. Transport and rolling-version support remain gated; see [versioning](../api/versioning.md).

The runtime MUST decode caller identity per request and serialize it into the envelope within the configured cluster-header limit. Missing credentials on an authenticated endpoint MUST return `ActorError(Unauthorized)` before a turn runs.

Commands MUST map committed outputs and declared failures through receipts. Framework failures MUST use the [single error envelope](error-model.md). Queries read committed rows without waking an activation. Event streams MUST carry cursors. Connections declared by `Actor.connection` MUST carry typed frames and restore parked connection state. They also carry framework control frames outside each member's frame unions: `Resync { after, reason, deadline }` and `ResyncReplayed { through }` from server to client after an ungraceful owner death, and `ResyncDone { through }` from client to server, in an envelope variant separate from member frames; only the holder creates `Resync` and consumes `ResyncDone` ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)).

The Effect handle, Promise client from `@durable-actors/core/client`, HTTP, WebSocket, and SSE adapters MUST preserve these semantics rather than define independent lifecycle states. Public spans MUST use `durable-actors.<Actor>/<Command>`.

## Served mapping ([ADR 0027](../decisions/0027-served-protocol.md))

M3.2 implements the HTTP command and query routes, `/protocol`, `/command-ids`, and OpenAPI; M3.3 serves connection members as WebSocket sessions and declared `feeds` as SSE event feeds; streams are a later slice. Evidence: [`conformance/http.ts`](../verification/01-conformance.md#served-http-m32) and [`conformance/transports.ts`](../verification/01-conformance.md#served-websocket-connections-m33).

- Each public member has one route under the server's base path: `POST /actors/{Actor}/{id}/{Member}` for commands, reducers, queries, and workflow starts; `GET …/events?event=…&after=…` for the events an actor type declares in `feeds`, over SSE; `POST …/{Stream}` for streams over SSE; and a WebSocket upgrade at `…/{Connection}`. Singletons omit `{id}`. Internal members have no route and answer like unknown ones.
- A command carries its v1 id in `Idempotency-Key`. A command without one is rejected before any turn, and the server never mints an id for a caller. Clients mint ids against the database clock, learned from `GET /protocol` and the `durable-now` response header, or obtained from `POST /command-ids`, and never mint a replacement for a sent id on their own.
- Tenant and caller come only from the configured auth provider, never from the path, a header the client controls, or a frame.
- Queries may carry `durable-min-version`, and command responses will carry `durable-version`, the read-your-writes token; both are inert until read-your-writes replicas ship. `Actor.serve` does not issue `durable-version` yet (commit versions arrive with `0019_commit_version`, M4.9), so the Promise client's token is forward-compatible plumbing and gives no read-your-writes guarantee today.
- WebSocket messages are JSON with a `t` discriminator. Member frames travel only inside `frame`, so framework control frames (`hello`, `open`, `resync`, `resyncReplayed`, `resyncDone`, `reauthenticate`, `reauthenticated`, `end`) can never be confused with them. SSE feed messages carry the event cursor as their `id`, and `Last-Event-ID` resumes after it.

## Hosted edge assertions ([ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md))

A hosted runner serves with `Actor.auth.assertion`, and admits a request only with a valid assertion from the edge, bound to exactly that request. Evidence: [`conformance/assertions.ts`](../verification/01-conformance.md#hosted-assertions-m48).

- **Header.** The edge sends the assertion in `durable-assertion` as a compact JWS. A WebSocket `hello` or `reauthenticate` frame carries it as `authorization: Bearer <jws>` instead. The edge removes any `durable-assertion` a client sent.
- **JWS header.** `alg` is `EdDSA` (Ed25519) and nothing else, `typ` is `durable-assertion+jwt`, `kid` names the key, and `crit` is refused.
- **Claims.** `iss` (the edge issuer), `aud` (the deployment id), `region`, `iat`, `exp`, `tenant`, `caller` (an encoded `User` or `Anonymous`), and `req` (the binding below) are required. `exp − iat` is at most 60 seconds, and 5 seconds of skew are allowed on `iat` and `exp`. `sid` is the streaming session id, on WebSocket assertions only. `cexp` is the external credential's own expiry in epoch seconds, which caps a live session; the assertion's `exp` never does. `actor`, `id`, `member`, and `cid` are for logs and never checked.
- **Canonical request binding.** `req` is the lowercase hex SHA-256 of these UTF-8 lines joined by `\n`: `durable-assertion/v1`; the method in uppercase; the path with percent-encoding uppercased, escapes of unreserved characters decoded, and dot segments removed; the query parameters sorted by name then value, each percent-encoded, joined by `&`; the raw `Idempotency-Key` value, or an empty line; and the lowercase hex SHA-256 of the body bytes as forwarded. A WebSocket upgrade, its `hello`, and an SSE feed bind a `GET` with an empty body. A renewal binds `durable-assertion/v1`, `REAUTHENTICATE`, the session's upgrade path, and its `sid`, and must carry the `sid` the session opened with.
- **Refusals.** A missing assertion is `401 Unauthorized { code: "missing_credentials" }`. An assertion past `exp` plus skew is `expired`. Any other failure (signature, key, algorithm, issuer, deployment, region, lifetime, or binding) is `invalid_credentials`. All of them come before any turn, and none falls back to another credential.
