# ADR 0097: Control-plane actors are authority-placed, so a split control plane runs their turns on the authoritative shard

**Status:** accepted (2026-10-06). Demonstrated on a temporary three-shard Neki cluster with the 18 per-actor tables routed across two data shards; no Akter database has been split.

**Responsibility:** decide how each control-plane actor whose turns read or write authoritative tables keeps working once the control-plane Neki database has data shards, without any turn, trigger or foreign key reaching a control table from a data shard and without depending on a multi-shard commit.

**Authority:** implementation decision record. It replaces item 4 of [ADR 0096](0096-neki-multi-shard-evidence.md)'s decision for `UsageActor`, `BillingActor`, `DeploymentLifecycle`, `TenantHome` and `CloudRunners`, amends [ADR 0094](0094-neki-shard-targeted-sessions.md)'s "Authoritative writes inside turns", adds a placement to [ADR 0033](0033-parent-actor-placement.md)'s set, changes the key ranges [ADR 0096](0096-neki-multi-shard-evidence.md) fixed, and amends [contract 06](../contracts/06-storage-ownership.md).

**Owner role:** runtime, control plane and infrastructure.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0096](0096-neki-multi-shard-evidence.md) found that after a split, every actor's framework rows (`actor_generations`, `actor_receipts`, `actor_state`, `actor_outbox` and the rest of the 18) live on a data shard, and that a turn session there:

- reads and writes the shard's own, empty copy of every authoritative table, with no error;
- is refused at the statement that reaches a second shard (`NK313`), because a commit that spans two shards is not atomic and the turn session says so.

Five control-plane actors read or write authoritative tables inside their turns, through their own SQL, through triggers on their owned tables, and through foreign keys:

