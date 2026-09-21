# Retention policy

**Responsibility:** connect cleanup to correctness.  
**Authority:** operational contract.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

Retention policies cover command receipts, processed messages, events, workflow executions and activities, effects and dead letters, timers, connection metadata, blobs, and audit records.

Never prune a receipt while its command can be redelivered or a caller can retry with the same command id. Never prune a Neki outbox obligation before the relay receipt proves the move to `cluster_messages`. Keep effect identity and provider idempotency evidence through the longest retry, backup rollback, and reconciliation window.

Event retention must cover every supported replay cursor and workflow `waitFor` dependency. Workflow history must outlive result polling, interruption, and recovery. Blob metadata and bytes are removed together only after no retained state or event references them.

Apply retention per deployment and tenant, but preserve ownership and foreign-key relationships. Optional RLS must also protect cleanup queries. Record policy changes as migrations and state exactly which replay, deduplication, restore, or audit guarantees become weaker.
