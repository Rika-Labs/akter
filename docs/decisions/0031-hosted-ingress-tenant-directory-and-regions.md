# ADR 0031: Hosted ingress, the tenant directory, and regions

**Status:** accepted (2026-09-28, Dallen, with every recommended default; proposed 2026-09-28). M4.8 builds the single-region edge; regions and tenant moves are L.1.

**Responsibility:** decide how the hosted edge authenticates a request and hands it to a runner, where each tenant's home region is recorded and read, and how regions will work when they are built.

**Authority:** design decision record.

**Owner role:** runtime architecture and security.

**Change policy:** supersede through a new ADR.

## Context

M4 ships a single-region hosted edge (M4.8) and designs regions without building them ([M4](../milestones/M4.md), slice M4.1; regions are slice L.1). Earlier decisions fix the outline and leave the protocol open:

- [ADR 0003](0003-failure-scoping-drain-and-hosted-trust.md) says the edge authenticates the external credential and forwards a short-lived assertion signed with an edge private key over TLS. Runners check the issuer and key, the algorithm, the deployment audience, the expiry, and the binding to the actor, operation, command id, and payload. Runners hold verification keys only. It leaves key rotation, revocation, request binding, and streaming-session authorization to a tested protocol.
- [ADR 0027](0027-served-protocol.md) §3 reserves the wire: the runner-side provider is `Actor.auth.assertion({ issuer, audience, keys })`, the assertion travels in `durable-assertion`, it binds at least the actor ref, the member, the command id, and a SHA-256 of the body, and it expires within 60 seconds. The edge strips a client-supplied `durable-assertion`. Rotation, revocation, canonical binding, and streaming sessions are this ADR's. Until then, a runner never trusts the header.
- [ADR 0005](0005-turn-latency-batching-and-regional-placement.md) gives every hosted tenant a home region recorded in a deployment-level tenant directory owned by the control plane and cached at the edge. It puts singletons and cluster-wide cron in the primary region, sends cross-region intents through the outbox, and makes tenant moves explicit operator operations whose design is pending. [ADR 0012](0012-workflows-internals-effects-defects-merging-regions.md) §7 adds that only an operator sets a home region, the default is the primary region, and the edge never assigns one from where a request lands.
- [Contract 10](../contracts/10-security.md) requires that a tenant's rows live only in its home region's database, and that the tenant comes only from the auth provider (ADR 0027).
- Hosted runners run the customer's served container ([vision 07](../vision/07-deployment.md)). Runner code is customer code; the edge and the control plane are ours.

What the code does today:

- `apps/edge/src/main.ts` and `packages/deployments/src/index.ts` are placeholders with one comment each. `packages/postgres` has only the account schema (users, organizations, members, sessions). There is no deployment, API-key, or tenant table.
- Served HTTP authenticates inside the runtime through `Actor.auth.jwt` and `Actor.auth.make` providers, whose `tenant` is a function of the claims (ADR 0027 §3).
- Intents stay within the sending turn's tenant (`actor/definition.ts`; the [server API](../api/01-server-api.md) says "the target shares the sending turn's tenant"). Subscriptions are same-tenant ([ADR 0026](0026-cross-actor-event-subscriptions.md)). `Actor.singleton` is one instance per tenant (`actor/definition.ts`), and one keeper keeps the default tenant's instance resident (`runtime/entity/register.ts`).

The last point changes ADR 0005's picture. Once each tenant has one home region, every actor-to-actor path inside a tenant stays in that region. Cross-region traffic only appears while a tenant moves, and for any future feature that lets one tenant's actor call another tenant's.

## Decision

### 1. The hosted request path

```text
client ──TLS──► edge ──────────────────────────TLS──► any ready runner ──mTLS──► owner runner
                1. host → deployment                  of the deployment
                2. authenticate → tenant, caller      in the home region
                3. directory → home region            1. verify the assertion
                4. sign an assertion, forward         2. authorize and admit
                                                      3. Cluster routes to the owner
```

