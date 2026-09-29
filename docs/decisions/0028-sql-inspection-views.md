# ADR 0028: SQL inspection views over runtime tables

**Status:** accepted (2026-09-28, Dallen, with the recommended answer to every open question; proposed 2026-09-27). It gates CR.4. Migration `0013_inspection_views` implements it; the [decided questions](#decided-questions) record the answers. [ADR 0048](0048-mint-progress-and-inspection-record-corrections.md) corrects §2's wording about `scheduled_at_ms`. [ADR 0051](0051-row-level-security.md) amends §4, §5, and question 6: with row-level security the views keep owner rights, owned by the tenant role, instead of switching to `security_invoker`.

**Responsibility:** define a stable, documented, read-only SQL surface for inspecting committed runtime state, which rows and columns it exposes, how it is tenant scoped, and which privileges read it.

**Authority:** decision record. It amends contracts [06](../contracts/06-storage-ownership.md) and [10](../contracts/10-security.md); the [data model](../architecture/data-model.md) and [storage layout](../architecture/03-storage-layout.md); [observability](../operations/03-observability.md); the [support matrix](../operations/support-matrix.md); and the [conformance ledger](../verification/01-conformance.md). The operator reference is [inspection views](../operations/inspection-views.md).

**Owner role:** runtime architecture and operations.

**Change policy:** supersede through a new ADR when the view set, a stable column, or the privilege model changes. A breaking change ships as a new view name, never as an in-place change to a released view.

## Context

Operators and tools (`psql`, Grafana, Metabase, and the planned `durable dev` inspector) need to see actors, receipts, events, pending intents and timers, effects, and dead letters. Today the only way is to read the `actor_*` tables directly. Those tables are private runtime storage: their columns change with migrations (`0003_routing_state` rebuilt them, `0008_effects` added `kind` to the outbox, `0011_relay` changes the due index and adds `scheduled_at_ms`), some columns are encodings (`bucket`, `payload_hash`), and a tool that reads or, worse, writes them couples itself to internals and can break fencing, receipts, or relay leases.

These facts from the shipped code shape the answer:

- Every framework row carries `(tenant_id, actor_type, actor_id)` and the framework-computed `routing_key`. Every primary key and index leads with `routing_key`; `routing_key` is an xxHash3 of the placement key and cannot be computed in SQL.
- State values and event values are zstd-compressed JSON (`bytea`). Postgres has no built-in zstd decompressor for arbitrary `bytea`.
- The outbox holds intents, keyed timers (`timer_key IS NOT NULL`), and effects (`kind = 'effect'`) in one table. A settled effect becomes an intent to its route in the same row.
- There is no separate cron table: cron entries are keyed timers with `timer_key = '$cron:<expression>'` (ADR 0021), and each tick leaves a receipt.
- Workflow executions and their steps live in `actor_workflow_executions` and `actor_workflow_step`, created by `0012_workflows` (ADR 0022), which precedes `0013`. Step rows are deleted when their execution finishes.
- The Effect migrator applies ids in order and skips any id at or below the latest applied. The framework refuses to start a database where a registered id below the latest applied one is missing, checked both before and after the migrator runs, so a database that recorded `0013` without `0012` fails loudly instead of skipping `0012` without a word.
- RLS is optional and per table (contract 10); M4.5 adds the framework's policies ([ADR 0051](0051-row-level-security.md)).

## Decision

### 1. A `durable` schema of versioned views

Migration `0013_inspection_views` creates schema `durable` and these views, version 1:

| View                     | Rows                                                     | Source                      |
| ------------------------ | -------------------------------------------------------- | --------------------------- |
| `durable.actors`         | one per actor identity with a generation row             | `actor_generations`         |
| `durable.state`          | one per stored state key                                 | `actor_state`               |
| `durable.receipts`       | one per retained receipt                                 | `actor_receipts`            |
| `durable.events`         | one per retained committed event                         | `actor_events`              |
| `durable.outbox`         | pending intents and timers (`kind = 'intent'`)           | `actor_outbox`              |
| `durable.timers`         | the keyed subset of `outbox`, including cron entries     | `actor_outbox`              |
| `durable.effects`        | pending effects (`kind = 'effect'`)                      | `actor_outbox`              |
| `durable.dead_letters`   | exhausted effects                                        | `actor_dead_letters`        |
| `durable.workflows`      | one per retained workflow execution                      | `actor_workflow_executions` |
| `durable.workflow_steps` | one per recorded step of an open execution               | `actor_workflow_step`       |
| `durable.views`          | the catalog: `(view_name, version)` for every view above | constant                    |

Every view except the catalog also carries the actor type's `placement` from `actor_placements`. The exact columns are listed in [inspection views](../operations/inspection-views.md#columns).

### 2. Every exposed column is public contract; every other column is private

A column that appears in a view is stable: its name, meaning, and SQL type do not change within a version. Base-table columns the views leave out stay private runtime detail: `payload_hash`, `bucket`, `kind` (expressed by the view split), `actor_outbox.ambiguous` on intents, the workflow `bucket` and `event_cursor`, a step's `wait_after`, `scanned`, and `matched`, the whole `actor_workflow_manifests` table (deployment metadata with no tenant), and anything a later migration adds, such as `scheduled_at_ms`, until a view version exposes it. `routing_key` is exposed as an opaque join and index key; its value is stable for an actor but its encoding is not part of the contract.

Adding a column at the end of a view is compatible and keeps its version. Removing, renaming, retyping, or changing the meaning of a column, or changing which rows a view returns, requires a new view (for example `durable.receipts_v2`) and a catalog row; the old view keeps working until an ADR retires it.

Derived columns are cheap and SQL-only: `outcome_tag` (the receipt outcome's `_tag`), `value_bytes` (compressed size), and a `timestamptz` beside each `*_ms` column. State and event values stay compressed `bytea`; the reference documents how to decode them. Payloads, callers, and outcomes stay the runtime's JSON text. Receipts expose `caller_key`, the caller's replay identity (a JSON array such as `["User","alice"]`), under that name rather than as `caller`, because it is not the tagged caller object the outbox views show; its shape is contract, since changing it would already break receipt replay.

### 3. Read-only by construction

Each view joins `actor_placements`, so Postgres never treats it as an automatically updatable single-table view, and the catalog is a `VALUES` list. `INSERT`, `UPDATE`, and `DELETE` through any view fail with `cannot insert into view` (or update/delete) before touching a row, for every role, including the owner. No `INSTEAD OF` trigger or rule is defined. The views run with their owner's privileges (the default, not `security_invoker`), which is what lets a view-only role read them.

### 4. Tenant scoping

Every row of every view carries `tenant_id`, and no view aggregates or joins across tenants: a row always belongs to the one tenant it names. Filtering on `tenant_id` returns exactly that tenant's rows. The views add no access of their own: they expose only what the runtime already stores, and a tenant filter is the caller's choice, not an enforced boundary.

Unless the deployment turns on row-level security, read access through these views is operator access to every tenant, like base-table access. With row-level security ([ADR 0051](0051-row-level-security.md)), the views keep owner rights but belong to the runtime's tenant role, so the base-table policies apply through them and each view returns only the tenant the reader's transaction names in `durable.tenant`. The columns and version 1 stay the same. This replaces the `security_invoker` switch this section planned: invoker rights would have required granting the reader the base tables.

### 5. Privileges: a role granted only the views

The migration creates no role: roles are cluster-wide and the migration user may lack `CREATEROLE`. Operators create a read-only role and grant it the schema and nothing else:

```sql
CREATE ROLE durable_inspector NOLOGIN;
GRANT USAGE ON SCHEMA durable TO durable_inspector;
GRANT SELECT ON ALL TABLES IN SCHEMA durable TO durable_inspector;
```

That role can read every view and cannot read any `actor_*` table or write through a view. With row-level security on, it reads only the tenant its transaction sets in `durable.tenant` ([ADR 0051](0051-row-level-security.md) §4). A later migration that adds a view requires the `GRANT SELECT ON ALL TABLES` to be rerun (or `ALTER DEFAULT PRIVILEGES` set by the migration user).

### 6. Indexes and cost

The migration adds no index, so the views cost nothing on the turn path. Point lookups by `(routing_key, tenant_id, actor_type, actor_id)` use the existing primary keys. Lookups by tenant or actor identity alone scan the table, because every index leads with `routing_key`; the reference shows the two-step pattern (find `routing_key` in `durable.actors`, then key every other view by it). The [benchmark](#evidence) records both costs at 100k actors.

### 7. Workflows and cron

Cron (M2.5) is not on `main`; once it lands, `durable.timers` shows its entries (`timer_key LIKE '$cron:%'`) and `durable.receipts` its ticks, and a dedicated run-history view is an additive follow-up. `0012_workflows` precedes `0013`, so version 1 includes `durable.workflows` (every retained execution, with `status`, `interrupt`, `payload` and `result` as compressed `bytea` with their byte counts, and start and finish times) and `durable.workflow_steps` (the steps recorded for open executions: `step`, `attempt`, `kind`, the compressed `exit` once settled, a clock's `due_at`, a wait's `wait_event`, a version marker's `version`, and start and settle times). A finished execution has no step rows, because the engine deletes them when it records the result.

## Decided questions

Dallen took the recommended answer to every question on 2026-09-28. Migration `0013_inspection_views` already implements each one. Choosing an alternative later needs a new ADR, and a new view version where §2 requires one.

1. **Schema name:** `durable`. `durable_inspect`, which would leave `durable` free for future writable APIs, was rejected.
2. **The migration does not create the role.** Operators run the grant script (§5). Creating `durable_inspector NOLOGIN` when the migration user may, and skipping otherwise, was rejected because it makes migration behavior depend on privileges.
3. **`durable.state` and `durable.events` expose compressed values** as `bytea` with `value_bytes`, decoded client-side. Omitting values until a `pg` zstd extension is a supported deployment requirement was rejected.
4. **No secondary index for identity lookups;** use the two-step pattern. `actor_generations (tenant_id, actor_type, actor_id)`, one extra index write per new actor, was rejected; the benchmark suggests it is not needed below millions of actors.
5. **Workflow views are in `0013`** (`durable.workflows` and `durable.workflow_steps`, §7), because `0012_workflows` merged first. Moving them to a later migration would only have delayed them.
6. **When RLS lands, the views switch to `security_invoker`** (§4). Keeping owner-rights views with per-view tenant predicates driven by a session setting was rejected. Amended by [ADR 0051](0051-row-level-security.md): the views keep owner rights and belong to the tenant role, so the base-table policies apply through them and a schema-only reader still holds no grant on any `actor_*` table.

## Alternatives considered

- **Document the base tables as the contract.** Rejected: it freezes internal encodings and invites writes that bypass fencing and receipts.
- **A read API in the runtime (HTTP or `durable` CLI) instead of SQL.** Complementary, not a replacement: BI tools and `psql` need SQL, and the planned inspector can read these views.
- **Materialized views or an export table.** Rejected: stale by construction and adds write or refresh cost.
- **`INSTEAD OF` triggers that raise.** Rejected as unnecessary: joined views already refuse writes, and triggers are another object to keep in sync.
- **Security-barrier views with a built-in tenant predicate.** Deferred to RLS (§4); a view-local predicate would be a second, weaker isolation mechanism.

## Consequences

- Operators and tools get a supported way to read runtime state that survives runtime migrations.
- Every future migration that changes a table under a view must keep that view's columns and rows, or add a new view version; the conformance cases catch a break.
- The views add no write, lock, or index cost to turns.
- `0013` applies after `0010_retention`, `0011_relay`, and `0012_workflows`; a database that recorded `0013` without a lower id refuses to start.

## Evidence

- Conformance ([`conformance/inspection-views.ts`](../../packages/durable-actors/src/testing/conformance/inspection-views.ts)), shared by PGlite and Postgres: committed turns appear in every view, declared failures leave only their receipt, defects leave nothing, effects move to `dead_letters`, fired timers leave the outbox; rows keep their tenant; every write through every view fails and leaves the rows untouched; a role granted only the schema reads the views and is denied every runtime table.
- Workflow views, in `conformance/workflows.ts`: a suspended execution shows in `durable.workflows` with its settled activity and pending clock step in `durable.workflow_steps`; once it finishes, its row reports `finished` with a result and it has no steps.
- Migration, in `pglite.test.ts`: `0012` then `0013` apply to a database that stopped at `0011`, and a database that applied `0013` without a registered lower id refuses to migrate, naming that id.
- Benchmark `inspection-views` (see the [reference](../operations/inspection-views.md#cost) and `benchmarks/results/`).

## Revisit when

- M4.5 added RLS policies; [ADR 0051](0051-row-level-security.md) answered question 6.
- A deployment needs identity lookups on tables large enough that the scan in §6 matters (question 4).
