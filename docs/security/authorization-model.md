# Authorization model

**Responsibility:** define authorization surfaces.  
**Authority:** security contract.  
**Owner role:** security/API.
**Change policy:** a change requires security review.

`CurrentCaller` is the ambient `Context.Reference`. `Actor.serve` authentication sets it independently for every request; tests use `ActorTest.layer({ as })`, scripts use `Actor.as`, and `X.get(id, { as })` binds an explicit caller to one handle. Handlers and workflows authorize with `ctx.caller` and `ctx.principal`.

Served calls use per-call bearer tokens unless a deployment deliberately selects another explicit auth helper. Missing, invalid, or expired credentials produce `ActorError` with reason `Unauthorized`; the reason carries a stable `code`. A request without credentials must not fall back to `Anonymous` when bearer auth is configured.

Hosted ingress maps an API key to a `Principal`, derives the deployment and tenant, and forwards caller attribution in the signed envelope. Client-provided tenant ids, actor ids, workflow keys, blob keys, and cursors are requested resources, never proof of authority.

Every framework and actor-owned row is scoped by `tenant_id`; transaction predicates are mandatory and optional RLS is defense in depth. Tenant and shard placement are not authorization. Administration, migrations, dead-letter repair, and reconciliation require separate operator capabilities.

Caller attribution propagates through intents, timers, cron, workflows, and effect callbacks as a `System` caller with optional `onBehalfOf`. Process memory, activation ownership, leases, generation, and network location are never authorization authority.
