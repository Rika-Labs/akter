# Security and tenancy

Status: proposal (0.2), owned by ADR 0130; promoted when E2 (store isolation) and E4 (callers, sessions, assertions and access) failure evidence lands, each section with its milestone. E4 evidence for callers, sessions, reauthorization and origin refusal is in [E4 RPC and serving](../verification/e4-rpc-serve.md); hosted assertions over `/rpc` end to end are open there.

**Responsibility:** define trust boundaries, caller and tenant identity, access, store and tenant isolation, runner trust and operator authority.  
**Authority:** normative target on `rewrite/0.2`.  
**Owner role:** security and runtime.  
**Change policy:** security review is required for changes to auth, access, sessions, assertions, store credentials, peering and operator capabilities.

## Callers and tenants

- The transport decides who the caller is and which tenant; actors decide what is allowed; ordinary code names neither.
- `Caller` is `User { subject } | Anonymous | System { source, ref?, onBehalfOf? }`, tagged on `_tag`. There are no roles.
- Code running in the application's own process outside an action and not through `Akter.serve` runs as `System({ source: "process" })` in tenant `"default"`. Trusted code MAY scope another caller or tenant explicitly for the calls it makes.
- Sends, timers, cron ticks and job calls MUST keep `System` attribution (`source` `send`, `timer`, `cron` or `job`), with `onBehalfOf` naming the principal of the action that staged them.
- A tenant MUST be 1 to 128 bytes of `[A-Za-z0-9._:-]`. A `User` subject MUST be at most 512 UTF-8 bytes and an encoded caller at most 1 KiB; a violation MUST fail `Unauthorized` code `invalid_credentials` before any action.
- An auth provider MUST NOT produce a `System` caller; one that does is a defect answered as an opaque failure.
- Client-supplied tenant, actor id, connection id, command id or payload content is input, never authority.

## Authentication

- `Akter.serve({ auth })` MUST be configured; `Auth.none` is the explicit public opt-out. `auth` runs on every request before `access` and is where global refusals (revoked credentials, suspended accounts) live.
- On HTTP, caller and tenant MUST be resolved per request; concurrent requests with different credentials MUST receive different callers.
- When authentication is required, missing or invalid credentials MUST fail `Unauthorized` with code `missing_credentials`, `invalid_credentials` or `expired`, and MUST NOT run as `Anonymous`.
- Credentials MUST NOT travel in URLs.
- A browser request carrying an `Origin` that is neither the server's own nor configured MUST be refused before authentication on every route, including WebSocket upgrades. Requests without `Origin` are served. A same-origin check MUST use the actual transport scheme and the request's `Host`; a client-supplied `x-forwarded-proto` or absolute request target MUST NOT turn a cleartext socket into an HTTPS origin.

## Access

- `access: (caller, request) => boolean` on the contract decides every external request, with `request.kind` one of `action`, `state`, `list`, `view`, `event`, `join`, `find` or `reauthorize`, and on every session recheck.
- **Default:** with no `access`, `User` and `System` callers MUST be allowed and `Anonymous` callers MUST be refused with `Unauthorized` code `access_denied`.
- An action that names a `cron` option or is a job's `onFailure` target MUST refuse every non-`System` caller with `Unauthorized` code `access_denied`, whatever `access` returns.
- View, state and list handlers MUST bind the request's caller and tenant, never a layer-builder identity; that binding grants no mutation capability.

## Sessions

