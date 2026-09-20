# Engineering principles

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

1. **Correctness before convenience.** An API may hide retry plumbing but must not hide whether a command is accepted, committed, externally executed, or merely projected.
2. **One actor is an ownership boundary, not necessarily one row.** Keep invariants and frequently transactional data together. Avoid one database per trivial row unless workload economics justify it.
3. **Definition, implementation, execution are separate.** Protocol/Schema values describe; Layers construct; Effects execute. Piping is an affordance, not a requirement to encode every option as a combinator.
4. **Build on Effect without confusing its guarantees.** Scope is resource lifetime, not persistence. Stream is computation, not a durable log. Schedule is a policy value, not a persisted timer. A driver transaction is limited to that database connection.
5. **Read facts at the right boundary.** Authoritative reads go to the actor's current primary-backed state; projections are explicitly eventual and may expose lag/watermarks.
6. **Make defaults opinionated.** Production standard: persistent commands, serialized mutations, short transactions, schema-versioned messages, bounded queues, explicit unsafe escape hatches. Adapters must preserve these contracts.
7. **No secret platform work at import time.** Database creation, migrations, clients, file access and subscriptions happen under acquired runtime scopes, not descriptor construction.
8. **Make operations inspectable.** Every accepted command needs a durable ID and retrievable outcome; every blocked job should have a reason and recovery action.
9. **Do not shift hidden costs onto customers.** Meter expensive writes, broadcasts, storage retention and reconnection replay. Idle compute may be released; storage and control-plane fleet costs remain.
10. **A scaffold is not an implementation.** Passing its typecheck/import tests proves only its setup. Production claims require failure evidence.

## Standard escape-hatch policy

Expose raw Effect SQL within actor storage, but reserve internal tables and prohibit transaction control that bypasses the turn. Custom schemas, repositories and capabilities are welcome. Changing the durability contract, using stale read replicas for authoritative decisions, or sending external actions before commit is unsupported in the standard runtime. Such code belongs behind an explicitly unsafe/advanced boundary and cannot retain the same guarantee label.

## Sources and evidence

- [E02: Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts) — Messages are volatile unless persisted annotation is set; sequential handlers by default; activation-local Ref; maxIdleTime; typed clients.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [E09: Effect SQL client](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/sql/SqlClient.ts) — Transaction and reserved-connection API reference; bind each database role independently.