- **Host to deployment.** The edge maps the request host (a platform subdomain or a verified custom domain) to a deployment through the control plane. An unknown host is `404` before authentication.
- **Authentication happens only at the edge.** Routing needs the tenant before a region is chosen, so the edge authenticates. It runs the deployment's declarative auth configuration: hosted API keys (stored hashed in the control plane) and the settings of `Actor.auth.jwt` (issuer, audience, JWKS, algorithms). Because edge-side configuration is data, not code, a hosted JWT names its tenant by a claim path or a fixed value (`tenant: { claim: "org_id" }` or `tenant: { fixed: "default" }`) instead of a function. `Actor.auth.make` providers are customer code and do not run at the edge (open question 1).
- **Any ready runner.** The edge forwards to any ready runner of the deployment in the tenant's home region, not to the actor's owner. Cluster routes to the owner over runner-to-runner mTLS, as contract 10 already requires. The edge holds no shard map.
- **Runners trust only the assertion.** A hosted runner serves with `auth: Actor.auth.assertion({ issuer, audience, region, keys })`. A request without a valid assertion fails `Unauthorized` `invalid_credentials` before any turn. The edge removes every client-supplied `durable-assertion` header before it forwards.

### 2. The assertion

The assertion is a compact JWS.

- **Header.** `alg` is `EdDSA` with Ed25519 and nothing else, `typ` is `durable-assertion+jwt`, and `kid` names the signing key. Any other algorithm, `none` included, is refused.
- **Claims.** `iss` is the edge issuer. `aud` is the deployment id. `region` is the region the edge routed to, and a runner refuses an assertion for any other region. `iat` and `exp` are set, with `exp − iat` at most 60 seconds (ADR 0027's cap) and 10 seconds by default. `tenant` and `caller` carry the verified attribution, within ADR 0027's limits: a tenant of 1 to 128 bytes, and an encoded caller of at most 1 KiB. `actor`, `id`, `member`, and `cid` (the command id, when there is one) are there for logs and direct checks. `sid` appears only on streaming assertions (§4).
- **Canonical request binding.** `req` is the lowercase hex SHA-256 of this UTF-8 string, lines joined by `\n`:

  ```text
  durable-assertion/v1
  <method>
  <path, percent-encoding normalised to uppercase hex, no dot segments>
  <query parameters sorted by name then value, each percent-encoded, joined by &>
  <Idempotency-Key header value, or empty>
  <lowercase hex SHA-256 of the body bytes exactly as forwarded>
  ```

  The runner rebuilds the string from the request it received and compares. Any difference is `Unauthorized` `invalid_credentials` before any turn. An example: a `POST` to `/actors/Order/o-17/Cancel` with `Idempotency-Key: v1.…` and a JSON body binds all four, so an intermediary cannot move the assertion to another order, another member, another command id, or another body.

- **Clock skew.** Edge and runners both run synchronized clocks, so runners allow 5 seconds of skew on `iat` and `exp`.
- **No replay cache.** A replayed assertion can only resend the exact request it binds. A command then carries the same command id, and its receipt deduplicates it ([contract 04](../contracts/04-receipts.md)). A query is a read the same caller could already make. So runners keep no `jti` store (open question 3).
- **Nothing durable.** As contract 10 requires, turns persist the verified caller, never the assertion. An assertion expiring after admission cancels nothing.

### 3. Keys, rotation, and revocation

- **Where keys live.** Signing keys exist only in the edge's secret store. Runners get the public key set (`kid`, public key, `nbf`, `exp`) from the control plane, at startup and then by polling every 5 minutes. An unknown `kid` triggers a refetch at most once a minute, as `Actor.auth.jwt` already does for JWKS (ADR 0027 §3).
- **Rotation.** A new key is published at least one polling interval before the edge signs with it. A retired key stays published for the longest assertion lifetime plus skew after its last use. Keys rotate every 30 days.
- **Revoking a signing key.** The control plane removes the key from the set and pushes a refresh to runners. A runner that misses the push stops accepting the key within one polling interval, so the revocation bound is 5 minutes (open question 2).
- **Revoking a caller or API key** happens at the edge, and it blocks every new request from that moment, as contract 10 requires. An assertion never reaches the client: the edge signs it immediately before forwarding one request and uses it only for that request's forwarding attempts. A revoked caller therefore has no assertion to present, and cannot make a new admission. The only admissions after revocation are requests the edge authenticated before it and was still forwarding, and the assertion's lifetime bounds them (10 seconds by default). The runner's own resource authorization still runs on every request, so an application that tracks revocation itself refuses even those. As [ADR 0004](0004-receipt-access-revocation-and-expiry.md) requires, work admitted before revocation continues.

### 4. Streaming sessions

- **Holders stay in runners in M4.** The edge proxies WebSocket and SSE bytes. It does not hold or park sockets, so [ADR 0023](0023-connections-parking-and-streams.md)'s holders are unchanged (open question 5).
- **Open.** On an upgrade, and on the `hello` frame, the edge authenticates, generates a session id of 128 random bits, and signs an assertion that binds the upgrade request's canonical string and carries the id in the `sid` claim (base64url, compared byte for byte). The runner's holder verifies the assertion before opening the session and stores `sid` with the session.
- **Reauthentication.** ADR 0027 has the holder ask the client for a fresh credential with `reauthenticate`. On a hosted edge, the edge verifies the client's answer and replaces the credential in that frame with a fresh assertion. Its canonical string is `durable-assertion/v1`, then `REAUTHENTICATE`, then the session's upgrade path, then the `sid`, and it carries the same `sid` claim. The holder verifies the assertion, requires the `sid` it stored at open, and requires the same caller and tenant. An assertion for another session is refused like any misbound assertion. The revocation bound is unchanged: `policy.reauthorizeEvery`, capped by the credential's expiry.
- **Edge loss.** A socket through a dead edge process is lost, and the client reconnects, as for any transport loss ([contract 07](../contracts/07-realtime.md)).

### 5. The tenant directory

- **Content.** The directory maps `(deployment, tenant)` to `{ region, state, version }`, where `state` is `active` or `moving` and `version` rises on every change. A deployment row records its `primary_region`. A tenant with no row lives in the primary region. No request ever writes a row, so ADR 0012's "a tenant with no recorded region routes to the primary region and never sets one" holds by construction.
- **Owner and storage.** The directory is a table in the control-plane database (`packages/postgres`). It is written only by commands on a control-plane actor in `packages/deployments`, a `TenantHome` actor keyed by `(deployment, tenant)`. Every change is then a receipted, attributed command, and one tenant's change never serializes behind another's. Operators use `durable tenants create <tenant> --region <region>`, and in L.1 `durable tenants move`.
- **Edge cache.** The edge looks tenants up lazily and caches them per deployment, absent rows included. It invalidates entries by polling the directory's highest `version` every 5 seconds and rereading only newer rows. It does not use `LISTEN/NOTIFY` ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md) keeps it off hot paths, and one invalidation path is simpler to reason about).
- **Staleness.** A stale entry is safe only if a region refuses tenants it does not hold. In M4 there is one region, so a stale entry cannot misroute. L.1 adds the refusal (§6).
- **What M4 builds.** M4.8 builds the table, `TenantHome` with a create command that accepts only the primary region, and the edge lookup and cache. Moves wait for L.1 (open question 4).

### 6. Regions: designed here, built in L.1

- **A region** is one Postgres or Neki database, one runner pool per deployment, and that pool's relay. Framework migrations run in every region, as [migrations](../operations/02-migrations.md) already requires. The runtime knows its region only through runner configuration and the assertion's `region` check. `routing_key` does not include the region, so a tenant's rows keep their keys when it moves.
- **No cross-region actor path for a settled tenant.** Intents, subscriptions, and workflow calls stay within a tenant, and each tenant's singleton instance lives with its other actors. This amends ADR 0005: a tenant's singleton instance runs in that tenant's home region. Only the deployment-wide keeper that keeps the default tenant's instance resident, and cron on that instance, run in the primary region. Cross-region intents are needed only if a later ADR allows cross-tenant intents. That ADR would deliver them from the sender region's relay to the target region's ingress under a region-signed System assertion, deduplicated by intent id.
- **Queries across regions** are fleet queries under ADR 0006: explicit, eventually consistent, and fed by change data capture.
- **Moving a tenant** is an operator operation with a per-tenant pause, which [vision 08](../vision/08-boundaries.md) allows ("zero-downtime relocation without availability tradeoffs" is not promised):
  1. The directory marks the tenant `moving`. The edge answers its new requests `503` `ActorUnavailable` with `retryAfter`, and clients retry with the same command ids.
  2. Source-region runners stop admitting the tenant's commands, and the relay stops claiming its outbox rows. Turns in flight finish or hit their deadline. Effect attempts in flight finish; their settles are allowed.
  3. Every row with the tenant's `tenant_id` is copied to the target region, receipts, outbox rows, timers, and events included, then counted and checksummed on both sides.
  4. The directory marks the tenant `active` in the target region with a higher `version`, and the edge routes there.
  5. The source keeps a tenant fence that refuses any late admission with a typed `TenantMoved`, which the edge retries against the directory. Source rows are deleted after the operator confirms.
- **Restore across regions** restores each region independently. The directory is authoritative for where a tenant lives. A regional restore to a point before a move completed needs an explicit procedure, which L.1 writes.

## Alternatives rejected

- **Authenticate on the runner, with the edge as a TLS pass-through.** The edge would not know the tenant, so it could not route by region, and customer runner code would receive raw platform credentials.
- **mTLS alone.** It proves which edge sent a request but binds neither the caller, the tenant, nor the request. ADR 0003 chose assertions, and mTLS may still be added under them.
- **Symmetric HMAC assertions.** Runners run customer code. A shared secret would let a runner mint assertions, which ADR 0003 forbids.
- **A `jti` replay cache.** It adds shared state to every runner and protects nothing that receipts and request binding don't already protect.
- **A directory copy in each regional database.** Every region would need every tenant's row, and a move would become a transaction across databases.
- **The tenant in the host name**, for example `<tenant>.<deployment>.example.com`. The tenant would come from the URL, which contract 10 treats as input.
- **Region chosen by the first request.** Rejected by ADR 0012.
- **Edge-held parked sockets in M4.** It would move ADR 0023's holders out of the runner and change connection recovery. It can be done later behind the same assertions.

## Consequences

- Hosted deployments support hosted API keys and declarative JWT settings, not custom auth code, until open question 1 is settled otherwise.
- Hosted runners need the edge's key set and their region as configuration.
- Regions need no runtime change beyond configuration, the assertion's `region` check, and L.1's tenant fence. The expensive part of L.1 is the move procedure, not routing.
- ADR 0005's cross-region relay shrinks to a future cross-tenant feature.

## Amendments on acceptance

These landed with the acceptance, as labelled targets until the slice builds them.

**Contracts.**

- [10 security](../contracts/10-security.md): replace the generic hosted-assertion paragraph with this profile: Ed25519 only, at most 60 seconds, `aud` and `region` checks, the canonical request binding, the 5-minute key-set bound, header stripping, and streaming re-assertion.
- [Wire protocol](../contracts/protocol.md): define `durable-assertion` and the canonical request string.

**Architecture.** [Topology](../architecture/01-topology.md) says singletons run in the primary region. Change it to say each tenant's singleton instance runs in the tenant's home region, and only the default tenant's keeper runs in the primary region.

**Earlier ADRs.**

- ADR 0005: a tenant's singleton instance runs in the tenant's home region; the tenant directory is §5 here; the cross-region relay is needed only for a future cross-tenant feature.
- ADR 0027 §3: rotation, revocation, canonical binding, and streaming are settled here. Hosted reauthentication goes through the edge (§4).

**Vision and operations.** [Vision 07](../vision/07-deployment.md) and [deployment](../operations/01-deployment.md) say `apps/edge` owns parked client sockets. Change both to say the edge proxies sockets and holders stay in runners until a later ADR. Add rotation and revocation to [runbooks](../operations/runbooks.md).

**API.**

- [Server API](../api/01-server-api.md): `Actor.auth.assertion({ issuer, audience, region, keys })`, where `keys` is a key-set URL or static keys. It is the only provider a hosted runner uses.
- The hosted auth configuration: hosted API keys, and JWT settings with `tenant: { claim } | { fixed }`.
- CLI: `durable tenants create <tenant> --region <region>`. M4 accepts only the primary region; `move` arrives with L.1.

**Verification.**

- [Conformance](../verification/01-conformance.md): the edge half of **Hosted assertions and operator authority** gets the cases below in `conformance/assertions.ts`. **Regional placement** is recorded as deferred to L.1.
- [Performance](../verification/03-performance.md): **Remote users** is recorded as deferred to L.1.
- [Failure matrix](../verification/02-failure-matrix.md): new rows "Edge signing key revoked or rotated", "Assertion for another region or deployment", and, for L.1, "Directory cache stale during a tenant move".
- [Support matrix](../operations/support-matrix.md): add "Hosted single-region path". Change "Multi-region home placement" to "designed (ADR 0031); built in L.1".
- [Threat model](../security/threat-model.md): add edge signing-key compromise and its bound.

## Migration

None in the framework for M4. The directory lives in the control-plane database and uses `packages/postgres` migrations, not the framework's `actor_migrations` ids. L.1's tenant fence needs one framework migration, numbered when L.1 is scheduled.

## Decided questions

Dallen accepted every recommended default on 2026-09-28.

1. **Custom auth code in hosted deployments.** Decided: not supported in M4. Hosted deployments use hosted API keys and declarative JWT settings. Rejected alternatives: run `Actor.auth.make` providers on runners and route every request to the primary region, which gives up regions; or sandbox providers at the edge, which needs a threat-model review.
2. **How fast a revoked signing key stops working, and the assertion lifetime.** Decided: a push on revocation, plus polling every 5 minutes as the bound. Rejected alternative: 1-minute polling, which costs more control-plane reads. The assertion lifetime defaults to 10 seconds, which bounds how long a request authenticated just before a caller's revocation can still be admitted. Rejected alternative: ADR 0027's 60-second cap, which tolerates slower forwarding.
3. **A replay cache.** Decided: none, because receipts and request binding cover replay. Rejected alternative: a per-runner `jti` cache for 60 seconds.
4. **When to build the directory.** Decided: in M4.8 with only the primary region, so the lookup, the absent-row rule, and the cache are exercised before L.1. Rejected alternative: wait for L.1 and route everything to the one region until then.
5. **Edge-held sockets.** Decided: not in M4; the edge proxies and holders stay in runners. Rejected alternative: move parking to the edge, which needs its own ADR amending ADR 0023.
6. **Tenant move downtime.** Decided: accept a pause per tenant that grows with the tenant's data. Rejected alternative: an online move with logical replication and a short cutover, which is much more work and needs Neki evidence.

## Evidence required

For M4.8, in `conformance/assertions.ts` on the served HTTP harness:

- `refuses forged, unknown-kid, wrong-algorithm, and none-algorithm assertions before admission`
- `refuses expired assertions, assertions issued in the future beyond skew, and assertions for another deployment or region`
- `refuses an assertion moved to another method, path, query, idempotency key, or body`
- `refuses a reauthentication assertion whose sid belongs to another session`
- `refuses new requests from a revoked caller at the edge, and admits in-flight ones only within the assertion lifetime`
- `strips a client-supplied durable-assertion and takes the caller only from the assertion`
- `keeps admitted work running after its assertion expires, and replays its receipt to a newly authenticated retry`
- `accepts a rotated key during overlap and refuses a revoked key within the polling bound`
- `reauthenticates a WebSocket session through the edge and closes it at the revocation bound`
- `routes a tenant with no directory row to the primary region and never writes a row`

For L.1: the **Regional placement** check, the tenant-move crash cases (the process dies at each step), the stale-cache refusal, and the **Remote users** benchmark.

## Implementation notes

M4.8's runner half (`Actor.auth.assertion`, `serve/assertion/binding.ts`) settles details §2 to §4 leave open:

- **`cexp`.** An assertion lives 10 seconds, so its `exp` can't cap a WebSocket session or an SSE feed. The edge adds `cexp`, the external credential's own expiry in epoch seconds, and the runner uses it as the session's `expiresAt`. An assertion without `cexp` gives the session no expiry, so the edge sets it on every streaming assertion.
- **Canonical path.** Besides uppercasing percent-encoding hex, both sides decode escapes of RFC 3986 unreserved characters (`%41` is `A`), so an intermediary that normalizes them can't break the binding.
- **`refreshEvery`.** The 5-minute key-set poll is the default of a runner option, so a deployment can choose ADR question 2's 1-minute alternative. The runner rereads the set lazily, on the first request after the interval, rather than on a timer.
- **Fail closed.** A runner whose key set is older than `refreshEvery` and can't be reread answers `503 ActorUnavailable` instead of trusting keys that may have been revoked.
- **No push yet.** Runners have no endpoint for the control plane's revocation push, so `refreshEvery` is the whole revocation bound.

M4.8's tenant directory (`packages/postgres/migrations/0002_tenant_directory.sql`, `packages/deployments/src/tenant-home/`) settles details §5 leaves open:

- **Versions in commit order.** A sequence alone can hand version 10 to a transaction that commits after version 11's, and an edge polling for rows above 11 would never see 10. The directory's trigger takes a transaction-scoped advisory lock before it draws the next version, so directory writes stamp their versions one at a time, in commit order. Directory writes are rare operator commands, so the lock costs nothing that matters.
- **`TenantHome` key.** `<deployment>/<tenant>`. Neither part can contain `/`, so the key splits one way.
- **The primary-region check.** `TenantHome` reads the deployment's `primary_region` through the `Deployments` service, outside the turn's transaction, because a turn reads only its own rows. A deployment's primary region never changes, so the read can't race the write.
- **The CLI.** `durable tenants create` runs `TenantHome` embedded against the control-plane database, like `durable workflows check`, and takes `--deployment`, `--database-url`, and `--operator` (the attributed caller) until the control-plane API and operator credentials (M4.6) exist.

M4.8's edge (`apps/edge`) settles these:

- **Sockets authenticate in `hello`.** The edge verifies an upgrade's credential, a `hello`'s, or both, and requires them to prove the same caller. It then sends the runner a `hello` whose credential is the session's assertion, so runners never need a header on the upstream upgrade.
- **API-key sessions.** A hosted API key has no expiry, so the edge sets `cexp` to now plus `EDGE_API_KEY_SESSION` (default 5 minutes). The runner then asks the client to reauthenticate at least that often, and the edge refuses a revoked key's renewal, which closes the session. A JWT session's `cexp` is the JWT's `exp`.
- **Publication lead.** The edge publishes its configured public keys at startup and signs only with a key published for at least 5 minutes, the runners' refresh interval, so §3's "published at least one polling interval before the edge signs with it" holds by construction.
- **Forwarding attempts.** The edge tries the region's ready runners in turn with one assertion and stops at its `exp`, so it never retries on an expired assertion.
- **Credential types.** A bearer token with three dot-separated parts is a JWT; any other token is a hosted API key.
- **Not built in M4.8.** Writers for hosts, runners, API keys, and JWT settings (the `Deployment` and `Runners` actors and the accounts API keys own them), rate limits, TLS from edge to runners, and the revocation push.

## Revisit when

- An application needs one tenant's actor to call another tenant's actor.
- Hosted customers need custom authentication code.
- Socket parking moves to the edge.
- Neki or Postgres offers a supported online move that avoids the per-tenant pause.
