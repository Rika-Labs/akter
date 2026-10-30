# ADR 0096: What a Neki database does once it has more than one shard

**Status:** superseded by [ADR 0112](0112-postgres-and-pglite-only.md) (2026-10-08). Multi-shard Neki behavior is no longer a framework target; the record below preserves historical observations.

**Amended by:** [ADR 0097](0097-authority-placed-control-plane-actors.md), which replaces decision item 4 for `UsageActor`, `BillingActor`, `DeploymentLifecycle`, `TenantHome` and `CloudRunners` with authority placement, and keeps bucket -128 on the authoritative shard in every split topology.

**Responsibility:** record how Neki routes, commits, joins and reshards across physical shards, fix the routing topology the stack generates, and decide which control-plane actor turns can run once actor rows leave the authoritative shard.

**Authority:** implementation decision record. It amends [ADR 0093](0093-neki-routing-topology.md) (its key ranges and its plan for moving to routed actor data) and the Neki rule of [contract 06](../contracts/06-storage-ownership.md).

**Owner role:** runtime, control plane and infrastructure.

**Change policy:** supersede through a new ADR.

## Context

ADR 0093 left the multi-shard behaviour of Neki unshown: routing of both signed halves of the key space, atomicity of a transaction that writes two shards, cross-shard joins and the control-plane triggers, and the resharding workflow. Its last step, routing the framework's 18 per-actor tables and then splitting, rested on those.

To observe them, a cluster `akter-neki-lab` was created in the PlanetScale organization `akter` (region `us-east`, Neki build `v0.0.0-20261003201000-836aff6f3e3a`, PostgreSQL 18.6) with the layout `infra/src/neki` builds for `shardCount: 2`: an authoritative shard `sh1` and two data shards `sh2` and `sh3`. It ran on PS-DEV shards, then PS-10, with an NKR-0 router, from Dallen's Mac, and was deleted afterwards. Each run used its own logical database (`akter_dev_lab_*`) with its own topology entry:

- `akter_dev_lab_probe`: a routed probe table and an authoritative one, with deferred constraint triggers that fail or sleep at `COMMIT` on one shard.
- `akter_dev_lab_split`: the API's real schema (migrated by booting `apps/api` with `CONTROL_PLANE_DATABASE_ENGINE=neki`), with the 18 per-actor tables of [ADR 0067](0067-due-work-shard-ranges.md)'s catalog routed across `sh2` and `sh3`.
- `akter_dev_lab_move`: the same schema with the 18 tables routed on `sh1` alone, then resharded onto `sh2` and `sh3`.

## Findings

### Routing by key range

1. **A `range` index orders its value as a signed 64-bit integer, and a key-range bound is a hexadecimal integer, not a prefix.** With the topology ADR 0093 generated (`range` on `routing_key`, bounds `80`), a sweep of 154 keys put every negative key and the keys 0 to 127 on the first data shard and every key from 128 up on the second. The bounds `40`, `0100` and `4000000000000000` split the keys at 64, 256 and 2^62. Neki refuses `8000000000000000` ("must fit in a signed 64-bit integer") and any negative bound ("invalid end hex"), so no bound can split the negative half of the key space. Neki only checks a group's bounds once a table is bound to it.
2. **Routing by the bucket works.** With the index on the expression `(routing_key >> 56) + 128` and the same bounds, the split falls exactly on bucket boundaries in signed order: buckets -128 to -1 on `sh2`, 0 to 127 on `sh3`. One row in each of the 18 tables for each of ten keys (`-2^63`, `-1`, `0`, `2^63 - 1` and six keys of real control-plane actors), 180 rows, all landed on the expected shard, none on `sh1`. The foreign keys among the 18 tables were enforced on the data shard. `EXPLAIN (NEKI_PLAN, NEKI_PG_PLAN, ANALYZE)` shows `Route [EqualUnique]` on the expected shard UID for a keyed read, `Route [IN]` for a key list and `Route [Scatter]` for an unkeyed one.

### Commits that reach two shards

Each case wrote a row on `sh1` (authoritative) and a row on `sh3` (routed) in one transaction on a plain router session, then read each shard directly:

