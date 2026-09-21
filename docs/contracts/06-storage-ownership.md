# Storage and ownership

**Responsibility:** define relational storage behavior.  
**Authority:** normative.  
**Owner role:** database/runtime.  
**Change policy:** Drizzle, Postgres, and each backend adapter must agree on the supported query matrix.

`actor_state` MUST use keyed rows scoped by `(tenant_id, actor, actor_id, key)`. A command turn MUST decode stored values through the complete `migrations` chain before the handler and MUST write the current shape at commit. `State.maxBytes` MUST be enforced before commit.

Each keyed value is schema-decoded JSONB. `vars` are activation-local memory, not transaction-bound state: changes to them are not durable or automatically rolled back. An actor that omits state, tables, events, effects, and blobs still executes fenced, receipted commands; it is not a separate ephemeral kind.

`Actor.blob` declares database-backed binary storage in `actor_blobs` (`bytea` chunks). `ctx.blob` permits `get`, `set`, `append`, and `compact` in command turns; off-turn readers receive `BlobRead`. Blob writes share the turn transaction and are exempt from `State.maxBytes`. This surface does not promise an external object-storage adapter.

`Actor.table()` business tables MUST include trusted `tenant_id` and `actor_id` ownership columns. `OwnedTable`/`Scoped` mutation is available only in command turns; `ScopedRead` is select-only. The public contract exposes Drizzle types, while the framework binds builders to its transaction and scope. Unsupported or raw mutation that cannot preserve ownership MUST be rejected.

One database serves a deployment. Every framework and business table MUST carry `tenant_id` with composite indexes; optional RLS MUST be applied per table. Tenant placement uses runtime `shardGroup` for compute and Neki shard placement for data, never a database per tenant.

The `Database` tag is the explicit escape hatch for authorized cross-actor reads. It MUST NOT grant command-turn authority. See [security](10-security.md) and storage cases in [conformance](../verification/01-conformance.md).
