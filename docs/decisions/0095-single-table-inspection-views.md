# ADR 0095: A second set of inspection views reads one table each, so a routed Neki group can serve them

**Status:** superseded by [ADR 0112](0112-postgres-and-pglite-only.md) (2026-10-08). Migration `0033_joined_inspection` retires these variants without rewriting applied migrations; the record below is historical.

**Responsibility:** decide which inspection views a database that routes the per-actor tables by `routing_key` can serve, how tools read an actor's placement without the join, and whether the framework creates the views a routed layout cannot serve.

**Authority:** implementation decision record. It adds a view set to [ADR 0028](0028-sql-inspection-views.md) without changing the first, completes item 2 of [ADR 0093](0093-neki-routing-topology.md)'s ordering for routed actor data, and amends [contract 06](../contracts/06-storage-ownership.md) and [contract 10](../contracts/10-security.md).

**Owner role:** runtime and operations.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0093](0093-neki-routing-topology.md) found two refusals on a range-routed group that no statement shape avoids:

1. A view whose tables sit in different groups is refused (`[122]`). Every `durable` view joins `actor_placements`, a deployment registry that must stay authoritative ([ADR 0067](0067-due-work-shard-ranges.md)), to an actor table that [route step 4](0093-neki-routing-topology.md#moving-to-routed-actor-data-later) routes.
2. A view that reads more than one relation is refused even within one group, which is why `durable.contents` (`tenant_contents` and `tenant_content_sweeps`) fails too.

On 2026-10-06 the migration chain was run unchanged on a logical database of `akter-preview` whose topology routes the 18 tables [ADR 0067](0067-due-work-shard-ranges.md)'s catalog test enumerates (15 `actor_*` tables and `tenant_contents`, `tenant_content_chunks`, `tenant_content_sweeps`). It stopped where production stopped:

```
not implemented: [122] view durable.actors: its tables span shard groups "actor_data" (public.actor_generations) and "authoritative" (public.actor_placements)
```

So no database can both route the actor tables and finish `0013`. The router states what it does serve: `[122] ... only a single-table projection or filter can be routed on sharded shard group "actor_data"`. A view with a CTE or a set operation is refused too, with the same code. A view with no table (`durable.views`, a `VALUES` list) is served. A view that reads one table is served, including a filter such as `WHERE kind = 'job'` and computed columns such as `to_timestamp(due_at_ms::float8 / 1000)`.

The same router refuses a write through a view on a routed group (`writing through view ... on sharded shard group "actor_data"`). Postgres does not: a view over one table is automatically updatable, which the joins of the first set prevented without any further object ([ADR 0028](0028-sql-inspection-views.md)'s "the placement join keeps every view from being automatically updatable").

## Decision

### 1. A second set of views, each reading exactly one table

Migration `0031_routable_views` creates 15 views in the `durable` schema. A breaking change ships as a new view name ([ADR 0028](0028-sql-inspection-views.md)), so each carries the suffix `_v2`, the name ADR 0028 gives as its example. The suffix names the set. A name keeps its own catalog version in `durable.views`, so every new name is listed at version 1 even where the first set's view of the same name is at version 2.

| View                        | Source table                | Differs from the first set's view                           |
| --------------------------- | --------------------------- | ----------------------------------------------------------- |
| `durable.actors_v2`         | `actor_generations`         | no `placement`                                              |
| `durable.state_v2`          | `actor_state`               | no `placement`                                              |
| `durable.receipts_v2`       | `actor_receipts`            | no `placement`; the version 2 columns of `0030`             |
| `durable.events_v2`         | `actor_events`              | no `placement`                                              |
| `durable.outbox_v2`         | `actor_outbox`              | no `placement`                                              |
| `durable.timers_v2`         | `actor_outbox`              | no `placement`                                              |
| `durable.jobs_v2`           | `actor_outbox`              | no `placement`                                              |
| `durable.dead_letters_v2`   | `actor_dead_letters`        | no `placement`; the version 2 columns of `0026`             |
| `durable.workflows_v2`      | `actor_workflow_executions` | no `placement`                                              |
| `durable.workflow_steps_v2` | `actor_workflow_step`       | no `placement`                                              |
| `durable.contents_v2`       | `tenant_contents`           | no `swept_at_ms` or `swept_at`                              |
| `durable.content_sweeps_v2` | `tenant_content_sweeps`     | new: the tenant's sweep time, which `contents` joined in    |
| `durable.content_refs_v2`   | `actor_content_refs`        | no `placement`                                              |
| `durable.operator_audit_v2` | `actor_operator_audit`      | no `placement`                                              |
| `durable.placements_v2`     | `actor_placements`          | new: `actor_type`, `placement`, `parent_type`, to be joined |

Every other column keeps its name, meaning, type and position. A tool that wants `placement` joins `placements_v2` to the row's `actor_type`; the table is small (one row per actor type) and a tool can read it once. A view that spans two tables is not offered: a tool joins `contents_v2` to `content_sweeps_v2` on `(routing_key, tenant_id)`.

`durable.views` is replaced by `0031` with the new names and, only where they exist, the first set's.

### 2. The first set is kept, and the framework skips it where the router cannot serve it

The first set stays: ADR 0028 forbids changing a released view, Postgres and PGlite serve it, and so does a Neki database that routes none of the tables a view reads (every control-plane database today, [ADR 0093](0093-neki-routing-topology.md)). Nothing in this ADR deprecates it; retiring it is a later ADR once no tool reads it.

The framework does skip creating it on a routed layout. Migrations `0013`, `0020`, `0021`, `0023`, `0026` and `0030` create their joined views only when none of the tables a block reads is routed, and the chain from empty then completes on a routed topology. The alternative, a deployment flag, was rejected: the topology is the fact the router enforces, and a flag can disagree with it.

Whether a table is routed comes from `__neki.get_data_topology()`, which the service role can read (checked with a role inheriting `postgres`, `pg_read_all_data` and `neki_viewer`). A table's group is its own binding, else the schema's default, else the cluster's; it is routed when that group has a shard index. A database without the function (every Postgres and PGlite) routes nothing, so nothing changes there. The check is an ordinary `SELECT`, which the Neki migrator runs without journaling, and it affects only which DDL a migration issues.

The framework does not drop the first set when a topology later routes its tables, because a topology rewrite happens outside the framework, which sees it only at the next start, and dropping a view an operator reads is not a startup side effect. After a rewrite the router accepts the topology, refuses every read of a joined view with `[122]`, and drops it without complaint (observed). So the step that routes the actor tables must drop the 13 joined views and rewrite `durable.views` without them (the statement is in [inspection views](../operations/inspection-views.md#single-table-views-_v2)), after the tools move to `_v2`.

### 3. A single-table view must not be writable

A view over one table is updatable, so `0031` revokes `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on every new view from its owner, and nobody is granted them. The migrator accepts `REVOKE`, whose replay is the statement itself. The revocation travels with the view when `ALTER VIEW ... OWNER TO` hands it to another role, so the guide's view-owner script keeps it (a conformance case checks it). A superuser can still write through a view, as it can write the table. This replaces a structural property with a privilege, which is weaker; `INSTEAD OF` triggers and rules were rejected because they stay silent when no row matches and raise only per row, and ADR 0028 rejected both already.

### 4. Every in-repo reader moves to the new set

`runtime/inspector/queries.ts` (the served inspector, behind `akter dev`, the CLI's inspector page and the console) and the operator receipt read in `runtime/operators/repair.ts` read only `_v2` views and `durable.views`. The inspector reads `placements_v2` once per page and attaches `placement` in the server, so its responses are unchanged and the CLI and console need no change. The conformance suites that read the views directly (`inspector`, `rls`, `workflows`, `payload-migrations`, `subscriptions/operator`) and `apps/api/src/deployment-stack.test.ts` read the `_v2` names. `apps/api`, the CLI's inspector page and the console read the inspector's HTTP responses, never a view, so they need no change.

`inspection-views.ts` runs each of its cases once for each set, so the first set keeps its evidence.

## Alternatives considered

- **Join in the view, as before.** Cannot be served on a routed layout.
- **Move placement into every actor row.** It would change every actor table and the hot write path for a column a tool can join.
- **Change the first set in place.** Forbidden by ADR 0028.
- **Make the first set conditional on a framework option.** Rejected above.
- **Drop the first set from `0031` where its tables are routed.** On a fresh routed database it never exists, so there is nothing to drop; on an existing database `0031` runs before the topology is rewritten, so the framework cannot know.
- **App-level reads of the tables.** Violates ADR 0028's rule that tools read views, never `actor_*` tables.

## Consequences

- A database that routes the 18 per-actor tables runs the whole migration chain and serves every inspection view.
- The first set and the second coexist on Postgres and unrouted Neki, 14 views more in `durable.views` and one catalog row each. A tool must pick one set; the `_v2` set works everywhere.
- Tools that want `placement` join client-side. A `LEFT JOIN` reproduces the first set, whose join was also a `LEFT JOIN` (an unrecorded type has none).
- The route step has two obligations: drop the joined views, and move every tool that reads them.
- Write protection is a privilege, not a structure, for the new set.

## Evidence and limits

Everything below ran from Dallen's Mac against `akter-preview` (Neki, one shard) on `akter_dev_views_*` logical databases, each with a topology entry written for it alone and all dropped with their entries and roles afterwards.

- **Refusal reproduced.** The unchanged chain on a database that routes the 18 tables stopped at `0013` with the `[122]` message above.
- **Chain from empty.** With this change the same topology ran every migration through `0031` with no refusal, in 131 s, and again in 181 s on a second database after the last edit to the migrations. Each database held the 15 `_v2` views and `durable.views`, 16 rows, and none of the first set, and the router held 18 routed tables for it.
- **Every view queried.** On each of the two databases, all 15 views were read with seeded rows of two tenants and actor types, one positive and one negative `routing_key`, and keyed, tenant-only, grouped, aggregate and client-joined shapes. The output was identical, line for line, to the same seed and queries on local Postgres 18.6 except the catalog's row count (16 against 29, since Postgres also holds the first set).
- **Statement replay.** The 84 distinct statements that read `_v2` views, taken from a statement log of the PGlite-and-Postgres inspector, inspection-view and placement cases (they include the inspector's `LATERAL` and receipt-to-event joins), each ran in a rolled-back transaction on both databases: 84 succeeded, none was refused.
- **Writes.** `DELETE FROM durable.actors_v2` on the routed database failed with the router's `[122] writing through view`. On Postgres the new views' ACL is `r`, `x`, `t`, `m` for the owner and nothing for anyone else.
- **Upgrade and route.** A database with the first set (migrated by the code before this change, no table routed) took `0031` in 14 s and listed both sets. After its topology was rewritten to route the 18 tables, reads of `durable.receipts`, `durable.jobs` and `durable.contents` failed with `[122]`, the `_v2` views read normally, and `DROP VIEW durable.actors` succeeded.
- **Tests on Postgres and PGlite.** `testing/conformance/inspection-views.ts` (rows, tenant isolation, writes refused for an owner role, catalog, schema-only reader; each per set), `runtime/database/pglite.test.ts` (no joined view where a topology routes the actor tables; both sets where it routes none or another database; the table, schema and cluster precedence of the check), `runtime/database/neki/migrations.test.ts` with the new migration id, and the inspector, operator, RLS, workflow and payload suites reading `_v2`.

Not shown:

- A control plane served from a routed layout. `apps/api` could not run there: every turn, relay and retention statement is refused on a routed group ([ADR 0093](0093-neki-routing-topology.md) item 3). Its inspection views no longer block that step, but nothing else changed, so no API soak ran for this change.
- Any layout with more than one physical shard, and how the router plans a view across shards.
- The router's plan for the inspector's joins of `receipts` and `events` on more than one shard.
- `INSERT`s and plans on the routed tables beyond the seeded rows.

## Revisit when

- The route step runs: confirm it drops the joined views and that no tool reads them.
- A tool needs a column the join provided other than `placement`.
- The first set's last reader moves: supersede with its retirement.
- Neki serves a joined view across groups.