| Fault                                                                                | Client sees                                           | `sh1`                                      | `sh3`                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------ | --------------------- |
| none (`COMMIT`)                                                                      | success                                               | committed                                  | committed             |
| client socket closed before `COMMIT`                                                 | connection lost                                       | rolled back                                | rolled back           |
| statement error on either shard before `COMMIT`                                      | the error                                             | rolled back                                | rolled back           |
| router replaced (`NKR-0` → `NKR-1`) with the transaction open                        | `terminating connection due to administrator command` | rolled back                                | rolled back           |
| one shard's backend ends before `COMMIT` (its `idle_in_transaction_session_timeout`) | `08006` at `COMMIT`                                   | committed if it was not the one that ended | the same              |
| deferred trigger fails at `COMMIT` on `sh3`                                          | the error                                             | **committed**                              | rolled back           |
| deferred trigger fails at `COMMIT` on `sh1`                                          | the error                                             | rolled back                                | **committed**         |
| `sh3`'s commit takes 8 s                                                             | success after 8 s                                     | visible at once                            | visible after 8 s     |
| client socket closed while one shard is committing                                   | connection lost                                       | committed                                  | committed             |
| `sh3`'s commit takes 7 min while the router is replaced                              | `57014` after 30 s                                    | visible at once                            | committed 7 min later |

Neki commits the shards in parallel, with no two-phase commit, which matches its documented Platform Preview limit. A failure at or during `COMMIT` can therefore leave one shard committed and the other not, a reader can see one shard's half for as long as the other takes, and an error returned for `COMMIT` does not mean nothing committed. `pg_terminate_backend` is refused (`0A000`), even on a shard-targeted session, and `SET LOCAL` of a Postgres setting stays on the router, so a backend could only be ended from inside a trigger on its own shard.

With the turn session's settings, `__neki.tx_mode = 'single'` and `__neki.fanout = 'single'`, the second shard is refused at the statement that would reach it (`NK313`), whether it reads or writes and whichever shard came first, including two data shards; the transaction then commits nothing. A join across groups is refused as a fan-out (`NK312`).

### Joins, views, triggers and shard copies

On `akter_dev_lab_split`:

- **Joins through the router are correct.** A join of `actor_generations` (routed) and `cloud_meter_tenant` (authoritative) returned all 10 rows across both data shards; the router plans a hash join of a scatter route and an `AnyShard` route. A keyed join, a `GROUP BY` and an `EXISTS` semi-join returned the expected results.
- **Views:** a view over tables of two groups is refused (`[122]`), including every `durable.*` inspection view. A view over one routed table is accepted and reads both shards.
- **Control-plane triggers on authoritative tables run on `sh1`.** An insert into `cloud_meter_evidence` through the router wrote its `cloud_meter_hour`, `cloud_usage_hour` and `cloud_usage_account` rows on `sh1` only; an insert into `cloud_billing_state` wrote `cloud_billing_account` on `sh1`; a `tenant_directory` insert took its version from the one sequence.
- **A turn-shaped transaction on a turn session** (`actor_generations` row on `sh2`, then `cloud_billing_state`) was refused at the second statement (`NK313`) and committed nothing.
- **A shard-targeted session reads and writes the shard's own, empty copy of every authoritative table, without an error.** On `sh2`: `deployment` returned no row for a deployment the router sees; `SELECT ... FOR UPDATE` on it locked nothing; a `cloud_billing_state` insert fired `cloud_billing_project`, which wrote `cloud_billing_account` on `sh2`, where the router never reads it; a `tenant_directory` insert took version 2 from `sh2`'s copy of the sequence while `sh1`'s stood at 38. Only a foreign key (`tenant_directory` → `deployment`) or a trigger that raises (`cloud_meter_bind`'s unbound tenant) failed loudly.

