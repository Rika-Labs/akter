# ADR 0066: Authoritative coordination, independent of actor-data placement

**Status:** implementation decision (2026-10-03); Neki verification remains pending #66.

**Responsibility:** separate deployment-wide ownership from shard-local transactions for #482 and #483.

**Authority:** design decision record.

**Owner role:** runtime/database.

**Change policy:** supersede through a new ADR.

## Context

[ADR 0006](0006-scale-rules-placement-and-query-tiers.md) permits actor data to span shards. PostgreSQL advisory locks belong to one database, not to a deployment. A retention sweep or workflow acceptance on two databases can therefore both acquire the previous per-type advisory lock. Neki also restricts a session's advisory locks to one shard, so Effect Cluster's shard ownership and the fleet maintainer cannot depend on whichever shard an actor-data connection reaches.

[ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)'s capped job claims have a different scope: every row counted by a cap belongs to one actor and hence one routing key. They do not need deployment-wide exclusion. [ADR 0057](0057-neki-suite-preparation.md) prepares Neki testing but does not establish provider behavior; moving lock authority does not remove its other locality and deployment gates.

## Decision

### One designated coordination primary

`Database.postgres({ coordination })` accepts an independent PostgreSQL pool configuration. Every runner of one deployment must point it to the same unsharded authoritative primary. The default is the existing off-turn pool, which preserves ordinary single-database deployments. A streaming replica is never a coordination authority. The optional pool has its own client and transaction service, so an actor-data transaction cannot accidentally route its statements to the coordination connection.

The coordination pool owns `actor_coordination`, `actor_coordination_migrations`, Effect Cluster's `cluster_runners` and, in table-lock mode, `cluster_locks`. On Neki these tables must live in the unsharded authoritative group; when session locks are used, the endpoint must explicitly reach that group rather than rely on bare advisory-key routing. This option does not discover a shard map or move actor rows, workflow manifests, fleet source/derived tables, or a logical replication slot.

