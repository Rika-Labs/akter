# ADR 0028: SQL inspection views over runtime tables

**Status:** proposed (2026-09-27). It gates CR.4. Migration `0013_inspection_views` implements the proposed defaults below; the [open questions](#open-questions-for-dallen) need Dallen's decision before this ADR is accepted.

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
- Workflow tables arrive with `0012_workflows` (ADR 0022), which is not on `main` yet.
- The Effect migrator applies ids in order and skips any id at or below the latest applied, so `0013` applies on a database that has no `0010`–`0012`. The framework refuses to start a database where a registered id below the latest applied one is missing, checked both before and after the migrator runs, so a database that applied `0013` first fails loudly instead of skipping `0010`–`0012` without a word. That is why this migration merges after them.
- RLS is optional and per table (contract 10); M4.5 will add the framework's policies.

## Decision

### 1. A `durable` schema of versioned views

Migration `0013_inspection_views` creates schema `durable` and these views, version 1:

| View                   | Rows                                                     | Source               |
| ---------------------- | -------------------------------------------------------- | -------------------- |
| `durable.actors`       | one per actor identity with a generation row             | `actor_generations`  |
| `durable.state`        | one per stored state key                                 | `actor_state`        |
| `durable.receipts`     | one per retained receipt                                 | `actor_receipts`     |
| `durable.events`       | one per retained committed event                         | `actor_events`       |
| `durable.outbox`       | pending intents and timers (`kind = 'intent'`)           | `actor_outbox`       |
| `durable.timers`       | the keyed subset of `outbox`, including cron entries     | `actor_outbox`       |
| `durable.effects`      | pending effects (`kind = 'effect'`)                      | `actor_outbox`       |
| `durable.dead_letters` | exhausted effects                                        | `actor_dead_letters` |
| `durable.views`        | the catalog: `(view_name, version)` for every view above | constant             |

Every view except the catalog also carries the actor type's `placement` from `actor_placements`. The exact columns are listed in [inspection views](../operations/inspection-views.md#columns).

### 2. Every exposed column is public contract; every other column is private

A column that appears in a view is stable: its name, meaning, and SQL type do not change within a version. Base-table columns the views leave out stay private runtime detail: `payload_hash`, `bucket`, `kind` (expressed by the view split), `actor_outbox.ambiguous` on intents, and anything a later migration adds, such as `scheduled_at_ms`, until a view version exposes it. `routing_key` is exposed as an opaque join and index key; its value is stable for an actor but its encoding is not part of the contract.

Adding a column at the end of a view is compatible and keeps its version. Removing, renaming, retyping, or changing the meaning of a column, or changing which rows a view returns, requires a new view (for example `durable.receipts_v2`) and a catalog row; the old view keeps working until an ADR retires it.

Derived columns are cheap and SQL-only: `outcome_tag` (the receipt outcome's `_tag`), `value_bytes` (compressed size), and a `timestamptz` beside each `*_ms` column. State and event values stay compressed `bytea`; the reference documents how to decode them. Payloads, callers, and outcomes stay the runtime's JSON text. Receipts expose `caller_key`, the caller's replay identity (a JSON array such as `["User","alice"]`), under that name rather than as `caller`, because it is not the tagged caller object the outbox views show; its shape is contract, since changing it would already break receipt replay.

### 3. Read-only by construction

Each view joins `actor_placements`, so Postgres never treats it as an automatically updatable single-table view, and the catalog is a `VALUES` list. `INSERT`, `UPDATE`, and `DELETE` through any view fail with `cannot insert into view` (or update/delete) before touching a row, for every role, including the owner. No `INSTEAD OF` trigger or rule is defined. The views run with their owner's privileges (the default, not `security_invoker`), which is what lets a view-only role read them.

### 4. Tenant scoping

Every row of every view carries `tenant_id`, and no view aggregates or joins across tenants: a row always belongs to the one tenant it names. Filtering on `tenant_id` returns exactly that tenant's rows. The views add no access of their own: they expose only what the runtime already stores, and a tenant filter is the caller's choice, not an enforced boundary.

Until the framework's RLS policies land (M4.5), read access through these views is operator-only, like base-table access. When RLS lands, the views will be recreated with `security_invoker = true` so the base-table policies apply to the reading role; that is compatible (same columns and rows for an operator) and keeps version 1.

### 5. Privileges: a role granted only the views

The migration creates no role: roles are cluster-wide and the migration user may lack `CREATEROLE`. Operators create a read-only role and grant it the schema and nothing else:

```sql
CREATE ROLE durable_inspector NOLOGIN;
GRANT USAGE ON SCHEMA durable TO durable_inspector;
GRANT SELECT ON ALL TABLES IN SCHEMA durable TO durable_inspector;
```

That role can read every view and cannot read any `actor_*` table or write through a view. A later migration that adds a view requires the `GRANT SELECT ON ALL TABLES` to be rerun (or `ALTER DEFAULT PRIVILEGES` set by the migration user).

### 6. Indexes and cost

The migration adds no index, so the views cost nothing on the turn path. Point lookups by `(routing_key, tenant_id, actor_type, actor_id)` use the existing primary keys. Lookups by tenant or actor identity alone scan the table, because every index leads with `routing_key`; the reference shows the two-step pattern (find `routing_key` in `durable.actors`, then key every other view by it). The [benchmark](#evidence) records both costs at 100k actors.

### 7. Workflows and cron

This narrows the M2 plan, which put workflow views and a cron run-history view into `0013`. Cron (M2.5) is not on `main`; once it lands, `durable.timers` shows its entries (`timer_key LIKE '$cron:%'`) and `durable.receipts` its ticks, and a dedicated run-history view is an additive follow-up. Workflow views (`durable.workflows`, `durable.workflow_steps`) are not in version 1: `0013` must apply on databases without `0012_workflows`, and a view cannot reference a table that does not exist. They ship with, or right after, the workflow slice as additive views with their own catalog rows.

## Open questions for Dallen

Each question has a proposed default. Migration `0013_inspection_views` already implements every default, so any question left unanswered at acceptance takes its default. Choosing an alternative later needs a new ADR, and a new view version where §2 requires one.

1. **Schema name.** Proposed default: `durable`. Alternative: `durable_inspect`, which leaves `durable` free for future writable APIs.
2. **Should the migration create the role?** Proposed default: no, document the grant script (§5). Alternative: create `durable_inspector NOLOGIN` when the migration user may, and skip otherwise, which makes migration behavior depend on privileges.
3. **Should `durable.state` and `durable.events` expose compressed values?** Proposed default: yes, as `bytea` with `value_bytes`, decoded client-side. Alternative: omit values until a `pg` zstd extension is a supported deployment requirement.
4. **Secondary index for identity lookups.** Proposed default: none; use the two-step pattern. Alternative: `actor_generations (tenant_id, actor_type, actor_id)`, one extra index write per new actor, which the benchmark suggests is not needed below millions of actors.
5. **Workflow views.** Proposed default: add them in the workflow slice's migration or the next free one after `0012`, as version 1 of new view names. Alternative: hold CR.4 until `0012` lands and include them in `0013`.
6. **When RLS lands, switch to `security_invoker`.** Proposed default: yes (§4). Alternative: keep owner-rights views and add per-view tenant predicates driven by a session setting.

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
- `0013` lands after `0010_retention`, `0011_relay`, and `0012_workflows` in the migration order but may merge before `0012`; a local database that already applied `0013` must be recreated before it can apply a lower id.

## Evidence

- Conformance ([`conformance/inspection-views.ts`](../../packages/durable-actors/src/testing/conformance/inspection-views.ts)), shared by PGlite and Postgres: committed turns appear in every view, declared failures leave only their receipt, defects leave nothing, effects move to `dead_letters`, fired timers leave the outbox; rows keep their tenant; every write through every view fails and leaves the rows untouched; a role granted only the schema reads the views and is denied every runtime table.
- Migration, in `pglite.test.ts`: `0013` applies to a database that stopped at `0011` despite the `0012` gap, and a database that applied `0013` without a registered lower id refuses to migrate, naming that id.
- Benchmark `inspection-views` (see the [reference](../operations/inspection-views.md#cost) and `benchmarks/results/`).

## Revisit when

- M4.5 adds RLS policies (question 6).
- `0012_workflows` lands (question 5).
- A deployment needs identity lookups on tables large enough that the scan in §6 matters (question 4).