The statement corpus of ADR 0093 (3,795 distinct statements from the Postgres suites) replayed on this layout through plain router sessions refuses 199 statements that ran on the unrouted layout: 82 `durable.*` view reads (`[122]`) and 117 framework statements in the forms ADR 0093 lists (`[100]`, `[117]`, `[579]`, `[929]`, `[116]`, `[107]`, `[816]`, `[992]`, `[110]`, `[103]`). On a session targeted at a data shard, 187 of them run unchanged (each view then reads that shard alone), 11 fail only because the corpus's parent rows are not on that shard, and one is an `EXPLAIN ANALYZE` that a shard-targeted session refuses. The other differences are the test harness's own table and two connection resets. Replayed again on sessions with the turn's settings, 330 more statements are refused because they would reach more than one shard (317 scatters, 11 key lists, 2 two-shard reads): statements on routed tables with no `routing_key` or with several, as the relay, retention, inspection and test statements are. Of the 540 refusals on those sessions, 519 run unchanged on a shard-targeted session; the rest are `pg_blocking_pids`, four statements that call a router-managed function, and foreign-key failures of the corpus's own fixtures.

### Resharding

Moving the 18 tables of `akter_dev_lab_move` from a group on `sh1` to a group over `sh2` and `sh3` (bounds `80` on the bucket index) with Neki's `Reshard` workflow (`__neki.reshard_create`, `workflow_start`, `differ_create`, `workflow_switch_traffic`, `workflow_complete`):

1. **On PS-DEV shards it cannot start** (`NK603`, "replicator for shard ... is unavailable"). After the profile was resized to PS-10 it started.
2. **It refuses a database whose views outside the moved schema read moved tables** (`NK016`). With the first view set it named all 13 `durable.*` views that read a moved table: those that join `actor_placements`, and `durable.contents`, which reads only moved tables, as "outside the moved schemas". After merging [ADR 0095](0095-single-table-inspection-views.md), a database booted with migration `0031` and stripped of the first set was refused the same way for all 14 single-table `_v2` views, although the router serves them on the routed group. With those dropped, `durable.placements_v2` (which reads the authoritative `actor_placements`) and `durable.views` (no table) left in place, and a single-table view created in `public`, the moved schema, `reshard_create` succeeded. The views were dropped for the run.
3. **Live writes lost nothing and duplicated nothing.** Four clients ran keyed transactions for 41 minutes, each incrementing an actor's `event_sequence` in `actor_generations` and inserting the matching `actor_events` row, across the copy (10,886 rows in about 10 s), the streaming phase, the differ, the switch and completion. Of 23,618 transactions, 23,617 were acknowledged, one lost its connection at `BEGIN` before writing, and none had an unknown outcome. Afterwards the router saw all 512 actors and 23,616 events, every acknowledged event, no event twice, no gap in any actor's sequence, and every event count equal to its actor's `event_sequence`. `sh2` held exactly the 256 negative-key actors and `sh3` the 256 others. The differ compared 15,871 rows with no mismatch. During the switch (2.97 s) writes were held, the slowest taking 3.2 s, and none failed. Resizing the shards from PS-DEV to PS-10 under the same load failed no write either.
4. **After cutover the tables belong to the workflow's target group**, here `actor_data_moved`, not to the source group's name. `sh1` keeps its copy of the moved rows unless completion is asked to drop them; the router no longer reads it.

## Decision

