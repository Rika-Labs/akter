# Retention policy

**Responsibility:** connect cleanup to correctness.  
**Authority:** operational contract.  
**Owner role:** operations/reliability.
**Change policy:** a change requires operator review when a procedure or limit changes.

Retention policies cover command receipts, processed messages, events, workflow executions and activities, effects and dead letters, timers, connection metadata, blobs, and audit records.

External command retry and receipt-retention horizons are finite and configurable. An expired command identity is rejected on external delivery; it never becomes new because its receipt is absent. Cleanup must not remove a replayable outcome during its supported retry window or remove deduplication evidence while accepted work can still be internally redelivered. Pending recovery obligations may therefore outlive the external retry window.

Before enabling cleanup, specify and prove the expiry mechanism: how age/expiry is bound to command identity, how clock skew and exact boundaries are handled, and why an old id cannot become admissible after pruning, restart, policy changes, rolling upgrades, or supported restore. Deleting rows alone is insufficient. Race cleanup against retries and internal redelivery; interruption must not leave a gap that permits duplicate execution. [ADR 0007](../decisions/0007-foundation-command-protocol.md) binds expiry to the command id, and [ADR 0038](../decisions/0038-retention-cleanup-and-receipt-horizon.md) specifies the cleanup that relies on it.

Never delete an `actor_outbox` row before the receiver's receipt for its intent id commits. Keep effect identity and provider idempotency evidence through the longest retry, backup rollback, and reconciliation window. Command expiry neither proves that an external effect failed nor authorizes a new-id retry.

Event retention must cover every supported replay cursor and workflow `waitFor` dependency. Subscriptions hold a source's events above their lowest settled cursor for at most `policy.holdEventsForSubscribers` (default 7 days) past `keepEvents`; beyond that the events are pruned and a dynamic or singleton-routed subscriber receives a `RetentionGap` delivery, while an id-routed subscription records and counts the gap ([ADR 0026](../decisions/0026-cross-actor-event-subscriptions.md)). Event pruning deletes only an actor's oldest events, never a middle range, and never resets `actor_generations.event_sequence`. Replay reports a pruned range after a cursor as `RetentionGap`. Workflow history must outlive result polling, interruption, and recovery. Per [ADR 0022](../decisions/0022-workflow-engine-storage-and-version-markers.md): an open execution keeps all its steps; a finished execution keeps only its result for `policy.keepWorkflows` (default 7 days, never below the retry window); event pruning keeps every owner event above the smaller of the owner's open executions' `event_cursor` and their pending waits' `wait_after`, for actor types with a registered `Ship.wait` step; workflow resume turns write ordinary receipts pruned after the retry window; and a workflow activity's actor calls keep the expiry of the attempt that issued them, so keep the retry window minus each workflow actor's `deliveryTimeout` above the 30-second workflow recovery interval: at or below it, an activity whose runner dies fails with `ActivityOutcomeUnknown` instead of rerunning its calls, and startup logs a warning ([ADR 0046](../decisions/0046-workflow-engine-suite-drivers.md), proposed); manifests are kept while an open execution references them. Blob metadata and bytes are removed together only after no retained state or event references them.

Apply retention per deployment and tenant, but preserve ownership and foreign-key relationships. Optional RLS must also protect cleanup queries. Record policy changes as migrations and state exactly which replay, deduplication, restore, or audit guarantees become weaker.

## What the runtime prunes

Every runtime sweeps once a minute, per registered actor type and across every tenant, in batches of 1,000 rows that each commit on their own.

| Record                                | Policy         | Default | Pruned when                                                                                                                             | Kept regardless                                 |
| ------------------------------------- | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Receipts                              | `keepReceipts` | 7 days  | `keepReceipts` has passed since the id was issued (a timer's since its due time), and `deliveryTimeout` has passed since the id expired | while an `actor_outbox` row carries the id      |
| Events                                | `keepEvents`   | 30 days | `keepEvents` has passed since the event was emitted; each actor loses only a prefix of its stream                                       | `event_sequence`, so cursors are never reissued |
| Dead letters                          | none           | kept    | never automatically                                                                                                                     | —                                               |
| Outbox rows, state, owned rows, blobs | none           | kept    | only by the actor's own turns or the relay                                                                                              | —                                               |

An interrupted sweep leaves whole batches and resumes on the next one. A replay whose cursor precedes pruned events fails `RetentionGap`, and the reader resynchronizes from state and `read.cursor`. Lowering a horizon takes effect at the next sweep and removes history that readers may still hold cursors into; raising it cannot bring pruned rows back. Every process uses its own policy values, so during a rolling deploy that lowers `keepReceipts`, a new process can prune a receipt that an old process's in-flight turn still counts on; lower it in two steps, or while no retries of old ids are in flight. Version-skew support is an M4 item. Blob quotas and emit budgets bound what a single actor stores, not how long it keeps it.

Restore of a whole-database snapshot, including across pruned history, follows [backup and restore](04-backup-restore.md). Per-tenant horizons and automatic dead-letter retention are not implemented.

## Content sweep

Target, built by M4.13 ([ADR 0034](../decisions/0034-tenant-scoped-content-addressed-blobs.md)). A per-tenant sweep, at most hourly under an advisory lock, deletes content no actor references once its last grant is older than the grace (24 hours) plus the longest `commandTimeout` of an actor type that declares content, plus the clock-skew bound. An upload that is never attached lives about 25 hours with the defaults. The sweep is operator-tier maintenance and never runs on a turn path.
