# Wire protocol

Status: partially normative (0.2), owned by ADR 0130. [E4 RPC and serving](../verification/e4-rpc-serve.md) promotes One RPC group at `/rpc`, Calls, HTTP and WebSocket on Bun and Node, with `find` from [E7](../verification/e7-find-operators.md) and resubscription across an owner move from [E3](../verification/e3-cluster.md). Host drain report is normative with E3's F27 `nextDue` and the [E8a usage fields](../verification/e8a-usage.md). Still proposal, as E4 lists them open: trace propagation and action span names; `503` for `admission.requests` saturation; slow-consumer stream endings; presence `disconnect` after an owner crash; tenants other than `default`; Hosted assertions, which have unit tests but no end-to-end edge evidence; and Readiness beyond `200 { ready: true }` and `drained`, whose other reasons have no scenario.

**Responsibility:** define the one client wire, its request identity, hosted assertions and readiness.  
**Authority:** normative 0.2 API contract target on `main`.  
**Owner role:** protocol and SDK.  
**Change policy:** a change requires an ADR and client conformance updates on Node and Bun.

## One RPC group at `/rpc`

- A server MUST serve one RPC group, derived from the actor contracts, over WebSocket and over HTTP at the same path, `{basePath}/rpc`, with JSON serialization on both: one JSON message per WebSocket frame, and newline-delimited JSON (`application/ndjson`) over HTTP. There MUST be no other actor route: no per-member HTTP routes, no SSE, no OpenAPI document, no `/protocol` or `/command-ids` route.
- Call tags MUST be `<Actor>/<action>` for actions and `<Actor>/$<kind>[:<member>]` for everything else: `$state`, `$range:<list>`, `$watch:<list>`, `$view:<view>`, `$event:<event>`, `$join` and `$find`, plus the group-wide `$reauthenticate`. An edge classifies a call from its tag alone: no `$` is an action, `$join` writes presence, `$reauthenticate` renews a session, and every other `$` tag only reads. Actor and member names MUST NOT be empty, contain `/` or start with `$`; internal actions are not in the group.
- The Effect client is the only client ([ADR 0128](../decisions/0128-constrained-actor-api.md)). A transport adapter MUST preserve the semantics of the [durability](03-durability.md) and [realtime](07-realtime.md) contracts and MUST NOT define its own lifecycle states.
- The served mapping MUST be the same on Bun 1.4+ and Node 24+.

## Calls

- Every call MUST name the actor type, the actor id and the member. Tenant and caller MUST come only from `auth` ([security](10-security.md)), never from the call, a path, a client-controlled header or a frame.
- An action call MUST carry an external command id `v1.<issuedAtMs>.<expiresAtMs>.<uuidv4>` minted by the client from its own clock. The server MUST NOT mint an id for a caller. Retries MUST resend the same id and payload; identity-bound metadata MUST survive retries unchanged and adapters MUST NOT refresh it or mint a replacement. A `future` refusal carries the owner's admission time so the client can correct its clock before minting new ids.
- An action call's payload is `{ id, commandId, payload }`. Its success is `{ value, replayed }`, and a declared failure is the exit's error `ActionFailed { error, replayed }` with `error` in the declared error's own schema encoding. `replayed` is `false` for a newly durable action and `true` for a stored outcome returned to an authorized retry, declared failures included. The flag MUST come from admission, never from a separate lookup. Refusals before execution carry no flag.
- State, list, view and event members MUST be streaming calls. A state, list or view stream MUST send a full value first and JSON patches after ([realtime](07-realtime.md)).
- `join(params)` MUST be a scoped streaming call whose start runs `connect` and whose end runs `disconnect`.
- `find` MUST be a call on the actor type with `where`, `orderBy` and `limit`.
- Failures MUST use the [error model](error-model.md): an `ActorError` envelope or the action's declared error in its own schema encoding, inside the RPC exit.
- Trace context MUST propagate on every call; action spans MUST be named `akter.<Actor>/<action>`.

## HTTP

- `POST {basePath}/rpc` carries one request as an NDJSON line, ending in a newline; the response is NDJSON, and a streaming call keeps it open until its exit. A trailing `/` on the path is accepted.
- Refusals before the RPC handler runs MUST answer an HTTP status with the error envelope: `403` for a refused `Origin` or tenant, `401` with `www-authenticate: Bearer` for missing, invalid or expired credentials, `503` with `retry-after` when the auth provider is unavailable or for `admission.requests` saturation, `429` for `QuotaExceeded`. A client MUST surface the envelope's `ActorError` as the call's failure, not as a transport failure.
- Each HTTP request MUST be authenticated on its own, and its calls run in a session that lasts as long as the request, with the same reauthorization as a socket's.

