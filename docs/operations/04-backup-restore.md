# Backup and restore

**Responsibility:** restore service without duplicating authority or external calls.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

The backup unit is the deployment's relational database. It includes every tenant, framework tables, actor-owned tables, receipts, messages, events, workflows, jobs, dead letters, database-backed `actor_blobs` chunks, and the Neki outbox when applicable. Framework blobs are `bytea` data inside this boundary, not externally stored objects. If an application separately uses an external provider, it owns that provider's backup/reconciliation obligations. Back up control-plane Postgres separately.

## Backups on Postgres

A backup must be **one mutually consistent snapshot of the whole database**. Any of these produces one:

- `pg_dump --format=custom` of the database, which reads every table in one snapshot, even while the runners keep committing ([rehearsed](#online-pgdump-and-point-in-time-recovery)); restore it with `pg_restore` into a new database;
- a base backup with WAL archiving, recovered to a single point in time (`recovery_target_name`, `recovery_target_time`, or `recovery_target_lsn`, with `recovery_target_action = 'promote'`), with the recovery server started with the source server's `max_connections`;
- a provider's volume or instance snapshot.

A dump of some tables or schemas (`--table`, `--schema`, `--exclude-table`), or several dumps taken at different times, is not a backup: a receipt without the state it committed with, or an outbox row without its sender's receipt, breaks exactly-once delivery. Optional RLS is not a backup boundary.

Record with every backup: the snapshot time, the latest id in `actor_migrations`, the retry window in `actor_deployment`, each actor type's `keepReceipts` and `keepEvents`, encryption, and the RPO and RTO it serves.

## Restore procedure

1. **Stop every runner process** of the deployment, and stop ingress. Draining one runner is not enough: a runner that keeps running across the restore holds activations whose generation the restored database can issue again, and it would write its cached, newer state over the restored rows. Pause anything else that writes the database.
2. **Restore one snapshot** into the deployment's database (or a new database the runners will use), including `actor_blobs`, and reconcile any application-owned external resources.
3. **Check the clock.** Command ids carry their own issue and expiry times, checked against the database clock, so the restored database's clock must not be behind any id that could still be retried. Two checks, both required:
   - **Against the backup record.** `now()` on the restored database must be later than the snapshot time recorded with the backup. A receipt is never pruned before its id expires, so every id whose receipt was pruned before the snapshot had expired by the snapshot time, and stays expired while the clock is past it. This check does not depend on what the snapshot retained.
   - **Against a trusted time source.** The database host's clock must agree with NTP or another reference within the offset you accept. The database cannot prove this itself: ids admitted after the snapshot are gone from it, and only real time says whether they have expired.

   As a cross-check on the data, this query reports the newest issue time among the ids the snapshot still holds receipts for:

   ```sql
   SELECT to_timestamp((max(expires_at_ms) - (SELECT retry_window_ms FROM actor_deployment)) / 1000.0)
       AS newest_issued,
     now() AS database_now
   FROM durable.receipts;
   ```

   `newest_issued` is at most one `executionTimeout` later than a time this database's clock had already reached, because a receipt is written only once its id's intent or timer is due; it is `NULL` when no receipt is retained, which proves nothing. If `database_now` is earlier than `newest_issued` by more than the largest `executionTimeout` of your actor types, the clock is behind. If any check fails, fix the clock before starting any runner, because a clock behind the ids makes expired ids admissible again.

4. **Deploy code that supports the restored schema.** A snapshot older than the code migrates forward at boot. Code older than the snapshot's latest `actor_migrations` id starts without migrating, and is safe only if every newer migration was an expand ([migrations](02-migrations.md#expand-and-contract)); deploy the release that took the backup or a later one. Startup refuses a snapshot that applied a higher id while lacking a lower id the code registers. The code's retry window and placements must match the restored `actor_deployment` and `actor_placements`.
5. **List what the provider may have seen beyond the snapshot.** The restored database forgets every turn and every job attempt after the snapshot:

   ```sql
   SELECT tenant_id, actor_type, actor_id, job_id, job, attempts, ambiguous, last_error
   FROM durable.jobs WHERE attempts > 0;
   SELECT * FROM durable.dead_letters;
   ```

   Every restored job row runs again, with its original job id as the idempotency key and its recorded attempt count, including one whose call was in flight when the backup was taken. A provider that honours the idempotency key answers without acting twice; for one that doesn't, reconcile these rows with the provider before starting runners. Jobs the snapshot never recorded, from turns after it, are gone from the database; reconcile them from the provider's records.

6. **Start the runners, then ingress.** Each actor's first turn takes a generation above the snapshot's. Pending intents, timers, and jobs in the snapshot are delivered once. Watch redelivery, `CommandExpired`, and duplicate-suppression signals.

Do not delete receipts or outbox rows to make a restore start.

### What a client sees after a restore

- A command whose receipt the snapshot holds replays its outcome while its id is live.
- An expired id is refused with `CommandExpired`, whether or not the snapshot holds its receipt: expiry is part of the id, not the receipt.
- A command that committed after the snapshot and whose id is still live runs again, once, when its client retries: the restored history never saw it. This is the restore's RPO window. Its external consequences need the reconciliation in step 5.
- Accepted internal work in the snapshot, such as pending intents and jobs, completes even when the external retry horizon of the command that created it has passed.

## Evidence

[`conformance/restore.ts`](../../packages/durable-actors/src/testing/conformance/restore.ts) rehearses this procedure on PGlite and Postgres. The backup is a copy of the whole stopped database (a Postgres template copy; a copy of a PGlite data directory), and the restored runtime starts on the copy with no runtime left running:

- `restores a backup without reopening expired command ids or dropping pending intents`
- `replays a receipt the backup holds and runs an unexpired command the backup lost once`
- `retries an effect in flight at the backup with its idempotency key after restore, and routes its result once`

On Postgres, `keeps receipt replay, expiry, and pending intents across two runtime versions behind one database during a rolling deploy` covers mixed versions ([migrations](02-migrations.md#two-runtime-versions-behind-one-database)).

### Online `pg_dump` and point-in-time recovery

[`crash/drills/online-restore.test.ts`](../../packages/durable-actors/src/testing/conformance/crash/drills/online-restore.test.ts) runs the same restore cases on the two other kinds of backup, on Postgres 18.6 in a Docker container that archives its WAL ([`online-restore.ts`](../../packages/durable-actors/src/testing/conformance/crash/drills/online-restore.ts)). It runs in `test:integration` and needs Docker.

- **Online `pg_dump`, restored with `pg_restore`.** `pg_dump --format=custom` of the database, then `createdb` and `pg_restore --no-owner --exit-on-error` into a new database the restored runtime starts on. The three restore cases above pass on it, plus `restores one consistent snapshot of a database whose turns keep committing during the backup`: six vaults keep committing deposits, each with a pending transfer, while the dump is taken. The restored database holds, for every vault, a state equal to its receipts (no receipt without its state, and no state without its receipt), so it is one snapshot; every command acknowledged before the dump began replays its original reply without running its handler; the deposits acknowledged after the dump finished are absent; and each pending transfer is delivered once.
- **Point-in-time recovery.** A `pg_basebackup` taken before the drill's database existed, plus the archived WAL, recovered with `recovery_target_name` to a restore point (`pg_create_restore_point`) taken while the runtime is stopped, then promoted. The same four cases pass on it. `recovers to a named restore point holding exactly the commits before it` writes three vaults in three phases with restore points between them, and recovers to each point in a server of its own: the first holds only the first phase, with the transfer staged in that phase still pending and delivered once after the restore; the second holds the first two phases; each vault's state and receipt count match, and the next deposit after each recovery lands on the recovered total.

What the drill showed:

- **The recovery server needs the source server's connection limits.** A base backup records `max_connections` of the server it came from, and a server recovering from it refuses to start with a lower value. The first version of the drill started the recovery server with the default and it failed to start; it now passes the source's value.
- **Name the restore point, then archive its segment.** The drill calls `pg_switch_wal()` after `pg_create_restore_point` and waits until `pg_stat_archiver.last_archived_wal` reaches the segment that holds the point, so recovery finds it in the archive. Do the same before relying on a restore point: WAL that was never archived cannot be recovered.

Timings from three full runs of the drill file on a heavily loaded Mac (load average 20 to 60 in the first two), which include starting each recovery server and replaying the archive: the four cases took 1.5 to 2.9 s each on `pg_dump` and `pg_restore`, and 6 to 27 s each on point-in-time recovery, with `recovers to a named restore point...` taking 11, 29 and 64 s because it starts three recovery servers. These are not an RTO for a production database; measure yours.

Not rehearsed: recovery to a `recovery_target_time` or LSN (only named restore points), a base backup taken while runners were committing (the drill's base backup precedes its data, and the online-dump case covers committing turns), a provider's volume snapshots, Neki, and a restore to a snapshot taken before a tenant move.

## Limits

- **Every runner stops first.** Nothing detects a runner that survived a restore; step 1 is required.
- **No clock rollback.** Expiry is read from the database clock. The checks in step 3 catch a clock behind the backup or real time at start; a clock stepped back while runners serve is not detected.
- **Whole database only.** There is no tenant-only export, import, or restore. Any future tenant-only procedure must preserve every related row within the deployment database.
- **PGlite.** A copy of a stopped `dataDir` is the only backup method; see [below](#embedded-pglite).

Retained receipt and job horizons bound what a restore can deduplicate; see [retention](retention.md).

## Embedded PGlite

Built by M4.14 ([ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)) and verified by `restores a stopped copy and refuses expired command ids after restore` in [`conformance/crash/pglite-production.test.ts`](../../packages/durable-actors/src/testing/conformance/crash/pglite-production.test.ts). The only supported backup is a stopped copy: stop the process, which releases the `dataDir` lock, copy the directory, and start again. Restore copies it back while the process is stopped. A copy taken while the process runs is not a backup. An in-process `pg_dump` waits for a `pgDump` build compatible with the pinned PGlite. The command-expiry check and job reconciliation above still apply, and there is no point-in-time recovery.

## Cold tier

Target, built by L.2 ([ADR 0036](../decisions/0036-cold-tier.md)). The object store is inside the backup boundary: it must be versioned or replicated with at least the database's durability, objects are kept past the backup retention, and a restore checks that every `cold_ref` in the snapshot exists.
