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

## Hosted assertions ([ADR 0031](../decisions/0031-hosted-ingress-tenant-directory-and-regions.md))

Implemented on runners by M4.8 (`Actor.auth.assertion`). Evidence: [`conformance/assertions.ts`](../verification/01-conformance.md#hosted-assertions-m48). A hosted edge forwards each request with a `durable-assertion` header, and removes any `durable-assertion` a client sent. A WebSocket `hello` or `reauthenticate` frame carries the assertion as `authorization: Bearer <jws>` instead. The assertion is a compact JWS with `alg` `EdDSA` (Ed25519) and nothing else, `typ` `durable-assertion+jwt`, and a `kid`; `crit` is refused. Its claims are `iss`, `aud` (the deployment), `region`, `iat`, `exp`, `tenant`, `caller` (an encoded `User` or `Anonymous`), `actor`, `id`, `member`, `cid` when the request carries a command id, `sid` on streaming assertions, `cexp`, and `req`. `exp − iat` is at most 60 seconds, and runners allow 5 seconds of skew on `iat` and `exp`. `cexp` is the external credential's own expiry in epoch seconds, which caps a live session; the assertion's short `exp` never does. `actor`, `id`, `member`, and `cid` are for logs and never checked. `req` is the lowercase hex SHA-256 of this UTF-8 string with lines joined by `\n`:

```text
durable-assertion/v1
<method>
<path, percent-encoding normalised to uppercase hex, no dot segments>
<query parameters sorted by name then value, each percent-encoded, joined by &>
<Idempotency-Key header value, or empty>
<lowercase hex SHA-256 of the body bytes exactly as forwarded>
```

Both sides also decode percent-escapes of RFC 3986 unreserved characters in the path, so `%41` is `A`. A WebSocket upgrade, its `hello`, and an SSE feed bind a `GET` with an empty body. A reauthentication assertion's string is `durable-assertion/v1`, `REAUTHENTICATE`, the session's upgrade path, and the `sid`, and it must carry the `sid` the session opened with. The runner rebuilds the string from what it received; any difference is `Unauthorized` `invalid_credentials` before any turn. A missing assertion is `missing_credentials`, one past `exp` plus skew is `expired`, and every other failure (signature, key, algorithm, issuer, deployment, region, or lifetime) is `invalid_credentials`; none falls back to another credential.

A runner with a key-set URL also answers `POST <basePath>/assertion-keys/refresh`, the edge's push after a signing key is revoked. The push carries, in `durable-assertion`, a JWS of `typ` `durable-key-refresh+jwt` with `iss`, `aud` (the deployment), `iat`, and `exp` (at most 60 seconds apart), signed by a key the runner holds. The runner rereads its key set at once and answers `204`. Any other push is `401`, and repeating one only rereads again.

## Served mapping ([ADR 0027](../decisions/0027-served-protocol.md))

M3.2 implements the HTTP command and query routes, `/protocol`, `/command-ids`, and OpenAPI; M4.2 adds `GET /ready` ([ADR 0053](../decisions/0053-served-readiness-route.md)); M3.3 serves connection members as WebSocket sessions, declared `feeds` as SSE event feeds, and `Actor.stream` members over SSE. Evidence: [`conformance/http.ts`](../verification/01-conformance.md#served-http-m32) and [`conformance/transports.ts`](../verification/01-conformance.md#served-websocket-connections-m33).

- Each public member has one route under the server's base path: `POST /actors/{Actor}/{id}/{Member}` for commands, reducers, queries, and workflow starts; `GET …/events?event=…&after=…` for the events an actor type declares in `feeds`, over SSE; `POST …/{Stream}` for streams over SSE; and a WebSocket upgrade at `…/{Connection}`. Singletons omit `{id}`. Internal members have no route and answer like unknown ones.
- A command carries its v1 id in `Idempotency-Key`. A command without one is rejected before any turn, and the server never mints an id for a caller. Clients mint ids against the database clock, learned from `GET /protocol` and the `durable-now` response header, or obtained from `POST /command-ids`, and never mint a replacement for a sent id on their own.
- Tenant and caller come only from the configured auth provider, never from the path, a header the client controls, or a frame.
- Every command response that committed or replayed a receipt MUST carry `durable-version`, the read-your-writes token: the primary's WAL position read on the turn's session after `COMMIT` ([ADR 0052](../decisions/0052-read-your-writes-commit-versions.md)). A query MAY carry `durable-min-version`. A replica MUST NOT answer it before replaying through that position, and the query falls through to the primary otherwise. A malformed `durable-min-version` MUST be refused with `InvalidInput`. Evidence: [`conformance/read-your-writes.ts`](../verification/01-conformance.md#read-your-writes-m49).
- WebSocket messages are JSON with a `t` discriminator. Member frames travel only inside `frame`, so framework control frames (`hello`, `open`, `resync`, `resyncReplayed`, `resyncDone`, `reauthenticate`, `reauthenticated`, `end`) can never be confused with them. Executor progress for a member that lists effects arrives as its own server message, `t: "progress"` with `effect`, `effectId`, `attempt`, `seq`, and `frame`, and no `cursor` or `event`; clients ignore a `t` they don't know. SSE feed messages carry the event cursor as their `id`, and `Last-Event-ID` resumes after it.

## Content routes ([ADR 0034](../decisions/0034-tenant-scoped-content-addressed-blobs.md))

Built by M4.13. `POST /content` authenticates like any route and uploads bytes and answers a `ContentRef` (`hash`, `size`, `grant`); the server computes the SHA-256. It is the one route exempt from `limits.requestBytes`: it takes `limits.contentBytes` (default and maximum 64 MiB), streams the body into 1 MiB chunks, and past the limit answers `413 InvalidInput { code: "too_large" }` and writes nothing. `POST /actors/{Actor}/{id}/content/{blob}/{name}/grant` issues a fresh grant for an entry the actor references, after `authorize` allows `<blob>.grant`. `GET /actors/{Actor}/{id}/content/{blob}/{name}` streams the entry's bytes as `application/octet-stream` with its `content-length`, after `authorize` allows `<blob>.get`. A blob the actor type does not declare as content, or a name it holds no reference under, answers `404 InvalidInput { code: "unknown_content" }`. Singleton actors omit `{id}`. A sweep between resolving the name and reading the bytes ends the body before any byte, short of its declared length. The OpenAPI document lists `POST /content` (`durable.uploadContent`) and each actor's `content` and `content.grant` operations; the member name `content` is reserved. On PGlite, whose one connection no upload may hold across client I/O, `POST /content` buffers the body in memory up to the limit instead of streaming it.
