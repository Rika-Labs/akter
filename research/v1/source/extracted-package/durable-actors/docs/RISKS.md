# Risk register

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Risk | Severity | Mitigation / stop condition |
|---|---|---|
| Cross-store lost work | Critical | Receipt/outbox bridge proof before ergonomic API work |
| Stale owner writes | Critical | Sink-side fence conformance; reject provider/config that cannot support it |
| Untrusted code cross-tenant access | Critical | Isolated pilot deployments; no broad shared-code cloud launch |
| libSQL/new Turso mismatch | High | Exact engine/driver capability contract and remote acceptance suite |
| Effect RC churn | High | Pinned tuples, source review, grouped upgrades and narrow adapters |
| Railway runner addressing | High | Explicit per-runner endpoints; scale-out gate |
| Projection scope explosion | High | Single source/sink beta; defer arbitrary joins/materialized actors |
| Write amplification destroys margin | High | Meter actual rows/bytes/retries, negotiate only on evidence |
| Per-actor DB count/provisioning cost | High | Provider agreement; encourage sensible aggregate granularity |
| Schema evolution failures | High | Compatibility versions, staged migrations, restore exercises |
| Outbox discovery misses sleepers | High | Durable relay registration before source retirement; reconciliation tests |
| Local tests hide remote behavior | High | Real driver/provider matrix |
| Toolchain diagnostics silently disabled | Medium/high | Rule inventory and failing sentinel validation |
| Duplicate implementation layers | Medium | Package boundaries, avoid new ORM/Workflow/EventBus by accident |
| Founder scope drift | High | Actor-first product gates; agent/specializations deferred |
| Vendor concentration | Medium/high | Export/import rehearsals, standard SQL subset, documented replacement costs |

## Review rhythm

Review critical/high risks at every milestone. A failed correctness gate pauses feature expansion. Track the owner, evidence, next experiment and revisit date in the implementation backlog. Do not downgrade risk because the same architecture was enthusiastically repeated in earlier discussion.

## Explicit uncertainty

The source review supports the component choices and identifies likely boundaries. It does not prove the combined distributed system correct, benchmark it, negotiate provider capacity or establish commercial demand. Those are the next experiments.

## Sources and evidence

- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [T02: Turso pricing](https://turso.tech/pricing.md) — Observed plan labels Free/Developer/Scaler/Pro/Enterprise, monthly $0/$5.99/$29/$499/custom; rates and limits must be timestamped.
- [D02: Railway private networking](https://docs.railway.com/guides/private-networking) — Must validate per-replica identity/routing, not use one load-balanced address as runner identity.
