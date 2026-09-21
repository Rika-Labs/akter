# Authorization model

**Responsibility:** define authorization surfaces.  
**Authority:** security contract.  
**Owner role:** security/API.
**Change policy:** a change requires security review.

`CurrentCaller` is the ambient `Context.Reference`, defaulting to `Anonymous` for embedded use. `Actor.serve` authentication sets it independently for every request; tests use `ActorTest.layer({ as })`, scripts use `Actor.as`, and `X.get(id, { as })` binds an explicit caller to one handle. Handles capture that caller when acquired. Command handlers expose `ctx.caller` and `ctx.principal`; workflow bodies expose `ctx.principal` and actor handles carrying persisted System/on-behalf-of attribution, not a `ctx.caller` property.

`Actor.serve` requires an explicit auth configuration, including `Actor.auth.none` for intentionally public actors. Bearer auth is a helper, not an implicit global default. Missing, invalid, or expired credentials produce `ActorError` with reason `Unauthorized`; the reason carries a stable `code`. A request without credentials must not fall back to `Anonymous` when authentication is required.

Hosted ingress is intended to map an API key to a `Principal`, derive the deployment and tenant, and forward caller attribution in the persisted envelope. The service-to-service trust mechanism still needs a transport/security specification; the design does not establish a signed-envelope implementation. Client-provided tenant ids, actor ids, workflow keys, blob keys, and cursors are requested resources, never proof of authority.

Every framework and actor-owned row is scoped by `tenant_id`; transaction predicates are mandatory and optional RLS is defense in depth. Tenant and shard placement are not authorization. Administration, migrations, dead-letter repair, and reconciliation require separate operator capabilities.

Caller attribution propagates through intents, timers, cron, workflows, and effect callbacks as a `System` caller with optional `onBehalfOf`. Process memory, activation ownership, leases, generation, and network location are never authorization authority.

Internal commands are absent from public handles, HTTP, and the Promise client; a non-System attempt is a deterministic defect. Off-turn actor read contexts cannot write state, rows, or blobs; effect executors have no database capability, and workflow bodies request changes through actor handles. These restrictions supplement runtime ownership checks rather than substituting TypeScript types for authority.
