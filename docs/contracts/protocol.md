# Wire protocol

**Responsibility:** define transport-neutral frames.  
**Authority:** normative API contract.  
**Owner role:** protocol/SDK.
**Change policy:** a change requires an ADR and a conformance-suite update.

Each command request MUST carry actor identity, tenant routing derived at the trusted edge, a client-minted command id, caller attribution, trace context, and encoded input. HTTP MUST echo the command id as `x-request-id`. Retries MUST preserve the command id.

External receipt reads and replay MUST require current authorization for the original logical caller or explicit operator authority. External command delivery MUST reject expired identities even after pruning, under the [receipt contract](04-receipts.md). Trusted internal recovery of accepted work MUST remain distinct from new external admission. Any identity-bound expiry metadata MUST survive retries unchanged; transport adapters MUST NOT silently refresh it or mint a replacement id. The first embedded encoding is specified in [ADR 0007](../decisions/0007-foundation-command-protocol.md): `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>`, database-clock admission, and an immutable deployment retry window. Transport and rolling-version support remain gated; see [versioning](../api/versioning.md).

The runtime MUST decode caller identity per request and serialize it into the envelope within the configured cluster-header limit. Missing credentials on an authenticated endpoint MUST return `ActorError(Unauthorized)` before a turn runs.

Commands MUST map committed outputs and declared failures through receipts. Framework failures MUST use the [single error envelope](error-model.md). Queries read committed rows without waking an activation. Event streams MUST carry cursors. Connections declared by `Actor.connection` MUST carry typed frames and restore parked connection state. They also carry framework control frames outside each member's frame unions: `Resync { after, reason, deadline }` and `ResyncReplayed { through }` from server to client after an ungraceful owner death, and `ResyncDone { through }` from client to server, in an envelope variant separate from member frames; only the holder creates `Resync` and consumes `ResyncDone` ([ADR 0023](../decisions/0023-connections-parking-and-streams.md)).

The Effect handle, Promise client from `durable-actors/client`, HTTP, WebSocket, and SSE adapters MUST preserve these semantics rather than define independent lifecycle states. Public spans MUST use `durable-actors.<Actor>/<Command>`.

## Served mapping (proposed, [ADR 0027](../decisions/0027-served-protocol.md))

M3.2 implements the HTTP command and query routes, `/protocol`, `/command-ids`, and OpenAPI; feeds, streams, and WebSocket sessions are later slices. Evidence: [`conformance/http.ts`](../verification/01-conformance.md#served-http-m32).

- Each public member has one route under the server's base path: `POST /actors/{Actor}/{id}/{Member}` for commands, reducers, queries, and workflow starts; `GET …/events?event=…&after=…` for the events an actor type declares in `feeds`, over SSE; `POST …/{Stream}` for streams over SSE; and a WebSocket upgrade at `…/{Connection}`. Singletons omit `{id}`. Internal members have no route and answer like unknown ones.
- A command carries its v1 id in `Idempotency-Key`. A command without one is rejected before any turn, and the server never mints an id for a caller. Clients mint ids against the database clock, learned from `GET /protocol` and the `durable-now` response header, or obtained from `POST /command-ids`, and never mint a replacement for a sent id on their own.
- Tenant and caller come only from the configured auth provider, never from the path, a header the client controls, or a frame.
- Queries may carry `durable-min-version`, and command responses carry `durable-version`, the read-your-writes token; both are inert until read-your-writes replicas ship.
- WebSocket messages are JSON with a `t` discriminator. Member frames travel only inside `frame`, so framework control frames (`hello`, `open`, `resync`, `resyncReplayed`, `resyncDone`, `reauthenticate`, `reauthenticated`, `end`) can never be confused with them. SSE feed messages carry the event cursor as their `id`, and `Last-Event-ID` resumes after it.