The coordination-only migration creates the coordination table under a separate migration ledger and lock. Amendment (#487): [ADR 0070](0070-neki-startup-migrations.md) serializes creation of that ledger before the transactional Migrator begins; opt-in Neki initialization uses fixed, replayable autocommit creates and propagation barriers instead. Cluster tables are prepared under the same bootstrap mutex on the designated coordination pool before storage starts. Framework migration `0027_coordination` creates the same table on data databases. Both creation paths are idempotent when the designated pool points to the same database through another client. Deployment wiring and topology remain operator responsibilities: using two coordination databases creates two independent deployments' authorities, not fault tolerance.

### Retention and workflow acceptance use transaction-owned rows

`runtime/database/coordination.ts` acquires an exact text resource identity with an `INSERT ... ON CONFLICT DO UPDATE` in a coordination transaction. The write locks either the newly inserted row or the existing row until commit or rollback. Resources are `akter/retention/<actor type>` and `akter/workflows/<actor type>`. Rows remain after use: deleting an idle lock identity could split contention between an old locked row and a replacement.

This is a transaction-owned lease, not a time-expiring lease. There is no application clock, owner token, renewal deadline, or cached ownership boolean. A contender waits for the database row lock. The coordination transaction remains open until the data transaction has committed or rolled back. Retention releases it after each short batch, not after the whole sweep; interrupted sweeps still leave only committed batches.

When authority and data use different clients, the data transaction also locks its local resource row before touching data. Lock order is always authority, then data. This local fence is necessary: a lost authority connection releases its row even while another database is still completing a query. A replacement reaching the same data database waits for the old data transaction's commit or rollback, so a lost coordination lease alone never authorizes overlapping writes there. The authority connection is probed during the work and before the data transaction commits; an observed connection failure interrupts the guarded work and rolls back its transaction.

The global mutex serializes active contenders across databases; the local transaction fence preserves exclusion of conflicting data writes when the authority connection fails. This is not distributed atomic commit or a shared cross-shard snapshot. A connection can fail after the last successful probe, or after the data commit and before the coordination commit; a retry must re-read data. Retention is idempotent and workflow acceptance compares persisted manifests again. Workflow compatibility still checks executions visible in the selected data database/router; scanning all direct shards and providing a shared snapshot is outside this change. No provider-wide compatibility or partition-recovery claim is inferred from the mutex.

Local fences use the distinct `local/` resource namespace. Two independent clients can point to the same physical database; locking the exact same row through both would make the data transaction wait on its own authority transaction. A same-database, separate-pool regression exercises both retention and workflow acceptance and asserts the distinct persisted resource identities.

### Capped jobs lock the actor's generation row on its data shard

`runtime/jobs/attempt.ts` replaces its hash-based advisory lock with `SELECT ... FOR NO KEY UPDATE` on the actor's generation row, naming the complete `(routing_key, tenant_id, actor_type, actor_id)` key. The lock is `NO KEY UPDATE` because a settling attempt holds its job row and then takes a key-share lock on that generation row for its dead-letter insert, while a claim holding the generation row waits for that job row; `FOR UPDATE` conflicts with the key share and deadlocks the two. `NO KEY UPDATE` still conflicts with other claims, wakes, and actor turns, which take `FOR UPDATE`. Capped claims and waiting-row wakes already run in transactions, so the row lock covers their count and updates. Actor turns use the same row and the same generation-before-outbox lock order.

This deliberately serializes capped jobs of different types on the same actor, and may briefly delay an actor turn. It avoids a new per-job authority table and cross-database coordination on a hot path. Actors on different shards do not share a cap, so allowing their claims to proceed independently is correct. Attempt renewal, cancellation, guarded settling, and generation fences are unchanged.

### Cluster and fleet use the designated authority

`runtime/topology/locks.ts` builds `SqlRunnerStorage` with the coordination client. Both runner registrations and shard-ownership operations therefore use one authority. Session advisory locking remains the default on ordinary PostgreSQL. Existing `shardLockDisableAdvisory` wiring selects Effect Cluster's table leases; singleton lease checks now read `cluster_locks` from that same authority instead of the actor-data pool.

`runtime/fleet/maintainer.ts` reserves its lock session on the coordination pool. Fleet queries and transactions retain a separately reserved data session. The fleet session advisory lock is appropriate because ownership covers a long-lived logical slot reader; an expiring table lease without fences on slot advancement and derived writes would admit a stale maintainer. When the pools differ, a heartbeat on the reserved authority session interrupts the maintainer on a detected session failure. Clean shutdown releases the authority lock. The existing one-slot feed is unchanged; a feed spanning Neki shards still requires provider-specific evidence.

## Alternatives rejected

- **Keep hash-based locks on actor pools.** Two databases grant them independently, and hashes also conflate unrelated resource identities.
- **Use expiring global leases alone.** A paused runner can write after expiry. A lease deadline cannot fence a transaction in another database.
- **Only per-shard retention/compatibility locks.** Local retention prefixes need only local exclusion, but deployment-wide startup acceptance and the requested common retention scheduling need one shared authority. Retaining a local transaction fence also protects the data when authority is lost.
- **Put capped jobs on the coordinator.** A cap counts one actor's shard-local rows. Adding global traffic does not strengthen it.
- **Run all fleet SQL on the coordination pool.** Its source rows, derived rows, and logical replication slot belong to the data database; changing only the lock location must not move the feed.

## Evidence and remaining gates

`runtime/database/coordination.test.ts` uses two independently migrated data databases and a third coordination database on real PostgreSQL. Database-observed lock waits prove that a retention batch or workflow acceptance blocked inside shard A stops shard B at the common authority before B changes rows. Commit and interruption cases prove release, rollback, and persisted outcomes. Terminating the authority backend proves that the replacement waits on the local data fence and the failed sweep rolls back. The former database-local advisory locks fail the cross-database contention tests.

The same suite proves exclusive acquisition of two Cluster shard ids and takeover after release for session locks and table leases, checks that runner storage tables are on the authority, exercises singleton lease reads there, checks the fleet authority lock and shutdown release, and proves capped jobs wait for their data-shard generation row. Existing Postgres and PGlite retention, workflow versions, capped-job and singleton/fleet suites remain required.

Neki's multi-shard Cluster ownership, singleton failover, advisory routing, fleet feed, and migrations have not been run here. #483's provider evidence remains pending #66; the support matrix must continue to say unverified for those cells.

## Revisit when

- Direct shard mapping needs to collect workflow execution history from multiple databases, rather than a router exposing it to the existing compatibility check.
- Neki evidence establishes an authoritative endpoint and multi-shard logical feed behavior.
- Coordination contention requires finer retention scheduling, or capped-job generation locking measurably delays turns.
- A supported cross-database atomic commit mechanism allows removing the retry ambiguity between data commit and authority release.
