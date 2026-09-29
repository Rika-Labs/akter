# Inspection views

**Responsibility:** document the read-only SQL views over runtime tables, their columns, privileges, and example queries.  
**Authority:** operational contract.  
**Owner role:** operations.
**Change policy:** a change requires operator review; a breaking change ships as a new view name ([ADR 0028](../decisions/0028-sql-inspection-views.md)).

Migration `0013_inspection_views` creates the `durable` schema. Its views are the supported way for `psql`, Grafana, Metabase, or any SQL tool to read committed runtime state. The `actor_*` tables underneath are private runtime storage: read the views, never the tables, and never write to either. Version 1 of every view is public contract under ADR 0028: a column it exposes keeps its name, meaning, and type, and any other change ships as a new view.

Everything a view shows is committed. A turn that rolls back (a defect, a crash before commit, lost authority) leaves no row in any view; a declared failure leaves only its receipt.

## Views and versions

`SELECT * FROM durable.views` lists each view and its version. Version 1:

| View                     | Rows                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| `durable.actors`         | one per actor identity                                                       |
| `durable.state`          | one per stored state key                                                     |
| `durable.receipts`       | one per retained command receipt                                             |
| `durable.events`         | one per retained committed event                                             |
| `durable.outbox`         | pending intents and timers                                                   |
| `durable.timers`         | pending keyed timers (a subset of `outbox`), including `policy.cron` entries |
| `durable.effects`        | performed effects not yet settled                                            |
| `durable.dead_letters`   | exhausted effects, kept for operators                                        |
| `durable.workflows`      | one per retained workflow execution, open or finished                        |
| `durable.workflow_steps` | recorded steps of open executions (a finished execution has none)            |
| `durable.views`          | this catalog                                                                 |

Adding a column at the end keeps a view's version. Any other change adds a new view, such as `durable.receipts_v2`, and a catalog row.

## Columns

Every view except `durable.views` starts with the actor's ownership columns: `tenant_id`, `actor_type`, `actor_id`, `routing_key` (`bigint`, an opaque shard key that every runtime index leads with), and `placement` (`'tenant'` or `'actor'`, the actor type's placement). Each `*_ms` column is milliseconds since the Unix epoch and has a `timestamptz` twin without the suffix.

| View             | Further columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `actors`         | `generation` (`bigint`, activations that took authority), `created` (`boolean`, the creation command committed), `last_event_sequence` (`bigint`)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `state`          | `key` (`text`), `value` (`bytea`, zstd-compressed JSON), `value_bytes` (`integer`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `receipts`       | `command_id`, `command`, `caller_key` (JSON array, below), `outcome_tag` (`'Success'` or `'Failure'`), `outcome` (JSON `text`), `expires_at_ms`, `expires_at`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `events`         | `sequence` (`bigint`), `event` (tag), `command_id`, `value` (`bytea`, zstd-compressed JSON), `value_bytes`, `emitted_at_ms`, `emitted_at`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `outbox`         | `intent_id`, `timer_key` (null for plain intents), `target_type`, `target_id`, `command`, `payload` (JSON `text`), `caller` (JSON `text`), `attempts`, `last_error`, `due_at_ms`, `due_at`                                                                                                                                                                                                                                                                                                                                                                             |
| `timers`         | `timer_key`, `intent_id`, `target_type`, `target_id`, `command`, `payload`, `caller`, `attempts`, `due_at_ms`, `due_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `effects`        | `effect_id`, `effect` (effect name), `payload`, `caller`, `attempts`, `last_error`, `ambiguous` (last attempt's outcome unknown), `due_at_ms`, `due_at`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dead_letters`   | `effect_id`, `effect`, `payload`, `attempts`, `cause`, `ambiguous`, `dead_at_ms`, `dead_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `workflows`      | `execution_id`, `workflow` (member name), `workflow_key`, `manifest_hash`, `status` (`'running'` while a run executes, including a replay after a resume; `'suspended'` only while it is parked on a clock, wait, or race with no run executing; `'finished'` once its result is recorded), `interrupt` (`boolean`, requested), `caller` (JSON `text`), `payload` (`bytea`, zstd-compressed JSON), `payload_bytes`, `result` (`bytea`, zstd-compressed JSON exit, null until finished), `result_bytes`, `started_at_ms`, `started_at`, `finished_at_ms`, `finished_at` |
| `workflow_steps` | `execution_id`, `step`, `attempt`, `kind` (`'activity'`, `'clock'`, `'deferred'`, `'wait'`, `'version'`), `exit` (`bytea`, zstd-compressed JSON, null while pending), `wait_event`, `version`, `due_at_ms`, `due_at`, `started_at_ms`, `started_at`, `settled_at_ms`, `settled_at`                                                                                                                                                                                                                                                                                     |
| `views`          | `view_name`, `version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A receipt's `caller_key` is the caller's replay identity, not the tagged caller object that `outbox`, `timers`, and `effects` show as `caller`: `["User", subject]`, `["Anonymous"]`, or `["System", source, [tenant, actor_type, actor_id] or null, on-behalf-of subject or null]`. Read the subject of a user command with `caller_key::jsonb ->> 1` where `caller_key::jsonb ->> 0 = 'User'`.

The JSON columns (`caller_key`, `outcome`, `payload` outside `workflows`, `caller`) are `text` holding JSON, as in the runtime tables; cast them to `jsonb` before using JSON operators, for example `outcome::jsonb -> 'value'` or `caller::jsonb ->> '_tag'`.

While a relay attempt holds a row, its `due_at` is the end of that attempt's lease, not the original due time. A settled effect leaves `effects` and appears in `outbox` as an intent to its `onSuccess` or `onDeadLetter` route (and, when exhausted, in `dead_letters`).

State and event values, and workflow payloads, results, and step exits, are compressed; decode them client-side, for example `zstd -d` on the bytes, or `Bun.zstdDecompressSync` then `JSON.parse`. SQL cannot decompress them without an extension.

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

A role also holds every privilege granted to `PUBLIC`, and these grants are not limited to `durable`: `EXECUTE` on functions by default, `USAGE` on schema `public`, and any table grant made to `PUBLIC`. To keep the role view-only, audit and revoke those grants, for example `REVOKE ALL ON SCHEMA public FROM PUBLIC` and `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`, or point the tool at a database where `PUBLIC` holds nothing else.

Every row names its tenant, and filtering on `tenant_id` returns exactly that tenant's rows. Without row-level security nothing enforces the filter, so treat view access as operator access to every tenant in the database. With [row-level security](01-deployment.md#row-level-security) on, the views belong to a dedicated view-owner role (`durable_views` in the guide's script), which the policies bind and the runtime's tenant role can't act as. They keep their owner's rights, so the base-table policies apply through them, and a reader sees only the tenant its transaction names:

```sql
BEGIN;
SELECT set_config('durable.tenant', 'acme', true);
SELECT actor_type, actor_id FROM durable.actors;  -- acme's actors only; none without the setting
COMMIT;
```

The reader still holds no grant on any `actor_*` table, and the columns and version 1 stay the same ([ADR 0051](../decisions/0051-row-level-security.md) §4).

## The local inspector

`durable dev --entry <module>` runs an application locally and serves a read-only inspector over these views (CR.5). The entry module exports `app`: its routes, usually `Actor.serve`, with the actor layers and `Actors.layer` provided, leaving the database to the command (see `examples/chat/src/app.ts`).

```sh
durable dev --entry src/app.ts [--database-url <url> | --data-dir <dir>] [--port 3000] [--hostname 127.0.0.1] [--tenant default]
```

Without `--database-url` the app runs on PGlite, in memory unless `--data-dir` names a directory. The app's routes and the inspector share one server: the inspector page is `/_durable/inspector` and its JSON API is under `/_durable/inspector/api`. The page shows the tenant's counts, actors by type, one actor's state, receipts (each linking the events it committed), event timeline, outbox and timers, effects, dead letters, and workflow executions with their step history, plus tenant-wide outbox, effect, dead-letter, and workflow lists. It re-reads on **Refresh**, or every two seconds with **live** on, and renders every stored value as text, never as markup. The server listens on loopback unless `--hostname` says otherwise, and every inspector request reads the one tenant `--tenant` names.

The API is `Inspector.serve({ auth, basePath? })` from `@durable-actors/core/runtime`, a layer of `HttpRouter` routes like `Actor.serve`. Every route is `GET`, answers JSON with `cache-control: no-store`, and takes `limit` (1 to 500, default 50):

| Route                            | Returns                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/overview`                      | `tenant`, the view catalog, and the tenant's row count in each view                                                                                                                                                              |
| `/actors?type&afterType&afterId` | the tenant's actors in `(actor_type, actor_id)` order, and `next`, the cursor of the following page                                                                                                                              |
| `/actor?type&id`                 | one actor: generation, decoded state, newest receipts with the event sequences each committed, newest events decoded, pending outbox rows and effects, dead letters, workflow executions with their recorded steps, and `totals` |
| `/outbox`, `/effects`            | the tenant's pending intents and timers, and pending effects, soonest first                                                                                                                                                      |
| `/dead-letters`                  | the tenant's dead letters, newest first                                                                                                                                                                                          |
| `/workflows?status`              | the tenant's workflow executions with their steps, newest first; `status=open` (the default) omits finished ones, `status=all` keeps them                                                                                        |

Compressed values (state, event values, workflow payloads, results, and step exits) and JSON text columns come back as `{ "json": <value> }`, or `{ "undecodable": <reason> }` for a row that is not zstd or not JSON. An unknown actor is `404 { "_tag": "NotFound" }`; a failed authentication is the served `ActorError` envelope with `401`. A request whose `Origin` is not the server's own is refused with `403 InvalidInput(origin_not_allowed)` before authentication, so another site cannot probe it with a browser's credentials.

The inspector adds no access of its own:

- **Tenant.** The tenant comes only from the authenticated principal, never from the request, and every statement filters on it. A tenant named in the query string is ignored. Inside that tenant the inspector reads every actor, so `auth` must authenticate operators, not the end users `Actor.serve` authenticates.
- **Read-only.** It reads only the `durable` views, inside a `REPEATABLE READ, READ ONLY` transaction per request, so one response is one snapshot and Postgres refuses any write. Every statement it runs also succeeds under a role granted only the `durable` schema (see [Privileges](#privileges)). Each transaction also sets `durable.tenant` to the principal's tenant, so with row-level security on the database enforces the tenant too.
- **Step history.** Steps are shown while an execution is open; the engine deletes a finished execution's steps, so a finished execution shows its result and no steps.

Connections are not shown: no inspection view covers `actor_connections` yet. Retrying a dead letter waits for M4.6's audited repair.

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
SELECT tenant_id, actor_type, actor_id, sum(value_bytes) AS bytes FROM durable.state
GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20;
```