## WebSocket

- The upgrade is `GET {basePath}/rpc`. Caller and tenant MUST be bound at the upgrade and every call on the socket runs as that caller ([security](10-security.md)).
- The group MUST reserve one call, `$reauthenticate`, which carries a fresh credential (hosted: a fresh assertion) for the session; clients and edges use it to keep a session within `reauthorizeEvery`. Application members MUST NOT start with `$`.
- A session ends with `SessionEnded { cause, resync }` or with `Unauthorized`; see the [error model](error-model.md). When it ends, every stream on it MUST fail with that error and every later call on the socket MUST be refused with it. After `reauthorization_unavailable` the client MUST replace the socket by reconnecting, which opens a new session; the calls it retries meanwhile run there.

## Hosted assertions

- A hosted edge MUST forward each HTTP request with a `durable-assertion` header and MUST remove any `durable-assertion` a client sent. A WebSocket upgrade carries the assertion in the same header; `$reauthenticate` carries it as `authorization: Bearer <jws>`.
- The assertion MUST be a compact JWS with `alg` `EdDSA` (Ed25519) and nothing else, `typ` `durable-assertion+jwt` and a `kid`; `crit` MUST be refused. Its claims are `iss`, `aud` (the release), `region`, `iat`, `exp`, `tenant`, `caller` (an encoded `User` or `Anonymous`), `sid` on WebSocket assertions, `cexp` and `req`, plus optional `actor`, `id`, `member` and `cid` for logs that runners never check. `exp − iat` MUST be at most 60 seconds, with 5 seconds of skew allowed on `iat` and `exp`. `cexp` is the external credential's own expiry in epoch seconds and caps a live session; the assertion's short `exp` never does.
- `req` is the lowercase hex SHA-256 of this UTF-8 string, lines joined by `\n`:

  ```text
  durable-assertion/v1
  <method>
  <path, percent-encoding normalised to uppercase hex, no dot segments>
  <query parameters sorted by name then value, each percent-encoded, joined by &>
  <Idempotency-Key header value, or empty>
  <lowercase hex SHA-256 of the body bytes exactly as forwarded>
  ```

  Both sides decode percent-escapes of RFC 3986 unreserved characters in the path. `/rpc` requests carry the command id inside the hashed body, so their `Idempotency-Key` line is empty. A WebSocket upgrade binds a `GET` with an empty body. A reauthentication assertion's string is `durable-assertion/v1`, `REAUTHENTICATE`, the session's upgrade path and the `sid`, and MUST carry the `sid` the session opened with.

- The runner MUST rebuild the string from what it received; any difference is `Unauthorized` `invalid_credentials` before any action. A missing assertion is `missing_credentials`, one past `exp` plus skew is `expired`, and every other failure (signature, key, algorithm, issuer, audience, region or lifetime) is `invalid_credentials`; none falls back to another credential.
- A runner with a key-set URL MUST answer `POST {basePath}/assertion-keys/refresh`, the edge's push after a signing key is revoked. The push carries in `durable-assertion` a JWS of `typ` `durable-key-refresh+jwt` with `iss`, `aud` (the release), `iat` and `exp` at most 60 seconds apart, signed by a key the runner holds. The runner MUST reread its key set at once and answer `204`; any other push is `401`, and repeating one only rereads again.

## Readiness

`GET {basePath}/ready` MUST answer `200 { ready: true }` or `503 { ready: false, reason }`, with `reason` one of `draining`, `drained`, `storage`, `routing`, `peering` or `unregistered`. It needs no credential and reveals nothing else.

## Host drain report

The server entry's `DrainReport` schema describes the host handoff, not a new application RPC:

```ts
{
  outcome: "clean" | "timedOut",
  shards: ReadonlyArray<{ shard: number; offset: number; nextDue: number | null }>,
  actions?: number,
  jobSeconds?: number,
}
```

`actions` and `jobSeconds` MUST be nonnegative integers when present. They are runner-wide cumulative attribution since runner open, including work on previously released or lost shards, and settle active attempts before reporting drain. Both fields are optional so a new decoder accepts legacy reports without them; absence means unknown, not zero. They create no storage or billing authority and are not restored by replay. See [background work](08-background-work.md#runner-usage-attribution) and [E8a evidence](../verification/e8a-usage.md).

## Verification

Client conformance over HTTP and WebSocket on Node and Bun: same-id retries and `replayed`, streaming frames, `$reauthenticate`, refusals before the handler, origin and scheme checks; assertion verification cases including each failure code and the key refresh push. Evidence: [E4 RPC and serving](../verification/e4-rpc-serve.md).
