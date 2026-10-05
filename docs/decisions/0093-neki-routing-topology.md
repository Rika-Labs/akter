# ADR 0093: The control plane's Neki database routes no table until every statement on a routed table runs on its shard

**Status:** accepted (2026-10-05). Demonstrated on the live `akter-preview` cluster (one shard); a split onto separate data shards is not demonstrated. [ADR 0094](0094-neki-shard-targeted-sessions.md) implements step 1 of the move to routed actor data.

**Responsibility:** decide which shard group each table of a Neki database belongs to, what a router must accept before a table is routed by `routing_key`, and how the database later moves to routed actor data.

**Authority:** implementation decision record. It amends [ADR 0089](0089-fly-infrastructure-and-environments.md)'s database item (the list of unsharded tables in `infra/src/placement.ts` is gone) and the "sharded topologies" limit of [ADR 0092](0092-neki-runtime-sql.md), and it adds a Neki rule to [contract 06](../contracts/06-storage-ownership.md).

**Owner role:** runtime, control plane and infrastructure.

**Change policy:** supersede through a new ADR.

## Context

On 2026-10-05 the production API crashed at boot on `akter-production` (one shard):

```
not implemented: [122] view durable.actors: its tables span shard groups "actor_data" (public.actor_generations) and "authoritative" (public.actor_placements)
```

That database had the topology `dataTopology` produced: an `authoritative` group for the tables listed in `infra/src/placement.ts`, and every other table of `public` in `actor_data`, routed by a `range` shard index on `routing_key`. Previews never saw it because each `akter_pr_<n>` database has no topology entry, so every table sits in the cluster's default group, which is unsharded.

To find every statement that topology refuses, a logical database on `akter-preview` was given exactly that topology (both groups on the cluster's one shard), the API was booted on it with `CONTROL_PLANE_DATABASE_ENGINE=neki`, and every distinct statement the Postgres suites of `@rikalabs/akter`, `apps/api`, `apps/edge`, `@akter/deployments`, `@akter/metering` and `@akter/billing` issue (3,795, from a statement log of local Postgres) was replayed on it, each in a transaction that rolls back. The findings:

1. **Views.** A view whose tables span groups is refused (`[122]`): the twelve inspection views that join `actor_placements` to actor rows. On a range-routed group the router also refuses a view that reads more than one relation, even of one group: `[122] view durable.contents: only a view over a single table can be routed on sharded shard group "actor_data"; this one reads 2 relations`.
2. **Tables without `routing_key` in the routed group.** The router refuses every insert into such a table: `shard-key column "routing_key" of primary index 0 ("routing_key_range") is required but missing from INSERT`. The placement list missed 26 of them, among them `cloud_email_outbox`, `cloud_project`, `cloud_environment`, `cloud_audit`, `cloud_command_idempotency`, the Better Auth `apikey`, `team`, `teamMember`, `ssoProvider` and `deviceCode`, `actor_routed_subscriptions`, and `actor_coordination`, which [ADR 0066](0066-authoritative-coordination.md) requires on the unsharded authority.
3. **Every statement on a routed table goes through the router's planner,** even one keyed by `routing_key`. With the framework's per-actor tables routed, 117 distinct framework statements in their Neki form are refused, the turn's own among them:
   - the admission read (`MATERIALIZED` CTE with `FOR UPDATE`, `[579]`; a plain keyed `WITH ... FOR UPDATE` is `[20] cannot create statement for command tag SELECT FOR UPDATE`);
   - event append and subscription cursor writes (`[117]` `INSERT ... SELECT ... ON CONFLICT DO UPDATE`, `[116]`);
   - relay claims, capped-job probes and job queue updates (`[100]`, `[929]`, `[967]`, `[107]`);
   - retention (`[816]` data-modifying CTE).

   The turn session's `__neki.tx_mode = 'single'` and `__neki.fanout = 'single'` change none of these. In a session targeted at the data shard (`SET __neki.shard`), the router forwards each of them unchanged and refuses none; only test-harness statements (`pg_blocking_pids`) stay refused. Booted with the framework tables routed, the API logged 292 `Outbox relay pass failed` errors and a retention failure in its first minutes.

4. **Things the router cannot see.** A control-plane table that holds a `routing_key` is not therefore per-actor data. `tenant_directory` references `deployment`, is unique on `(deployment_id, tenant)` across actors, and is versioned by a sequence under an advisory lock. Triggers on `cloud_meter_evidence`, `cloud_meter_seal`, `cloud_meter_export` and `cloud_billing_state` read or write `cloud_meter_tenant`, `cloud_usage_*` and `cloud_billing_account`. A trigger runs on the shard that holds its row, so once shards split these would read and write empty copies of the control tables, silently.
5. Queries that join tables of both groups, and transactions that write both, ran. They ran on one physical shard; nothing here shows how they behave once the groups are on different shards.

## Decision

1. **Routing is opt-in.** `dataTopology` takes `routedTables` instead of `unshardedTables`. The authoritative group is the default for the cluster, the database and the schema, and only the listed tables are bound to `actor_data`. A table nobody listed stays where every statement, view, foreign key and trigger of the control plane works, so forgetting a table can no longer break inserts into it. `infra/src/placement.ts` is deleted.
2. **The control plane routes no table.** `infra/src/database.ts` passes `routedTables: []` for `prod` and `preview`. The `actor_data` group is still declared, over the authoritative shard, so routing tables later rewrites only table bindings. Every statement then reaches one unsharded group, which is the layout every preview and ADR 0092's evidence ran on.
3. **No data shards without routed tables.** `Neki.Database` refuses `shardCount` above 1 when `routedTables` is empty, in `diff` and before any provider call, because the extra shards would stay empty and the first routed tables would then have to move between physical shards.
4. **The framework is unchanged.** The inspection views, migrations and runtime SQL stay as they are. The control plane needs no `durable` view, but changing their shape now would only be needed by a routed layout that cannot run the turn anyway (item 3 of the context).

### Recovering `akter-production`

Deploying this change rewrites the production topology to the layout above. `Neki.Database` permits that rewrite on a single-shard database, and it moves no row, because both groups are the one shard. On the next start the framework migrator replays its unfinished step, `0013`'s `CREATE VIEW durable.actors`, which now succeeds. This was checked on a copy of the crash: a database given the old topology, booted until it failed at `0013` step 2 exactly as production did, had its topology rewritten, and then booted and migrated through `0030` without any change to its journal.

## Moving to routed actor data later

Tables can change group freely while the database has one shard, since a rewrite moves no rows. After the first split, changing a table's group needs Neki's resharding workflows, which `Neki.Database` refuses to stand in for. So every group assignment must be final before `shardCount` rises. The steps, in order:

1. **Shard-targeted sessions for everything on a routed table.** Due-work scans (relay, capped jobs, subscription feeds, holder liveness) already take their bucket ranges from `ShardMap` ([ADR 0067](0067-due-work-shard-ranges.md)), and a range may carry a Neki shard UID. The runtime then needs to:
   - build that map from `__neki.get_data_topology()`, which the service role can read;
   - run retention once per range;
   - lease turn sessions from a pool per data shard, chosen by the actor's bucket.

   A prototype of the first two removed every relay and retention refusal on the routed layout, which suggests the forwarded form is enough. Two constraints come with it. A shard-targeted session refuses router-managed functions (`set_config`, which row-level-security tenancy uses, and `statement_timestamp()`). A shard-targeted session also reads and writes only its own shard's copy of an authoritative table, so any statement in a turn that touches a registry or a control table must use an authoritative client instead ([ADR 0066](0066-authoritative-coordination.md)'s coordination pool).

