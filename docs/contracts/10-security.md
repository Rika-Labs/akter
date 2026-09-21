# Security and tenancy

**Responsibility:** define trust boundaries and tenant isolation.  
**Authority:** normative.  
**Owner role:** security/runtime.  
**Change policy:** security review is required for auth, SQL, transfer, blob, and admin changes.

`CurrentCaller` MUST be a `Context.Reference` defaulting to `Anonymous` and MUST be set at each trusted edge. Handles capture caller identity when acquired, using the ambient value or explicit `{ as }`. Command handlers use `ctx.caller` and `ctx.principal`; workflow bodies expose `ctx.principal`, while workflow actor calls carry persisted System/on-behalf-of attribution.

For served HTTP, caller identity MUST be resolved per call. Concurrent requests carrying different bearer tokens MUST receive different principals. `Actor.serve` requires auth configuration; `Actor.auth.none` is the explicit public opt-out. When an endpoint requires authentication, missing or invalid credentials MUST fail with `ActorError` reason `Unauthorized`; they MUST NOT run as `Anonymous`. The `Unauthorized` reason has `code` (`error.reason.code` on its `ActorError` wrapper): `missing_credentials`, `invalid_credentials`, or `expired`.

Internal commands MUST be absent from public handles, the Promise client, and served endpoints. They are reachable through framework System-caller handles; a non-System attempt is a deterministic defect, not a public way to forge executor results. System calls preserve `source`, optional actor reference, and optional `onBehalfOf` principal.

One database MUST serve a deployment. Tenant isolation MUST use trusted `tenant_id` on every framework and business row, composite indexes, transaction scoping, and optional per-table RLS. Client-supplied tenant, actor id, cursor, or connection data is input, not authority. Compute placement is `shardGroup`; data placement is Neki shard placement.

Credentials and sensitive payloads MUST be redacted from logs. Spans MUST be named `durable-actors.<Actor>/<Command>`. The framework is trusted application infrastructure, not a hostile-code sandbox. Verification: **Per-call caller over HTTP**, **Cluster header size**, and **Workflow tenant isolation** gates.
