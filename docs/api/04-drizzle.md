# Drizzle integration

**Responsibility:** define the relational query experience.  
**Authority:** API design.  
**Owner role:** database/API.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Actor-owned tables use Drizzle semantics and gain `tenant_id` and `actor_id` ownership columns. The framework does not invent a separate query language or re-export drivers, pools, dialect internals, migration CLIs, or unrelated runtime globals.

Inside a command turn, `turn.rows(table)` is scoped to the current tenant and actor and provides `one`, `all`, `count`, `insert`, `update`, `upsert`, and `delete`; `ScopedRead` exposes only `one`, `all`, and `count`. Application writes use these scoped operations. `group` is a read-only Drizzle client scoped to the actor's placement group for joins across the actors that share its shard ([ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md)); fleet-wide reads use declared `Fleet.view` definitions ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)). Writes use `drizzle-orm/effect-postgres` on the framework's `PgClient`/`SqlClient` transaction connection, not a second pool. Successful business changes commit with the receipt; an unhandled declared failure rolls them back while retaining the terminal failure receipt.

Application code supplies business fields and filters, not `tenant_id` or `actor_id`. The framework inserts ownership columns and constrains reads, updates, deletes, and upsert conflict targets from trusted context. Ownership overrides are rejected. These guarantees apply to every supported adapter, not only Drizzle; selecting another supported integration must not require adding manual ownership predicates to handlers.

Drizzle is the first query-client target. Additional query-client and backend adapters need the same automatic scoping, phase restrictions, turn-connection binding, and conformance evidence. Unsupported operations are rejected rather than delegated to an unscoped client. No additional adapter names or registration API are specified yet; see [adapter requirements](../architecture/05-adapters.md).

Queries and other off-turn phases (`X.Read`, `X.Connection`) receive `ScopedRead` and cannot mutate through the typed API. Runtime scoping and database constraints enforce ownership; TypeScript types alone are not authority.

There is one database per deployment region. Tenants are rows, isolated by `tenant_id`, composite indexes, and optional RLS. Placement is selected with `shardGroup`, not separate tenant databases. Table schema changes use normal SQL migrations; keyed actor state uses `Actor.migration` upcasts.
