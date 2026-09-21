# Backup and restore

**Responsibility:** restore service without duplicating authority or external effects.  
**Authority:** operational.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

The backup unit is the deployment's Postgres database, plus any external blob bytes referenced by actor records. It includes every tenant, framework tables, actor-owned tables, receipts, messages, events, workflows, effects, dead letters, and the Neki outbox when applicable. Back up control-plane Postgres separately.

Restore procedure:

1. stop ingress and drain runners; pause message, workflow, effect, cron, and relay execution;
2. restore one mutually consistent database snapshot and compatible blob data;
3. deploy code that supports the restored framework, table, state, event, and workflow schemas;
4. invalidate resident activations and re-establish generation ownership;
5. reconcile external effects whose provider outcome may have committed beyond the snapshot;
6. validate receipts, pending messages, workflow runs, dead letters, singleton ownership, and Neki relay state;
7. reopen execution, then ingress, while watching redelivery and duplicate-suppression signals.

Do not delete receipts or outbox rows to make a restore start. Restoring an older snapshot can repeat an external call whose provider result survived; use provider idempotency keys and reconciliation evidence before retrying.

Document encryption, RPO, RTO, snapshot timestamp, migration version, blob consistency, and the retained receipt/effect horizons. Tenant-only recovery is a logical export/import procedure within the deployment database and must preserve every related row; optional RLS is not a backup boundary.
