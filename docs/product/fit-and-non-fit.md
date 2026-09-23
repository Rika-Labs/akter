# Product fit and non-fit

**Responsibility:** prevent inappropriate adoption and architecture drift.  
**Authority:** product boundary.  
**Owner role:** product/architecture.
**Change policy:** a change requires product sign-off.

## Strong fit

Durable Actors fits when the domain has many addressable things whose mutations should serialize and whose behavior combines relational data with one or more of:

- durable commands and retry-safe receipts;
- realtime connections and cursor-based events;
- timers or recurring commands;
- external effects that need retry and dead-letter recovery;
- finite workflows owned by the same identity;
- tenant-aware placement and caller attribution.

Typical identities include users, workspaces, rooms, documents, devices, agents, orders, subscriptions, and control-plane resources.

## Conditional fit

- Read-heavy systems fit when writes have clear actor ownership and SQL serves cross-actor reads.
- Transient coordination fits with activation-local values when forgetting state after hibernation is acceptable.
- Batch work fits when it belongs to an actor effect or workflow; independent bulk computation may need a separate compute system.
- High throughput fits when it partitions across many actor identities rather than concentrating on one hot identity.

## Poor fit

- one globally hot mutable object that must scale linearly across workers;
- workloads dominated by atomic mutation across many unrelated actors;
- analytics systems whose core operation is broad scans rather than identity-local behavior;
- hostile or untrusted code execution;
- applications unwilling to operate or consume Postgres-compatible storage;
- systems that require exactly-once external outcomes from providers with no idempotency or reconciliation;
- teams primarily seeking a mature standalone workflow ecosystem rather than an actor framework.

The framework should reject architecture drift: no separate public primitive for background tasks, no broker subsystem without a real consumer and retention model, and no AI-specific layer. See [boundaries](../vision/08-boundaries.md) and [competitive positioning](competitive-positioning.md).