| Actor                 | What its turns touch besides its framework rows                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UsageActor`          | owned `cloud_meter_evidence`, `cloud_meter_hour`, `cloud_meter_seal`, `cloud_meter_export`, whose triggers read `cloud_meter_tenant` and write `cloud_usage_*`                                     |
| `BillingActor`        | owned `cloud_billing_state`, `cloud_billing_request`, `cloud_billing_event`; the `cloud_billing_project` trigger writes `cloud_billing_account`                                                    |
| `DeploymentLifecycle` | owned rollout tables; in `register` and `activate`: `deployment`, `cloud_meter_tenant`, `hosted_api_key`, `deployment_host`, `deployment_jwt`, `cloud_environment`, `cloud_project`, `cloud_audit` |
| `TenantHome`          | owned `tenant_directory`, which references `deployment` and takes its version from one sequence under an advisory lock in a trigger; it reads `deployment`                                         |
| `CloudRunners`        | `deployment` under `FOR SHARE` and `FOR UPDATE`, `deployment_runner`, `runner_wake`                                                                                                                |

`CollectorActor`, the sixth actor of the control plane, touches only framework rows in its turns; its `Collect` job writes `cloud_meter_storage_sample` off-turn through the router.

ADR 0096 concluded these five need their logic rewritten: owned tables routed with their rows, trigger effects turned into projections driven by outbox jobs, and every read or lock of a control row taken by a job whose result the turn receives. That is three options:

- **(a)** keep the actor on the authoritative shard, framework rows included;
- **(b)** move control writes out of the turn into the outbox, delivered at least once to an authoritative handler;
- **(c)** move control reads into a snapshot carried by the command.

(b) and (c) apply to writes and reads one at a time. These turns decide on the control rows they read under lock (`CloudRunners.Idle` reads `deployment ... FOR UPDATE`, `TenantHome.Create` relies on the foreign key and the sequence), so they would also need new compensations, idempotency keys and orderings across roughly 4,000 lines, each a new durable transition. (a) changes where the rows live and nothing the handlers do.

The framework had no way to do (a): `placement` (`tenant`, `actor`, `{ parent }`) only derives `routing_key`, and the topology decides the shard from that key alone. A lab run (below) showed that a Neki shard group may give one key range to the authoritative shard and the others to data shards, which is also how PlanetScale's own documentation lays out a group whose metadata shard holds data.

## Decision

### Authority placement

`Actor.make(name, { placement: "authority" })` places an actor like `"tenant"`, then moves its key into one reserved bucket. Its `routing_key` is the tenant key with the top byte replaced by `0x80`, so `routing_key >> 56` is `-128` (`AUTHORITY_BUCKET`) and the low 56 bits stay the tenant key's. A tenant's authority-placed actors share one key, as tenant-placed ones do, and `group` reads them together. A parent-placed type may not name an authority-placed parent, as it may not name a tenant-placed one. A fleet view refuses an authority-placed source, as it refuses every non-tenant placement.

`actor_placements` records `authority`; migration `0034_authority_placement` widens its check constraint.

### Every split topology keeps bucket -128 on the authoritative shard

`infra/src/neki/topology.ts`'s `keyRanges` gives the data group one range per data shard. With one data shard (the authoritative one) nothing changes. With more, the first range, bucket -128 alone (`end: "01"` on `(routing_key >> 56) + 128`), names the authoritative shard, and the data shards split buckets -127 to 127 in signed order as before. `shardCount` can therefore be at most 255. `dataShardsOf` leaves the authoritative shard out of the data shards it reports once there are others.

Ordinary actors whose keys fall in bucket -128, 1 in 256 of them, live on the authoritative shard too. That is correct, since a targeted session there serves them like any data shard, and it costs that shard a little load.

### Turns of authority-placed actors run on the authoritative shard

Nothing new routes them. [ADR 0094](0094-neki-shard-targeted-sessions.md)'s shard map reads the bucket -128 range from the topology like any other, so a turn of an authority-placed actor leases a turn session targeted at the authoritative shard, and its queries, relay claims, job settles and retention run there too. On that session:

- its framework rows and every control table it touches are on the same physical shard, so its commit reaches one shard and `__neki.tx_mode = 'single'` holds;
- triggers on its owned tables run on the shard that holds the real control tables;
- the foreign key from `tenant_directory` to `deployment`, the `tenant_directory_version` sequence and the advisory lock are the authoritative shard's own;
- `FOR UPDATE` on `deployment` contends with the edge's and the API's writes, which reach the same rows through the router.

The runtime refuses what it cannot see: a turn or a query of an authority-placed actor whose bucket the map does not put on the authoritative shard dies before its handler runs, and its transaction commits nothing. This holds whatever SQL the handler sends, unlike ADR 0094's check, which covers only owned tables and usage accounting.

A turn session targeted at a shard refuses a router-managed function beside a table (ADR 0094). The authority-placed actors' own SQL therefore reads `clock_timestamp()`, not `now()`; `DeploymentLifecycle`'s activation was the one statement that needed the change, found by the lab soak. Such a statement fails the turn loudly and the delivery retries; it never writes a wrong copy.

### Per actor

| Actor                 | Option | Why                                                                                                                                                    |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UsageActor`          | (a)    | Its triggers roll evidence up into shared `cloud_usage_*` rows; on the authoritative shard they run where those rows are, in the same commit.          |
| `BillingActor`        | (a)    | The `cloud_billing_project` projection and the account it writes stay in the turn's commit; provider calls were already jobs.                          |
| `DeploymentLifecycle` | (a)    | `register` and `activate` must commit the environment pointer, host mapping, usage binding and lifecycle status together, which only one shard can do. |
| `TenantHome`          | (a)    | The foreign key, the sequence and the advisory lock are only correct on the authoritative shard.                                                       |
| `CloudRunners`        | (a)    | Its idle check reads `deployment` under `FOR UPDATE`; the lock must be the one the edge's activity writes take.                                        |
| `CollectorActor`      | none   | Its turns touch framework rows only. It stays tenant-placed and lives on whichever data shard holds its bucket.                                        |

No control write leaves a turn through the outbox and no command carries a snapshot, so nothing new is delivered at least once. The crash, duplicate and reorder cases that (b) would have to survive do not arise. The control-plane turns' failure model is the framework's ordinary one: a turn commits on one shard or not at all, and a redelivered command answers from its receipt.

### Moving an existing deployment's rows

The five types were tenant-placed, so a database that already holds them has their rows under keys outside bucket -128. When a type that `actor_placements` records as `tenant` (encoding 1) is declared `authority`, its runtime moves the rows at startup instead of refusing the placement change. In one transaction under the record's row lock it:

1. copies the type's `actor_generations` and `actor_workflow_executions` rows to the new keys, since the other per-actor tables reference them;
2. moves the dependent rows of the per-actor tables, `bucket` included;
3. deletes the old parent rows;
4. moves the rows of every table `actor_tables` records the type as owning;
5. records `authority`.

A row already in bucket -128 keeps its key. A concurrent start waits on the row lock and then finds `authority`. A failure rolls everything back and fails the start, and the next start tries again. The move:

