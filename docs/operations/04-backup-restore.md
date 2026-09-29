# Backup and restore

**Responsibility:** restore service without duplicating authority or external effects.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

The backup unit is the deployment's relational database. It includes every tenant, framework tables, actor-owned tables, receipts, messages, events, workflows, effects, dead letters, database-backed `actor_blobs` chunks, and the Neki outbox when applicable. Framework blobs are `bytea` data inside this boundary, not externally stored objects. If an application separately uses an external provider, it owns that provider's backup/reconciliation obligations. Back up control-plane Postgres separately.

## Backups on Postgres

A backup must be **one mutually consistent snapshot of the whole database**. Any of these produces one:

- `pg_dump --format=custom` of the database, which reads every table in one snapshot;
- a base backup with WAL archiving, restored to a single point in time;
- a provider's volume or instance snapshot.

A dump of some tables or schemas, or several dumps taken at different times, is not a backup: a receipt without the state it committed with, or an outbox row without its sender's receipt, breaks exactly-once delivery. Optional RLS is not a backup boundary.

Record with every backup: the snapshot time, the latest id in `actor_migrations`, the retry window in `actor_deployment`, each actor type's `keepReceipts` and `keepEvents`, encryption, and the RPO and RTO it serves.

## Restore procedure

1. **Stop every runner process** of the deployment, and stop ingress. Draining one runner is not enough: a runner that keeps running across the restore holds activations whose generation the restored database can issue again, and it would write its cached, newer state over the restored rows. Pause anything else that writes the database.
2. **Restore one snapshot** into the deployment's database (or a new database the runners will use), including `actor_blobs`, and reconcile any application-owned external resources.
3. **Check the clock.** Command ids carry their own issue and expiry times, checked against the database clock, so the restored database's clock must not be behind the newest id it holds. Run:

   ```sql
   SELECT to_timestamp((max(expires_at_ms) - (SELECT retry_window_ms FROM actor_deployment)) / 1000.0)
       AS newest_issued,
     now() AS database_now
   FROM durable.receipts;
   ```

   `newest_issued` is at most one `commandTimeout` later than a time this database's clock has already reached, because a receipt is written only once its id's intent or timer is due. If `database_now` is earlier than `newest_issued` by more than the largest `commandTimeout` of your actor types, the clock is behind: fix it before starting any runner, because a clock behind the ids makes expired ids admissible again.

4. **Deploy code that supports the restored schema.** A snapshot older than the code migrates forward at boot. Code older than the snapshot's latest `actor_migrations` id starts without migrating, and is safe only if every newer migration was an expand ([migrations](02-migrations.md#expand-and-contract)); deploy the release that took the backup or a later one. Startup refuses a snapshot that applied a higher id while lacking a lower id the code registers. The code's retry window and placements must match the restored `actor_deployment` and `actor_placements`.
5. **List what the provider may have seen beyond the snapshot.** The restored database forgets every turn and every effect attempt after the snapshot:

   ```sql
   SELECT tenant_id, actor_type, actor_id, effect_id, effect, attempts, ambiguous, last_error
   FROM durable.effects WHERE attempts > 0;
   SELECT * FROM durable.dead_letters;
   ```

   Every restored effect row runs again, with its original effect id as the idempotency key and its recorded attempt count, including one whose call was in flight when the backup was taken. A provider that honours the idempotency key answers without acting twice; for one that doesn't, reconcile these rows with the provider before starting runners. Effects the snapshot never recorded, from turns after it, are gone from the database; reconcile them from the provider's records.

6. **Start the runners, then ingress.** Each actor's first turn takes a generation above the snapshot's. Pending intents, timers, and effects in the snapshot are delivered once. Watch redelivery, `CommandExpired`, and duplicate-suppression signals.

Do not delete receipts or outbox rows to make a restore start.

### What a client sees after a restore

- A command whose receipt the snapshot holds replays its outcome while its id is live.
- An expired id is refused with `CommandExpired`, whether or not the snapshot holds its receipt: expiry is part of the id, not the receipt.
- A command that committed after the snapshot and whose id is still live runs again, once, when its client retries: the restored history never saw it. This is the restore's RPO window. Its external consequences need the reconciliation in step 5.
- Accepted internal work in the snapshot, such as pending intents and effects, completes even when the external retry horizon of the command that created it has passed.

## Evidence

[`conformance/restore.ts`](../../packages/durable-actors/src/testing/conformance/restore.ts) rehearses this procedure on PGlite and Postgres. The backup is a copy of the whole stopped database (a Postgres template copy; a copy of a PGlite data directory), and the restored runtime starts on the copy with no runtime left running:

- `restores a backup without reopening expired command ids or dropping pending intents`
- `replays a receipt the backup holds and runs an unexpired command the backup lost once`
- `retries an effect in flight at the backup with its idempotency key after restore, and routes its result once`

On Postgres, `keeps receipt replay, expiry, and pending intents across two runtime versions behind one database during a rolling deploy` covers mixed versions ([migrations](02-migrations.md#two-runtime-versions-behind-one-database)).

Not rehearsed: `pg_restore` of an online `pg_dump` and point-in-time recovery, which produce the same kind of snapshot but are not run in CI; Neki; and a restore to a snapshot taken before a tenant move.

## Limits

- **Every runner stops first.** Nothing detects a runner that survived a restore; step 1 is required.
- **No clock rollback.** Expiry is read from the database clock. The check in step 3 catches a clock behind the restored data at start; a clock stepped back while runners serve is not detected.
- **Whole database only.** There is no tenant-only export, import, or restore. Any future tenant-only procedure must preserve every related row within the deployment database.
- **PGlite.** A copy of a stopped `dataDir` is the only backup method; see [below](#embedded-pglite).

Retained receipt and effect horizons bound what a restore can deduplicate; see [retention](retention.md).

## Embedded PGlite

Target, built by M4.14 ([ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)). The only supported backup is a stopped copy: stop the process, which releases the `dataDir` lock, copy the directory, and start again. Restore copies it back while the process is stopped. A copy taken while the process runs is not a backup. An in-process `pg_dump` waits for a `pgDump` build compatible with the pinned PGlite. The command-expiry check and effect reconciliation above still apply, and there is no point-in-time recovery.

## Cold tier

Target, built by L.2 ([ADR 0036](../decisions/0036-cold-tier.md)). The object store is inside the backup boundary: it must be versioned or replicated with at least the database's durability, objects are kept past the backup retention, and a restore checks that every `cold_ref` in the snapshot exists.
