# Retention policy

**Responsibility:** connect cleanup to correctness.  
**Authority:** operational contract.  
**Owner role:** operations/reliability.

Receipts, events, messages, workflow journals, activity attempts, provider keys, transfers, cursors, blob attestations, tombstones, and audit records have related retention horizons.

Pruning dedupe evidence while delivery can still retry is unsafe. Every retention change must state which retry, restore, replay, and reconciliation guarantees become weaker.
