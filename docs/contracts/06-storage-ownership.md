# Storage and ownership

**Responsibility:** define relational storage behavior.  
**Authority:** normative.  
**Owner role:** database/runtime.  
**Change policy:** Drizzle, Postgres, and each backend adapter must agree on the supported query matrix.

`actor_state` MUST use keyed rows scoped by `(tenant_id, actor, actor_id, key)`. A command turn MUST decode stored values through the complete `migrations` chain before the handler and MUST write the current shape at commit. `State.maxBytes` MUST be enforced before commit.

`Actor.table()` business tables MUST include trusted `tenant_id` and `actor_id` ownership columns. `OwnedTable`/`Scoped` mutation is available only in command turns; `ScopedRead` is select-only. The public contract exposes Drizzle types, while the framework binds builders to its transaction and scope. Unsupported or raw mutation that cannot preserve ownership MUST be rejected.

One database serves a deployment. Every framework and business table MUST carry `tenant_id` with composite indexes; optional RLS MUST be applied per table. Tenant placement uses runtime `shardGroup` for compute and Neki shard placement for data, never a database per tenant.

The `Database` tag is the explicit escape hatch for authorized cross-actor reads. It MUST NOT grant command-turn authority. See [security](10-security.md) and storage cases in [conformance](../verification/01-conformance.md).
