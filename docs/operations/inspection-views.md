# Inspection views

**Responsibility:** document the read-only SQL views over runtime tables, their columns, privileges, and example queries.  
**Authority:** operational contract.  
**Owner role:** operations.
**Change policy:** a change requires operator review; a breaking change ships as a new view name ([ADR 0028](../decisions/0028-sql-inspection-views.md)).

Migration `0013_inspection_views` creates the `durable` schema. Its views are the supported way for `psql`, Grafana, Metabase, or any SQL tool to read committed runtime state. The `actor_*` tables underneath are private runtime storage: read the views, never the tables, and never write to either. ADR 0028 is proposed; the views exist on any database that ran `0013`, and their shape may still change before the ADR is accepted.

Everything a view shows is committed. A turn that rolls back (a defect, a crash before commit, lost authority) leaves no row in any view; a declared failure leaves only its receipt.

## Views and versions

`SELECT * FROM durable.views` lists each view and its version. Version 1:

| View                   | Rows                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `durable.actors`       | one per actor identity                                                       |
| `durable.state`        | one per stored state key                                                     |
| `durable.receipts`     | one per retained command receipt                                             |
| `durable.events`       | one per retained committed event                                             |
| `durable.outbox`       | pending intents and timers                                                   |
| `durable.timers`       | pending keyed timers (a subset of `outbox`), including `policy.cron` entries |
| `durable.effects`      | performed effects not yet settled                                            |
| `durable.dead_letters` | exhausted effects, kept for operators                                        |
| `durable.views`        | this catalog                                                                 |

Adding a column at the end keeps a view's version. Any other change adds a new view, such as `durable.receipts_v2`, and a catalog row.

## Columns

Every view except `durable.views` starts with the actor's ownership columns: `tenant_id`, `actor_type`, `actor_id`, `routing_key` (`bigint`, an opaque shard key that every runtime index leads with), and `placement` (`'tenant'` or `'actor'`, the actor type's placement). Each `*_ms` column is milliseconds since the Unix epoch and has a `timestamptz` twin without the suffix.

| View           | Further columns                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actors`       | `generation` (`bigint`, activations that took authority), `created` (`boolean`, the creation command committed), `last_event_sequence` (`bigint`)                            |
| `state`        | `key` (`text`), `value` (`bytea`, zstd-compressed JSON), `value_bytes` (`integer`)                                                                                           |
| `receipts`     | `command_id`, `command`, `caller_key` (JSON array, below), `outcome_tag` (`'Success'` or `'Failure'`), `outcome` (JSON), `expires_at_ms`, `expires_at`                       |
| `events`       | `sequence` (`bigint`), `event` (tag), `command_id`, `value` (`bytea`, zstd-compressed JSON), `value_bytes`, `emitted_at_ms`, `emitted_at`                                    |
| `outbox`       | `intent_id`, `timer_key` (null for plain intents), `target_type`, `target_id`, `command`, `payload` (JSON), `caller` (JSON), `attempts`, `last_error`, `due_at_ms`, `due_at` |
| `timers`       | `timer_key`, `intent_id`, `target_type`, `target_id`, `command`, `payload`, `caller`, `attempts`, `due_at_ms`, `due_at`                                                      |
| `effects`      | `effect_id`, `effect` (effect name), `payload`, `caller`, `attempts`, `last_error`, `ambiguous` (last attempt's outcome unknown), `due_at_ms`, `due_at`                      |
| `dead_letters` | `effect_id`, `effect`, `payload`, `attempts`, `cause`, `ambiguous`, `dead_at_ms`, `dead_at`                                                                                  |
| `views`        | `view_name`, `version`                                                                                                                                                       |

A receipt's `caller_key` is the caller's replay identity, not the tagged caller object that `outbox`, `timers`, and `effects` show as `caller`: `["User", subject]`, `["Anonymous"]`, or `["System", source, [tenant, actor_type, actor_id] or null, on-behalf-of subject or null]`. Read the subject of a user command with `caller_key::jsonb ->> 1` where `caller_key::jsonb ->> 0 = 'User'`.

While a relay attempt holds a row, its `due_at` is the end of that attempt's lease, not the original due time. A settled effect leaves `effects` and appears in `outbox` as an intent to its `onSuccess` or `onDeadLetter` route (and, when exhausted, in `dead_letters`).

State and event values are compressed; decode them client-side, for example `zstd -d` on the bytes, or `Bun.zstdDecompressSync` then `JSON.parse`. SQL cannot decompress them without an extension.

## Privileges

Grant a read-only role the schema and nothing else:

```sql
CREATE ROLE durable_inspector NOLOGIN;
GRANT USAGE ON SCHEMA durable TO durable_inspector;
GRANT SELECT ON ALL TABLES IN SCHEMA durable TO durable_inspector;
-- a login for a tool:
CREATE ROLE grafana LOGIN PASSWORD '...' IN ROLE durable_inspector;
```

That role reads every view and gets `permission denied` on every `actor_*` table. Writes through a view fail for every role, including the owner (`cannot insert into view`, `cannot update view`, `cannot delete from view`). Rerun the `GRANT SELECT` after a migration adds a view.

Every row names its tenant, and filtering on `tenant_id` returns exactly that tenant's rows, but nothing enforces the filter yet: until the framework's RLS policies ship (M4.5), treat view access as operator access to every tenant in the database.

## Example queries

Every index leads with `routing_key`, so find it first, then key the other views by it:

```sql
-- One actor, and its routing key.
SELECT * FROM durable.actors
WHERE tenant_id = 'acme' AND actor_type = 'Order' AND actor_id = 'o-17';