2. **Inspection views.** A routed group serves only single-table views, so a later view version has to read one table each and expose `placement` through a separate view of `actor_placements` (tools join them), or move to app-level reads. ADR 0028's rule still holds: a breaking change ships as a new view name.
3. **Control-plane tables stay authoritative.** The tables in item 4 of the context stay authoritative. Their actors' turns then write both groups, so before shards split, Neki's multi-shard commit must be proven atomic, or those writes must leave the turn.
4. **Route while on one shard.** Set `routedTables` to the framework's per-actor tables, the 18 that [ADR 0067](0067-due-work-shard-ranges.md)'s catalog test enumerates. Deploy, and replay the statement corpus and soak with zero refusals. This is still a rewrite without data movement.
5. **Then split.** Raise `shardCount`, and move the `actor_data` ranges with Neki's resharding workflow. Tables never change group after this point.

## Evidence and limits

All of the following ran on `akter-preview` (Neki build as of 2026-10-05, one shard) from Dallen's Mac, each on its own `akter_dev_*` logical database whose topology entry was written for that database alone:

- **Old layout.** The production crash reproduced at `0013`. The corpus replay found the refusals in the context. The routed-framework layout produced the relay and retention failures at boot and the 117 refused framework statements in replay.
- **Recovery.** The production-shaped database rewritten to the new layout booted and migrated from `0013` to `0030`, as above.
- **Soak.** That database then ran the API for 36 minutes. Its log holds only its startup line: no router refusal, error or warning. For 18 of those minutes a driver exercised it over HTTP:
  - a sign-up, refused sign-in before verification, email verification and sign-in;
  - an organization and a project;
  - a deployment create (200) and a second create (409);
  - polling the deployment and the deployment list every 22 seconds.

  The relay delivered the `BillingActor`'s job routes (`CustomerBound`, `SubscriptionReconciled`) and its hourly `$cron` `Refresh` tick, and scheduled the next tick.

- **Corpus.** The 3,795 distinct statements were replayed on a fresh database with the new layout, with the outbox clock in its Neki form. Nine are refused, and none of them is a statement production sends to Neki:
  - `pg_current_wal_insert_lsn()`: the Postgres commit flight, which Neki replaces with version 0 under ADR 0092;
  - `pg_stat_activity` with `pg_blocking_pids`, `pg_stat_clear_snapshot()`, and a transaction advisory lock on a session that holds a session lock: test harness;
  - `pg_logical_slot_peek_binary_changes`: `Fleet.view`, which the control plane does not declare;
  - a usage settlement written with a subquery in `UPDATE SET` in `apps/edge/src/quotas.test.ts`, where production settles inside the `cloud_meter_count` trigger.
- **Tests.** `infra` unit tests cover the opt-in binding, the default group and the `shardCount` guard. The Postgres suites of `@rikalabs/akter`, `apps/api` and `apps/edge` pass unchanged.

Not shown:

- any layout with more than one physical shard: cross-shard joins, multi-shard atomicity, `EXPLAIN (NEKI_PLAN)` routing of both signed halves of the key space;
- per-shard turn sessions;
- Neki's resharding workflow;
- whether the router's planner will later push keyed statements down on its own.
