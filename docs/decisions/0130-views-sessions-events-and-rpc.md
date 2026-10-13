# ADR 0130: Views, sessions, presence, events and the RPC transport

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** decide how clients read and watch actors, how presence works, how events reach clients, the one wire protocol, how callers are bound to requests and sessions, and readiness.

**Owner role:** realtime and protocol.

## Context

0.1 serves HTTP command and query routes, WebSocket connections with parking and holder epochs, SSE event feeds with durable cursors, SSE streams and watch queries, an OpenAPI document and a Promise client ([ADR 0023](0023-connections-parking-and-streams.md), [ADR 0027](0027-served-protocol.md), [ADR 0055](0055-query-observation.md), [ADR 0058](0058-offline-command-queue.md)). Each transport has its own envelope and error mapping.

D14 fixes one RPC group served over WebSocket and HTTP at `/rpc`, JSON on the wire. D23 rules 6 and 9 make state and lists readable and watchable by default, views optional, and the Effect client the only client. Hosted runners verify a signed assertion per forwarded request ([ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md)); a multiplexed socket carries many calls under one upgrade, which needs a written rule.

## Decision

### 1. One RPC group, two transports

- The RPC group is derived from the actor contracts (Effect Cluster's `EntityProxy` over each actor entity) and served with `RpcServer` over WebSocket and over HTTP at one path, `/rpc`, JSON serialization on both. There is no derived HTTP API, no OpenAPI document and no SSE.
- Every call names the actor type, id and member. Action calls carry a client-minted external command id ([contract 03](../contracts/03-durability.md)). Tenant and caller never come from the call; they come from `auth`.
- `GET /ready` stays outside the RPC group (§6).
- At rest, segments and pages use `SchemaBinary`; switching the WebSocket to binary is revisited only if serialization exceeds 15% of runner CPU at T2.

### 2. Reading and watching

- `handle.state` is a `Stream` whose first element is the full encoded state and whose later elements are JSON patches (`Schema.toDifferJsonPatch`) computed from consecutive durable states. A one-shot read is `Stream.runHead`.
- `handle.<list>.range(...)` reads a range; watching it streams the range's full value, then patches.
- `handle.<view>(params)` streams a view's value the same way. A view is a pure, synchronous function of durable state ([ADR 0125](0125-synchronous-deterministic-actions.md)).
- Every value a client sees derives from the shard's durable prefix. Speculative state is never streamed. Consecutive equal values (by `Schema.toEquivalence`) are not sent.
- Reads are served by the shard owner from memory, after the `T_valid` check of [ADR 0126](0126-shard-ownership-on-the-bucket-log.md); a client whose action completed reads its effect (read-your-writes) on every later read of that actor.
- A stream whose consumer falls behind its bounded buffer MUST either replace the queued patches with one new full frame or end with `SessionEnded { cause: "SlowConsumer", resync: true }`; it never skips a patch silently.
- When the actor's shard moves, its streams end with `SessionEnded { cause: "OwnerMoved", resync: true }`; the client resubscribes and receives a full frame.
- A full frame resets the client baseline regardless of its owner-local version. Patch ordering is checked within that baseline; comparing versions across owners would discard a new owner's valid state. Equal decoded values are suppressed using schema equivalence after decoding, including equal resubscription baselines.

### 3. Presence

- A contract that declares `presence` enables `connect` and `disconnect` handlers and `handle.join(params)`. `join` is scoped: acquiring it runs `connect` as a durable action with a fresh connection id in `ctx.connection`; releasing the scope runs `disconnect`.
- The shard records open connections in its state. Every `connect` that becomes durable is followed by exactly one durable `disconnect` for the same connection: on scope release, on session loss detected by the owner, or on the next owner's open, which runs `disconnect` for every connection the previous owner recorded, because every session to the previous owner ended with it.
- `connect` and `disconnect` run as the session's caller.

### 4. Events

- Events declared with `Actor.event(schema)` and emitted by an action with `ctx.emit` are published after the action's segment is durable, to the sessions subscribed at that moment. They are not stored, not replayed, and lost when nobody is subscribed.
- Events emitted by a job are published when emitted. They are not in the log, may repeat if the job body replays, and carry no ordering guarantee relative to action events ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md)).
- Events replace 0.1's executor progress frames and durable event feeds; there are no cursors and no `RetentionGap`.

### 5. Callers on requests and sessions