```sql
-- Open workflow executions, oldest first.
SELECT tenant_id, actor_type, actor_id, workflow, workflow_key, status, started_at
FROM durable.workflows WHERE status <> 'finished' ORDER BY started_at_ms LIMIT 20;

-- Steps of one execution, with the pending ones last.
SELECT step, attempt, kind, exit IS NOT NULL AS settled, due_at, wait_event, settled_at
FROM durable.workflow_steps
WHERE routing_key = $1 AND execution_id = $2 ORDER BY started_at_ms;
```

## Cost

Benchmark `inspection-views` (`bun run bench --scenario inspection-views`), 2026-09-27 at `583d074`, one 8-vCPU, 31 GiB Linux VM running client and database: 100,000 actors over 100 tenants seeded directly into the runtime tables with hashed routing keys, each with one receipt, one event, and one day-away timer, and a dead letter for every hundredth actor. One sequential caller, 500 queries per case after 20 warm-up queries. Each backend has two runs: Postgres 18.6 in `benchmarks/results/2026-09-27-583d074-cr4-inspection-views-postgres.json` and `-repeat-postgres.json`, PGlite 0.5.8 in `-pglite.json` and `-repeat-pglite.json`. The earlier `6badc85` results seeded arithmetic routing keys and are kept for comparison; figures agree within noise.

| Query                                                  | Postgres p50 / p95 / p99 (ms)                   | PGlite p50 / p95 / p99 (ms)                     |
| ------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------- |
| `actors` by tenant, type, and id (table scan)          | 5.29 / 6.15 / 8.21 and 5.55 / 6.87 / 8.37       | 8.01 / 9.97 / 11.1 and 6.30 / 7.56 / 8.45       |
| `receipts` by `routing_key` and identity (primary key) | 0.063 / 0.197 / 0.370 and 0.068 / 0.275 / 0.479 | 0.452 / 0.544 / 0.807 and 0.449 / 0.522 / 0.560 |
| a tenant's newest 20 `dead_letters` (1,000-row table)  | 0.139 / 0.243 / 0.789 and 0.134 / 0.227 / 0.603 | 0.430 / 0.496 / 1.18 and 0.426 / 0.507 / 1.15   |
| count of a tenant's `receipts` (table scan)            | 4.85 / 5.69 / 6.97 and 4.85 / 6.39 / 6.95       | 6.00 / 6.90 / 7.51 and 5.70 / 6.10 / 8.35       |
| 20 soonest `timers` across tenants (table scan, top-N) | 24.8 / 32.4 / 35.3 and 25.3 / 30.6 / 34.2       | 60.0 / 70.0 / 72.0 and 58.9 / 68.9 / 75.7       |

Keyed lookups stay sub-millisecond; anything filtered by tenant or identity alone scans its table and grows linearly with it. The views add nothing to the turn path: no index, trigger, or write, so the statement gate's counts are unchanged.

## Accepted additions

`0021_payload_versions` adds `payload_version` at the end of `durable.events`, `durable.effects`, and `durable.dead_letters`, as ADR 0028 allows within a view version ([ADR 0032](../decisions/0032-event-and-effect-payload-evolution.md)).

Built by M4.13 ([ADR 0034](../decisions/0034-tenant-scoped-content-addressed-blobs.md)): `durable.contents` (tenant, routing key, hash, size, `granted_until_ms`, and the tenant's last sweep as `swept_at_ms`) and `durable.content_refs` (each actor's references with its placement, blob, name, hash, and size), version 1 in `durable.views`.

Targets from the accepted M4 ADRs, added at the end of each view as ADR 0028 allows: when L.2 builds the cold tier, a cold marker on `durable.actors` ([ADR 0036](../decisions/0036-cold-tier.md)).
