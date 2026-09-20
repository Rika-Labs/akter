# Initial operational runbooks

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Actor command stuck

Look up submission ID and actor incarnation. Distinguish pending delivery, provisioning/migration blocked, local receipt committed, relay blocked and external work unknown. Check oldest pending age and current fence. Do not replay with a new command ID. Repair the failed delivery or return the retained receipt.

## Stale owner rejection

Treat expected fence rejection during handoff as a controlled cancellation. Unexpected repeated rejection means routing/ownership disagreement. Capture runner IDs, epochs, DB incarnation and timing. Stop new writes if the invariant cannot be explained. Never clear ownership tables blindly to make a request pass.

## Projection sink outage

Inspect per-sink backlog, last contiguous checkpoint, schema generation and credential status. Retry same event IDs. Alert before quota limits. Pause or reject affected writes according to the documented backlog policy. A resnapshot requires a new generation/watermark, not setting checkpoint to the newest sequence.

## Unknown external effect

Stop automatic unsafe retries. Retrieve provider status using the original idempotency key/external operation ID. Record confirmed success/failure or require a domain/operator decision. Compensation is a new tracked operation. Do not mark a payment failed merely because an Effect was interrupted.

## Database migration failure

Keep the actor unavailable for incompatible commands. Inspect checksum/version and partial external backfill status. Transactional DDL may roll back, but verify actual provider behavior. Never edit a previously applied migration. Deploy a compatible corrective migration or restore under an incarnation-safe procedure.

## Credential compromise

Suspend affected actor/application grants, revoke provider tokens and projection egress, rotate secret versions and audit access. Preserve command metadata without exposing secret values. Determine which accepted work is blocked and notify the application operator.

## Restore

Freeze affected application writes; identify source snapshots/control metadata and external-effect boundary; restore to a new incarnation; reconcile receipts/outboxes/projection generations; reissue credentials; run invariants before reopening. A database restore is not a rollback of already performed external actions.

These are initial playbooks. Before paid hosting, execute staging game days and attach actual commands/screenshots/log references to each step. The skeleton has no operational backend to run them against yet.

## Sources and evidence

- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [T03: Turso JavaScript SDK](https://docs.turso.tech/sdk/ts/reference) — Inspect transactions, client disposal, protocol, and limitations for selected endpoint.