- **HTTP.** `auth` resolves caller and tenant per request. Concurrent requests with different credentials receive different callers.
- **WebSocket.** The caller and tenant are bound when the socket opens; every call over the socket, actions included, runs as that caller. The binding is rechecked every `reauthorizeEvery` (default 60 seconds) by running `auth` again and `access` with kind `reauthorize`. A revoked caller's session ends with `Unauthorized` code `access_denied`; when no check succeeds within the bound, it ends with `Unauthorized` code `reauthorization_unavailable`; queued frames are discarded. The bound is also capped by the credential's own expiry.
- **Hosted.** The edge signs one assertion per forwarded HTTP request, binding its canonical request string, and one at WebSocket upgrade carrying the session id `sid`; reauthentication goes through the edge with a fresh assertion for the same `sid` ([contract 10](../contracts/10-security.md), [protocol](../contracts/protocol.md)).
- View, list and state handlers bind the request's caller and tenant, never a layer-builder identity, as [ADR 0123](0123-read-phase-request-identity.md) requires; binding identity grants no mutation capability.
- Browser requests carrying an `Origin` that is neither the server's own nor configured are refused before authentication on every route, including the WebSocket upgrade.

### 6. Readiness

`GET /ready` answers `200 { ready: true }` or `503 { ready: false, reason }`, with `reason` one of `draining`, `drained`, `storage` (the store is unreachable or its credential cannot be refreshed), `routing` (not registered, or an assigned shard is not open), `peering` (the runner's mTLS credentials are expired or unloadable) or `unregistered`. Drain makes the runner unready before it stops admission. Readiness reads runner state only; it is never inferred from memory, types or a lease.

## Supersedes and amends

- Supersedes [ADR 0023](0023-connections-parking-and-streams.md) — scope: in full; revocation-bound principles carry in §5.
- Supersedes [ADR 0027](0027-served-protocol.md) — scope: routes, envelopes, SSE, OpenAPI and the Promise mapping; authentication, origin and command-id rules carry.
- Supersedes [ADR 0030](0030-executor-progress-frames.md) — scope: in full; job events replace progress frames.
- Supersedes [ADR 0055](0055-query-observation.md) — scope: in full.
- Supersedes [ADR 0058](0058-offline-command-queue.md) — scope: in full; the same-id retry rule carries in [contract 03](../contracts/03-durability.md).
- Supersedes [ADR 0060](0060-generated-protocols-mcp-and-python-client.md) — scope: in full; closed as not accepted for 0.2.0.
- Amends [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md): per-request assertions and session `sid` binding carry onto `/rpc`.
- Amends [ADR 0045](0045-cookie-security-schemes.md): cookie credentials apply to `/rpc` over HTTP and the WebSocket upgrade.
- Amends [ADR 0052](0052-read-your-writes-commit-versions.md): read-your-writes holds because the owner serves reads; no version token.
- Amends [ADR 0053](0053-served-readiness-route.md): readiness carries with the reasons in §6.
- Amends [ADR 0059](0059-caller-and-tenant-defaults.md): socket calls run as the session caller.
- Amends [ADR 0086](0086-runner-mutual-tls.md): the peer SAN names store and release ([contract 10](../contracts/10-security.md)).
- Amends [ADR 0123](0123-read-phase-request-identity.md): its binding rule governs views, state and list reads.
- Amends [ADR 0048](0048-mint-progress-and-inspection-record-corrections.md): its progress corrections are historical.

## Alternatives

- **Two protocols** (RPC over WebSocket plus a derived HTTP API with OpenAPI). Rejected by D14: two schemas and two error mappings to secure and test.
- **Commands only over HTTP, sockets only for streams.** Rejected: it splits one client handle in two; binding commands to the session caller with a recheck bound keeps one handle.
- **Durable event feeds with cursors.** Rejected: events are for data that must not be stored; durable facts belong in state or lists.
- **Views as the only read path.** Rejected by D23 rule 6.
- **Binary on the wire.** Deferred: JSON serves both transports and debugging.

## Consequences

- Clients reconnect and resubscribe after owner moves; they never see partial history.
- Presence is exact over owner changes at the cost of a `disconnect` storm on reopen after a crash.
- Hosted socket calls run under one assertion per session, rechecked every minute; contract 10 states the change.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | Spike: `EntityProxy.toRpcGroup` over a two-actor contract served over WebSocket and HTTP on Node and Bun                                                                                                                                                          |
| E4        | Client conformance on both runtimes: full frame then patches, read-your-writes, slow consumer, owner move, reauthorization at the bound and on revocation, origin refusal, per-call callers over HTTP, session caller over WebSocket; I2 for every streamed value |
| E4        | Presence: crash of the gateway and of the owner both yield exactly one `disconnect` per durable `connect`                                                                                                                                                         |

E4's results, and the cases still open (slow consumer and owner crash with presence), are in [E4 RPC and serving](../verification/e4-rpc-serve.md). [E3 cluster evidence](../verification/e3-cluster.md) adds public HTTP/WebSocket state resubscription through a non-owner after owner drain.

## Revisit when

- The Python client returns and needs a derived HTTP API.
- Serialization cost or bandwidth justifies binary frames.
- Applications need durable, replayable event streams.
