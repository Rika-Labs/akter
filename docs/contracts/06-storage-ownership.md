# Storage and ownership

**Responsibility:** define relational storage behavior.  
**Authority:** normative.  
**Owner role:** database/runtime.  
**Change policy:** Drizzle, Postgres, and each backend adapter must agree on the supported query matrix.

`actor_state` MUST use keyed rows scoped by `(tenant_id, actor, actor_id, key)`. A command turn MUST decode stored values through the complete `migrations` chain before the handler and MUST write the current shape on successful handler commit. An unhandled declared failure MUST discard migration writes along with the other business changes. `State.maxBytes` MUST be enforced before business state commits.

Each keyed value is schema-decoded JSONB. `vars` are activation-local memory, not transaction-bound state: changes to them are not durable or automatically rolled back. An actor that omits state, tables, events, effects, and blobs still executes fenced, receipted commands; it is not a separate ephemeral kind.

`Actor.blob` declares database-backed binary storage in `actor_blobs` (`bytea` chunks). `ctx.blob` permits `get`, `set`, `append`, and `compact` in command turns; off-turn readers receive `BlobRead`. Blob writes share the turn transaction and are exempt from `State.maxBytes`. This surface does not promise an external object-storage adapter.

`Actor.table()` business tables MUST include trusted `tenant_id` and `actor_id` ownership columns. `OwnedTable`/`Scoped` mutation is available only in command turns; `ScopedRead` is select-only. The public contract exposes Drizzle types, while the framework binds builders to its transaction and scope. Unsupported or raw mutation that cannot preserve ownership MUST be rejected.

Initial application writes MUST use scoped row operations; `ctx.db` supports authorized reads and joins, not advanced mutation. Every supported query-client or backend adapter MUST derive ordinary actor-row read/write scope from trusted context, supply ownership columns on insert, and enforce ownership on update, delete, and upsert. Application code MUST NOT need manual ownership fields or predicates; attempts to override ownership MUST be rejected. An adapter MUST preserve execution-phase permissions, bind writes to the current turn transaction, and reject use of transaction-bound capabilities after that turn ends.

Adapters MUST publish their supported operation matrix and pass the shared ownership and transaction cases. Missing scope, an unsupported operation, or inability to join the turn transaction MUST NOT fall back to an unscoped client or separate transaction. Future advanced mutations require evidence before support expands. Optional RLS is additional protection, not a replacement for actor ownership or generation fencing. See [adapters](../architecture/05-adapters.md).

One database serves a deployment. Every framework and business table MUST carry `tenant_id` with composite indexes; optional RLS MUST be applied per table. Tenant placement uses runtime `shardGroup` for compute and Neki shard placement for data, never a database per tenant.

The `Database` tag is the explicit escape hatch for authorized cross-actor reads. It MUST NOT grant command-turn authority. See [security](10-security.md) and storage cases in [conformance](../verification/01-conformance.md).
