# Activation and logical lifetime

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Logical identity is independent from a running activation. A descriptor/reference does not necessarily create a database. First durable work may trigger provisioning. A volatile query for an unknown actor should have a specified NotFound behavior rather than silently creating expensive resources.

## State machine

```
unprovisioned -> provisioning -> migrating -> activating -> ready
ready -> idle -> passivating -> dormant -> activating
ready -> draining -> suspended
any -> deleting -> tombstoned
```

Failures retain diagnosable status and retry policy. Distinguish transport unavailable, schema incompatible, provisioning quota exceeded and application rejection. Avoid a single `ActorError` string with no recovery action.

## Scope ownership

Runner process Scope owns transports, pools and exporters. Activation Scope owns actor-specific clients and disposable resources. A turn owns its database transaction and staged intents. An external activity owns its own lifecycle. Closing an activation Scope must not cancel already accepted logical work merely because no JS function remains alive.

## Passivation

Passivate only when no mutable turn is committing and recoverable outstanding intentions have durable discovery records. Dispose DB client handles, subscriptions and caches. A sleeping actor may still have scheduled work and an actor DB, but no dedicated fiber is required. Long-lived gateway clients subscribe to a logical event feed; do not keep the actor warm solely because a socket exists unless the application chooses that policy.

## Code deployment

Drain old runner activations or keep code-version routing until in-flight protocols and workflow completions are compatible. Never route two code versions to one actor DB as simultaneous writers. A new schema version may require old code exclusion even if its messages still decode.

## Resource actors

A logical browser/shell/sandbox owner may survive while the underlying process disappears. Persist reconstructable metadata or an external service session ID. Scope finalizers are best-effort on graceful exit; crash recovery must not depend on them running. Leaked external resources require TTL/reconciliation.

## Deletion

Delete is not passivation. Preserve a tombstone/incarnation policy, revoke access, cancel supported scheduled actions, and emit projection cleanup before deleting authoritative data. Define how outstanding work and external resources are reconciled. Audit destructive operations and protect against delayed messages recreating deleted actors unintentionally.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [T04: Turso Platform API](https://docs.turso.tech/api-reference/introduction) — Provisioning/control API is separate from SQL data-plane client.
