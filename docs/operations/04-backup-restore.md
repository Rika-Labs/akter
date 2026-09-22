# Backup and restore

**Responsibility:** restore service without duplicating authority or external effects.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

The backup unit is the deployment's relational database. It includes every tenant, framework tables, actor-owned tables, receipts, messages, events, workflows, effects, dead letters, database-backed `actor_blobs` chunks, and the Neki outbox when applicable. Framework blobs are `bytea` data inside this boundary, not externally stored objects. If an application separately uses an external provider, it owns that provider's backup/reconciliation obligations. Back up control-plane Postgres separately.

Required restore procedure, to be proven per backend before support is claimed:

1. stop ingress and drain runners; pause message, workflow, effect, cron, and relay execution;
2. restore one mutually consistent database snapshot, including `actor_blobs`, and reconcile any application-owned external resources;
3. deploy code that supports the restored framework, table, state, event, and workflow schemas;
4. invalidate resident activations and re-establish generation ownership;
5. reconcile external effects whose provider outcome may have committed beyond the snapshot;
6. validate receipts, pending messages, workflow runs, dead letters, singleton ownership, and Neki relay state;
7. reopen execution, then ingress, while watching redelivery and duplicate-suppression signals.

Do not delete receipts or outbox rows to make a restore start. Restoring an older snapshot can repeat an external call whose provider result survived; use provider idempotency keys and reconciliation evidence before retrying.

Before reopening ingress, validate the command-expiry policy and its enforcement data against the restored snapshot and current clock. Restore must not make an expired external command identity admissible again. Preserve deduplication evidence for accepted internal work even when its external retry horizon has elapsed. This expiry check does not replace reconciliation for outcomes lost beyond the snapshot; see [retention](retention.md).

Document encryption, RPO, RTO, snapshot timestamp, migration version, blob consistency, and the retained receipt/effect horizons. Any future tenant-only recovery procedure must preserve every related row within the deployment database; no such export/import capability is currently implemented or verified. Optional RLS is not a backup boundary.