- is refused once the shard map names a shard, because a split database would have to move the rows between shards. It must therefore run before the control-plane database routes its tables.
- assumes no runner of the previous release still runs the type, since such a runner would recreate an actor under its old key. The control plane's API is one Fly Machine replaced in place, and an `akter tenants create` of the previous release refuses to start once `authority` is recorded.

## Alternatives rejected

- **Options (b) and (c)** for these actors, for the reasons in the context: more code, more durable transitions and more failure modes than the problem needs.
- **Keeping the routing key and targeting an authority-placed actor's sessions at the authoritative shard anyway.** A targeted session writes wherever it points (ADR 0094). The rows would sit on a shard the topology does not place them on: the router's keyed reads and the inspection views would miss them, per-range scans would never claim their work, and a reshard would not know them.
- **Moving the five actors to one fixed tenant**, whose bucket the topology could pin. `DeploymentLifecycle` is keyed per organization tenant and its owned rows carry that tenant; changing it rewrites `tenant_id` as well as `routing_key`, and still needs the same move.
- **Routing by an expression that also reads `actor_type`.** Three of the 18 tables have no actor type, and the topology would then name application types.

## Evidence

- **Postgres.**
  - `runtime/storage/placements.test.ts` (new) covers the move:
    - It writes two actors' state, receipts, events, an owned row whose trigger projects into a control table, a pending timer and a completed job under tenant placement, then starts the type authority-placed. Every row is then under the moved key, with counts per table unchanged. The state is intact, and the command redelivered with its original id answers from its receipt without running again. The pending timer fires after the move. The control table counts each command once. A build that declares `tenant` again is refused.
    - A trigger that fails part way through the move rolls everything back, keys and record included, and the next start moves once.
    - Two concurrent starts move once.
    - The move is refused while the map names a data shard.
    - Dropping `actor_outbox` from the move fails these tests and the catalog check.
  - `runtime/database/migrations.test.ts` asserts that the move covers every per-actor table in the migrated catalog except the three tenant-keyed ones, and that `actor_placements` accepts `authority` without a parent and refuses one with a parent.
  - `runtime/database/routing.test.ts` (Postgres with ADR 0094's shard guard) checks an authority-placed actor:
    - its turns, a timer, a job settle and a query write every routed row, and the control table its handler writes, from a session targeted at the authoritative shard that holds bucket -128;
    - after its bucket moves to a data shard, its next turn and query die before the handler, and no receipt or control write commits.
  - The unit and Postgres suites of `@rikalabs/akter` (PGlite conformance and crash drills included), `apps/api`, `@akter/deployments`, `apps/cli` and `infra` pass.
  - `runtime/storage/codec.test.ts` pins the key derivation. `infra/src/neki/topology.test.ts` and `database.test.ts` check bucket -128 on the authoritative shard for 16 shard counts, the remaining buckets in near-equal runs, and the reported data shards.
- **Lab cluster.** `akter-neki-lab2` (organization `akter`, `us-east`, three PS-10 shards, `sh1` authoritative, NKR-1 router) ran from 01:09 to 04:08 UTC on 2026-10-06 and was then deleted.
  - **Probe.** The data group `[sh1 to 01] [sh2 01 to 80] [sh3 from 80]` on `(routing_key >> 56) + 128` was accepted. Keys in bucket -128 landed on `sh1`, buckets -127 and -1 on `sh2`, 0 and 127 on `sh3`, and a keyed read planned `Route [EqualUnique]`. A transaction on a turn session targeted at `sh1` wrote a bucket -128 row and an authoritative row and committed both on `sh1`, which the router then read; with a bucket 0 row instead, a turn-settings session was refused at the authoritative write (`NK313`).
  - **Soak.** `akter_dev_ctl_soak` got the topology `dataTopology` generates for two data shards, with `ROUTABLE_TABLES` routed. Its schema was migrated before the routing was applied, because migration `0001` creates `actor_generations` without `routing_key`, and a routed group cannot route such a table ("schema not yet loaded for shard group"). The API ran on it with `CONTROL_PLANE_DATABASE_ENGINE=neki` and Stripe in test mode, beside the edge, local Docker runners and a Postgres cell database. Its first run found `DeploymentLifecycle`'s activation refused on the targeted session (`now()`): a deterministic defect that committed nothing and was retried, and then activated once `clock_timestamp()` replaced it. The soak itself ran for 27 minutes (02:55 to 03:22 UTC), driving:
    - 8 sign-ups, organizations and projects;
    - 10 deployments that built, migrated, started runners and went live, then scaled to zero (`Create`, `RecordBuild`, `StepFinished`; `Wake`, `Started`, `Idle`, `Reconcile`, `Checked`, `Drain`, `Stopped`);
    - 8 Stripe test checkouts and spend limits, and 51 signed webhooks (`InitializeAccount`, `CustomerBound`, `StartCheckout`, `RequestResolved`, `RecordWebhook`, the hourly `Refresh`);
    - 432 commands in the cell's journal, which `CollectorActor` imported and sealed through `UsageActor`. That made 84 evidence rows, rolled up by the triggers, and 3 exports that Stripe's test mode quarantined.

    The driver saw no unexpected status. The API logged 371 lines at `INFO` and nothing at `WARN` or `ERROR`, and no router refusal or dropped connection; the edge logged no warning. `TenantHome.Create` ran four times through `akter tenants create`, with the API stopped, because of the limit below.

  - **Per-shard reads after the soak.** Every non-routed table that holds rows (40 of them, among them `deployment`, `deployment_host`, `hosted_api_key`, `cloud_environment`, `cloud_project`, `cloud_audit`, `cloud_meter_tenant`, `cloud_meter_evidence`, `cloud_usage_hour`, `cloud_usage_account`, `cloud_billing_state` and `cloud_billing_account`, `tenant_directory` and the rollout tables) holds them on `sh1` only. The copies on `sh2` and `sh3` are empty, except `actor_coordination`'s `local/` retention fences, which [ADR 0066](0066-authoritative-coordination.md) keeps on each data shard. `tenant_directory_version` stood at 3 on `sh1` and was untouched on `sh2` and `sh3`. Every row of the five types in the routed tables (32 actors, 4,010 receipts) was in bucket -128 on `sh1`, and `CollectorActor`'s were in bucket 53 on `sh3`. No shard held a row of a bucket it does not own.
  - **Moving existing rows on Neki.** On `akter_dev_ctl_move` (nothing routed, as in production), the API and CLI of `main` wrote tenant-placed rows of `BillingActor`, `DeploymentLifecycle`, `CloudRunners` and `TenantHome` in buckets 53, 59 and 64. The first start of this branch was refused by the router: the copy then selected `(jsonb_populate_record(...)).*` ("composite star expansion must be resolved before evaluation"). The transaction rolled back with nothing moved, and the copy now names its columns. The next start moved the three types the API serves, `UsageActor` had no rows, and every row and owned row landed in bucket -128. The spend limit set before the move read back, and a new one committed. `akter tenants create` of this branch moved `TenantHome` and found the tenant created before the move. The CLI of `main` was then refused ("placement differs from the deployment").

## Limits and open risks

- **The move assumes the previous release is stopped.** Nothing fences a runner of the previous release that is still running when the move commits. A job attempt or relay claim that the new runtime itself started on a row before the move loses its lease when the row moves, and runs again. The lab saw this happen once for a `StopRunner` job and once for a rollout job, so a job can run twice across the move, which its idempotency key covers.
- **Handler SQL is checked only by the router.** A statement of an authority-placed turn that calls `now()`, `nextval()`, `set_config()` or `current_setting()` beside a table is refused on the targeted session. That is loud, but it is caught only by running on Neki.
- **`akter tenants create` cannot run beside the API.** Its embedded runtime joins the API's cluster, and the API does not serve `TenantHome`, so the CLI's command times out while the API runs. It ran correctly on the lab with the API stopped. This predates this change.
- **Splitting the production control plane still needs**, in order:
  1. this change deployed, so the move runs while the database routes nothing;
  2. `routedTables: ROUTABLE_TABLES` on one shard ([ADR 0093](0093-neki-routing-topology.md) step 4). A framework migration that creates one of the 18 tables without `routing_key` cannot run once the table is routed ("schema not yet loaded for shard group"), so the routing must follow the migrations, as the lab's did;
  3. every `durable` view that reads a routed table dropped before the reshard, and created again after cutover ([ADR 0096](0096-neki-multi-shard-evidence.md));
  4. a `Reshard` whose target group keeps bucket -128 on the authoritative shard, which is not yet shown, under a group name `Neki.Database` reads as the data group;
  5. relays drained across the switch (ADR 0094);
  6. the infra stage's `shardCount` raised for `prod`, which `checkShardCount` permits only with routed tables, on PS-10 or larger shards.
