# Security and tenancy

**Responsibility:** define trust boundaries and tenant isolation.  
**Authority:** normative.  
**Owner role:** security/runtime.  
**Change policy:** security review is required for auth, SQL, transfer, blob, and admin changes.

`CurrentCaller` MUST be a `Context.Reference` defaulting to `Anonymous` and MUST be set at each trusted edge. Inside command turns and workflows, authorization and attribution MUST use `ctx.caller` and `ctx.principal`.

For served HTTP, caller identity MUST be resolved per call. Concurrent requests carrying different bearer tokens MUST receive different principals. When an endpoint requires authentication, missing or invalid credentials MUST fail with `ActorError` reason `Unauthorized`; they MUST NOT run as `Anonymous`. `Unauthorized.reason.code` communicates `missing_credentials`, `invalid_credentials`, or `expired`.

One database MUST serve a deployment. Tenant isolation MUST use trusted `tenant_id` on every framework and business row, composite indexes, transaction scoping, and optional per-table RLS. Client-supplied tenant, actor id, cursor, or connection data is input, not authority. Compute placement is `shardGroup`; data placement is Neki shard placement.

Credentials and sensitive payloads MUST be redacted from logs. Spans MUST be named `durable-actors.<Actor>/<Command>`. The framework is trusted application infrastructure, not a hostile-code sandbox. Verification: **Per-call caller over HTTP**, **Cluster header size**, and **Workflow tenant isolation** gates.