1. **The data group routes by bucket.** `dataTopology` declares the `range` index on `ROUTING_BUCKET`, `(routing_key >> 56) + 128`, so its bounds, still `keyRanges`' hexadecimal bytes, are bucket boundaries in signed order: shard `i` owns one contiguous run of signed buckets, as `ShardMap`'s ranges assume. `bucketHex(b)` is `b + 128`, `shardBucketSpans` returns one span per shard, and `placementOf` compares bounds as integers. A database that has one shard takes the new index as a rewrite that moves nothing.
2. **Only the framework's per-actor tables can be routed.** `ROUTABLE_TABLES` lists the 18; `Neki.Database` refuses any other entry of `routedTables` in `diff`, before a provider call. The framework's catalog test asserts that those tables carry no trigger and that their foreign keys reference only each other. Owned tables, control tables and registries therefore stay on the authoritative shard, where their triggers, sequences and foreign keys find their rows.
3. **Turn sessions keep refusing a second shard.** Because a two-shard commit is not atomic, `__neki.tx_mode = 'single'` is what keeps a turn whole after a split. Every process that runs actors against the Neki control plane must declare it: `akter tenants create`, which embeds `TenantHome`, now reads `CONTROL_PLANE_DATABASE_ENGINE` (or `--engine`) and passes `neki` to `Database.postgres`. Without it, its turns ran with `tx_mode` unset.
4. **Control-plane actors, turn by turn.** After a split each actor's framework rows (`actor_generations`, `actor_receipts`, `actor_state`, `actor_outbox`) are on a data shard, so a turn that reads or writes any authoritative table is refused (`NK313`), and on a shard-targeted session it would use empty copies instead.
   - `CollectorActor`: its turns touch framework rows only; its `Collect` job writes `cloud_meter_storage_sample` off-turn. It can stay as is.
   - `UsageActor` (`Import`, `Seal`, `FlushResolved`, `FlushDeadLettered`), `BillingActor` (every command and route, through `cloud_billing_state`, `cloud_billing_request`, `cloud_billing_event` and the `cloud_billing_project` trigger), `DeploymentLifecycle` (its rollout tables, and `deployment`, `cloud_meter_tenant`, `hosted_api_key`, `deployment_host`, `deployment_jwt`, `cloud_environment`, `cloud_project`, `cloud_audit` in `register` and `activate`), `TenantHome` (`tenant_directory`, its sequence and advisory lock, and `deployment`) and `CloudRunners` (`deployment` read under `FOR SHARE`/`FOR UPDATE`, `deployment_runner`, `runner_wake`): none can stay as is. Their control access is part of each turn's decision, not only its writes, so it cannot simply be sent to an outbox. Before the control-plane database splits, each needs its owned tables routed with its actor rows, every trigger effect on a shared control table turned into an off-turn projection driven by an outbox job, and every read or lock of a control row taken by a job whose result the turn receives.
   - Until that is built, the control-plane database keeps every table on the authoritative shard and one shard. `infra/src/database.ts` already routes nothing there, and `Neki.Database` refuses `shardCount` above 1 without routed tables.
5. **No `durable` view may read a routed table while the split runs.** Neki's `Reshard` refuses to start while any view outside the moved schema reads a moved table, the single-table `_v2` views included, so ADR 0093's step 2 and ADR 0095 do not make the database splittable by themselves. Before the reshard the views that read routed tables must be dropped (and created again after cutover) or live in the moved schema.

### Changes to ADR 0093's plan

- Step 1's per-shard turn sessions are correct only for actors whose turns touch nothing but routed tables (finding: shard copies). The runtime must refuse to lease one for any other actor.
- Step 4 (route while on one shard) remains a rewrite with no movement, and makes the control plane's actors run on a routed group whose only shard is the authoritative one. Step 5 (split) applies only once every actor in the database passes item 4 above.
- The split runs on PS-10 or larger shards, with no `durable` view reading a routed table, and its target group must be the group `Neki.Database` reads as the data group. The resource looks for `actor_data`, and a reshard's target needs a new name, so the move needs either a rename of the single-shard group first or a resource that finds the data group by the routed tables' bindings.

## Evidence and limits

- `infra/src/neki/topology.test.ts` reads key ranges as the live router placed rows (signed index value, integer bounds) and checks bucket ownership for 16 shard counts, the signed-order bounds, one span per shard, integer bound comparison and the routable list. `infra/src/neki/database.test.ts` checks that `diff` refuses an owned table, a control table and a registry before any provider call.
- `packages/akter/src/runtime/database/migrations.test.ts` (Postgres) asserts that the per-actor tables carry no trigger and reference only each other, and detects an injected trigger and an injected outside foreign key.
- `apps/cli/src/commands/tenants/create.test.ts` (Postgres) runs `tenants create` with `CONTROL_PLANE_DATABASE_ENGINE=neki` on the Neki stand-in, which only the Neki migration protocol satisfies, and refuses an unknown `--engine`.
- The lab runs above: routing sweeps and the 18-table placement, 21 commit cases, the joins, views, triggers and shard-session reads, the corpus replays, and the 41-minute reshard under writes. Scripts and logs stayed on the Mac that ran them.

Not shown:

- Neki under production sizes, replicas or a primary failover.
- A `COMMIT` cut by a router failure mid-commit; the router could only be replaced, which waited for or outlived the commit.
- A split of a database whose turns run (the framework's turn and relay statements are refused on a routed group, ADR 0093), per-shard turn sessions, and a reshard of the control plane's own actors.
- The `_v2` views across two data shards (they were read here only on a routed group with one shard), and creating them again after a cutover.
