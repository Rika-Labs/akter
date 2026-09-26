# Retention policy

**Responsibility:** connect cleanup to correctness.  
**Authority:** operational contract.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

Retention policies cover command receipts, processed messages, events, workflow executions and activities, effects and dead letters, timers, connection metadata, blobs, and audit records.

External command retry and receipt-retention horizons are finite and configurable. An expired command identity is rejected on external delivery; it never becomes new because its receipt is absent. Cleanup must not remove a replayable outcome during its supported retry window or remove deduplication evidence while accepted work can still be internally redelivered. Pending recovery obligations may therefore outlive the external retry window.

Before enabling cleanup, specify and prove the expiry mechanism: how age/expiry is bound to command identity, how clock skew and exact boundaries are handled, and why an old id cannot become admissible after pruning, restart, policy changes, rolling upgrades, or supported restore. Deleting rows alone is insufficient. Race cleanup against retries and internal redelivery; interruption must not leave a gap that permits duplicate execution. No numeric defaults or concrete identity format are selected yet; see [ADR 0004](../decisions/0004-receipt-access-revocation-and-expiry.md).

Never delete an `actor_outbox` row before the receiver's receipt for its intent id commits. Keep effect identity and provider idempotency evidence through the longest retry, backup rollback, and reconciliation window. Command expiry neither proves that an external effect failed nor authorizes a new-id retry.

Event retention must cover every supported replay cursor and workflow `waitFor` dependency. Subscriptions hold a source's events above their lowest settled cursor for at most `policy.holdEventsForSubscribers` (default 7 days) past `keepEvents`; beyond that the events are pruned and a dynamic or singleton-routed subscriber receives a `RetentionGap` delivery, while an id-routed subscription records and counts the gap ([ADR 0026](../decisions/0026-cross-actor-event-subscriptions.md)). Event pruning deletes only an actor's oldest events, never a middle range, and never resets `actor_generations.event_sequence`. Replay reports a pruned range after a cursor as `RetentionGap`. Workflow history must outlive result polling, interruption, and recovery. Per [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md): an open execution keeps all its steps; a finished execution keeps only its result for `policy.keepWorkflows` (default 7 days, never below the retry window); event pruning keeps every owner event above the smaller of the owner's open executions' `event_cursor` and their pending waits' `wait_after`, for actor types with a registered `Ship.wait` step; workflow resume turns write ordinary receipts pruned after the retry window; manifests are kept while an open execution references them. Blob metadata and bytes are removed together only after no retained state or event references them.

Apply retention per deployment and tenant, but preserve ownership and foreign-key relationships. Optional RLS must also protect cleanup queries. Record policy changes as migrations and state exactly which replay, deduplication, restore, or audit guarantees become weaker.