-- Its latest receipts and events, through the primary keys.
SELECT command_id, command, outcome_tag, expires_at FROM durable.receipts
WHERE routing_key = 4411728317207263473 AND tenant_id = 'acme'
  AND actor_type = 'Order' AND actor_id = 'o-17';

SELECT sequence, event, command_id, emitted_at FROM durable.events
WHERE routing_key = 4411728317207263473 AND tenant_id = 'acme'
  AND actor_type = 'Order' AND actor_id = 'o-17'
ORDER BY sequence DESC LIMIT 20;
```

Operational questions scan a table; keep them off hot dashboards on large deployments:

```sql
-- Declared failures among retained receipts, by actor type and command.
SELECT actor_type, command, count(*) FROM durable.receipts
WHERE outcome_tag = 'Failure' GROUP BY 1, 2 ORDER BY 3 DESC;

-- Recent dead letters for one tenant.
SELECT actor_type, actor_id, effect, attempts, cause, ambiguous, dead_at
FROM durable.dead_letters WHERE tenant_id = 'acme' ORDER BY dead_at_ms DESC LIMIT 20;

-- Relay backlog: intents and effects already due.
SELECT 'intent' AS kind, count(*) FROM durable.outbox WHERE due_at <= now()
UNION ALL SELECT 'effect', count(*) FROM durable.effects WHERE due_at <= now();

-- Effects retrying, with their last error.
SELECT actor_type, effect, attempts, last_error, due_at FROM durable.effects
WHERE attempts > 0 ORDER BY attempts DESC;

-- Next cron ticks.
SELECT tenant_id, actor_type, actor_id, timer_key, due_at FROM durable.timers
WHERE timer_key LIKE '$cron:%' ORDER BY due_at_ms LIMIT 20;

-- Largest stored state.
SELECT actor_type, actor_id, sum(value_bytes) AS bytes FROM durable.state
GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20;
```

Workflow executions are not in version 1; they arrive as new views after `0012_workflows`.

## Cost

Benchmark `inspection-views` (`bun run bench --scenario inspection-views`), 2026-09-27 at `6badc85`, one 8-vCPU, 31 GiB Linux VM running client and database: 100,000 actors over 100 tenants seeded directly into the runtime tables, each with one receipt, one event, and one day-away timer, and a dead letter for every hundredth actor. One sequential caller, 500 queries per case after 20 warm-up queries. Postgres 18.6 figures are two runs (`benchmarks/results/2026-09-27-6badc85-cr4-inspection-views-postgres.json` and `-repeat-postgres.json`); PGlite 0.5.8 is one run.

| Query                                                  | Postgres p50 / p95 / p99 (ms)                   | PGlite p50 / p95 / p99 (ms) |
| ------------------------------------------------------ | ----------------------------------------------- | --------------------------- |
| `actors` by tenant, type, and id (table scan)          | 5.36 / 6.27 / 9.85 and 5.22 / 5.94 / 6.78       | 6.23 / 6.92 / 8.13          |
| `receipts` by `routing_key` and identity (primary key) | 0.064 / 0.107 / 0.242 and 0.065 / 0.344 / 0.489 | 0.433 / 0.487 / 0.563       |
| a tenant's newest 20 `dead_letters` (1,000-row table)  | 0.132 / 0.197 / 0.600 and 0.159 / 0.203 / 0.416 | 0.434 / 0.520 / 1.071       |
| count of a tenant's `receipts` (table scan)            | 4.73 / 6.65 / 11.0 and 4.70 / 5.37 / 6.15       | 5.79 / 6.51 / 6.82          |
| 20 soonest `timers` across tenants (table scan, top-N) | 23.1 / 26.8 / 29.5 and 23.1 / 26.5 / 28.1       | 58.4 / 66.2 / 77.9          |

Keyed lookups stay sub-millisecond; anything filtered by tenant or identity alone scans its table and grows linearly with it. The views add nothing to the turn path: no index, trigger, or write, so the statement gate's counts are unchanged.