- A WebSocket session MUST bind its caller and tenant at open. Every call over the session, actions included, MUST run as that caller; a caller taken from frame content MUST NOT be used, and a header a frame repeats MUST NOT replace one the transport set.
- `$reauthenticate` MUST run `auth` on the fresh credential and accept it only for the same caller and tenant (and, hosted, the same `sid`); a credential for another caller MUST end the session with `access_denied`. An accepted credential becomes the one later reauthorizations rerun.
- A live session MUST reauthorize within `reauthorizeEvery` (default 60 seconds, and never past the credential's own expiry) by running `auth` again and `access` with kind `reauthorize`. A refused check MUST end the session with `Unauthorized` code `access_denied`; when no check succeeds within the bound the session MUST end with `Unauthorized` code `reauthorization_unavailable`, without extension. Buffered frames MUST be discarded on revocation.
- Connection ids passed to `connect` and `disconnect` MUST be minted by the runtime, unguessable, and never accepted from the client.

## Outcomes and revocation

- A stored outcome MUST be returned only to the original logical caller with current access, or to an operator holding `outcomes.read` for it. A command id MUST NOT grant access or a second execution ([durability](03-durability.md)).
- Revocation MUST block new external admissions and outcome access and MUST NOT cancel accepted durable work or its internal recovery.
- Only verified caller attribution MAY be persisted; external credentials and assertions MUST NOT be.

## Hosted ingress

- Hosted edge-to-runner requests MUST carry signed, short-lived assertions over TLS. Runners MUST verify signature, issuer key, algorithm (`EdDSA` with Ed25519 only), audience (the release), expiry and request binding before admitting work, then authorize the requested operation. The edge MUST strip client-supplied assertions and replace client attribution.
- An assertion lives at most 60 seconds (10 by default) with 5 seconds of skew; verification keys come from a polled key set, so a revoked signing key stops verifying within 5 minutes; an assertion never reaches the client. WebSocket sessions bind an assertion at upgrade carrying the session id `sid`, and reauthenticate through the edge with a fresh assertion for the same `sid`. The exact format is in the [protocol](protocol.md).
- Hosted deployments run hosted API keys and declarative JWT settings only, never custom `auth` code.

## Isolation

- **Between stores (I8a).** A runner MUST hold credentials only for its own store's bucket or prefix. No framework API accepts another store's name. A runner of one store MUST refuse peers of another.
- **Between tenants in a store (I8b).** Every action, read, stream, send, job call, `find` and fork MUST stay within the caller's tenant. Pages are shared by content hash inside a store; no client API reads object keys, and knowing a page key grants nothing.
- The framework is trusted application infrastructure, not a sandbox for hostile code.

## Runner trust

- Runner-to-runner traffic MUST be trusted only over mTLS or an isolated private network; a store with served transports MUST provide one.
- With `Runner.mtls`, each side MUST speak TLS 1.3 only and present a certificate whose only subject alternative name is the URI `spiffe://akter/store/<store>/release/<release>`. A runner MUST refuse, before any runner message is sent or handled, a peer without a certificate, a plaintext peer, a chain that does not reach a trusted authority, a certificate outside its validity window, a certificate naming anything else, and a peer of another store or another release. Sessions MUST NOT be resumed. Credentials MUST reload without restart; a runner whose certificate expired or whose credential loads keep failing MUST report not ready (`peering`).

## Operators

- An operator is not a `Caller`. Operator calls MUST accept only an operator credential resolving to an `OperatorGrant` of capabilities `{ action, tenant, actorType?, actorId?, commandId? }`; no application credential converts to one.
- The CLI's implicit operator token MUST come only from `AKTER_OPERATOR_TOKEN`; `--token-env` MAY select another variable explicitly.
- Every operator read MUST be audited before it is answered, a refusal by scope MUST be audited as denied, and every operator mutation MUST be audited in the same segment as its effect ([ADR 0137](../decisions/0137-inspection-audited-operations-telemetry.md)).
- `export` MUST need its own capability, MUST read one durable checkpoint-plus-tail position, and MUST NOT carry the tenant, any caller or any credential, so a seed replayed by a test confers no authority. An unreadable or corrupt source MUST refuse the export, never produce a default seed.

## Cloud API keys

The public cloud contract MUST separate environment application keys from control-plane keys. An environment key's secret MUST appear only in its creation response. `akter keys create` MUST print that secret only on stdout and its save-now warning on stderr; other key commands print metadata or confirmed revocation only, using stored control-plane credentials and validating project, environment and tenant inputs before sending.

## Redaction and telemetry

Credentials and payload values MUST be redacted from logs, spans and audit records. Spans MUST be named `akter.<Actor>/<action>` for actions; metrics MUST NOT carry a tenant, actor id or command id.

## Verification

I8a and I8b suites (wrong-store credentials; cross-tenant action, read, send, `find`, fork); per-call callers over HTTP; session caller over WebSocket and reauthorization at the bound and on revocation; origin refusal on every route; assertion verification failures; mTLS refusal cases on Node and Bun; operator scope and audit-before-answer.
