# Drizzle integration

**Responsibility:** define the relational query experience.  
**Authority:** API design.  
**Owner role:** database/API.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Actor-owned tables use Drizzle semantics and gain `tenant_id` and `actor_id` ownership columns. The framework does not invent a separate query language or re-export drivers, pools, dialect internals, migration CLIs, or unrelated runtime globals.

Inside a command turn, `ctx.rows(table)` is scoped to the current tenant and actor and provides `one`, `all`, `count`, `insert`, `update`, `upsert`, and `delete`; `ScopedRead` exposes only `one`, `all`, and `count`. `ctx.db` is the Drizzle escape hatch for joins and advanced statements. Writes use `drizzle-orm/effect-postgres` on the framework's `PgClient`/`SqlClient` transaction connection, not a second pool, and commit atomically with the generation fence, receipt, state, events, intents, timers, and effects.

Queries and other off-turn phases receive `ScopedRead` and cannot mutate through the typed API. Runtime scoping and database constraints enforce ownership; TypeScript types alone are not authority.

There is one database per deployment. Tenants are rows, isolated by `tenant_id`, composite indexes, and optional RLS. Placement is selected with `shardGroup`, not separate tenant databases. Table schema changes use normal SQL migrations; keyed actor state uses `Actor.migration` upcasts.
