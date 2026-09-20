# Fault injection plan

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Principle

Every durability claim has a crash boundary and an independent invariant oracle. Tests use stable identifiers and record a trace that can be replayed. The first cloud gate is correctness under a small number of real machines and failures, not a large throughput number.

| ID | Injection | Required invariant |
|---|---|---|
| F01 | Kill before local commit | No partial application mutation |
| F02 | Kill after local commit before PG reply | Original receipt recovered, mutation not repeated |
| F03 | Lose DB commit response | Retry resolves actual outcome from receipt |
| F04 | Pause owner A, install owner B, resume A | A cannot commit after B's fence handoff |
| F05 | Break reserved PostgreSQL connection | Session locks/reconnect behavior matches ownership contract |
| F06 | Duplicate outgoing intent delivery | Destination applies stable ID at most once within retention contract |
| F07 | Provider succeeds, response lost | Unknown/reconcile state, not blind unsafe replay |
| F08 | Sink offline beyond retry window | Bounded backlog, visible status, no silent drop |
| F09 | Reorder projection events | Checkpoint/tombstone invariants hold |
| F10 | Move projection key under duplicate replay | No permanent stale old membership or lost new row |
| F11 | Crash snapshot/backfill | Resume correct generation/watermark |
| F12 | Upgrade actor code with old messages pending | Decode/migrate or reject visibly, no corrupt state |
| F13 | Delete/restore actor with delayed messages | Incarnation protection prevents unintended resurrection |
| F14 | SSE disconnect during commit notification | Replay fills gap, duplicate IDs tolerated |
| F15 | Blow past per-tenant creation/fanout limit | Admission control protects other tenants |
| F16 | Interrupt blob upload/reference commit | Orphan retained safely then cleaned; no committed missing object |

## Environment

Start with two runners, one gateway, a local PostgreSQL instance and a remote test libSQL endpoint. Use distinct actor applications and disposable credentials. Network proxy fault injection is useful but cannot perfectly emulate every provider failure; also exercise real restart/failover where safe in a test account.

## Report

Each run stores versions, seed, injected failpoint, command/event IDs, provider responses with secrets removed, timing, durable DB assertions and recovery outcome. A flaky invariant test blocks release until understood. Do not hide it behind automatic CI retries.

## Safety

Never point chaos scripts at production by default. Require an explicit test environment identifier, resource allowlist and destructive-test flag. The setup skeleton supplies scenario definitions only and provisions nothing.

## Sources and evidence

- [E03: SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) — Reserved/rebuildable PostgreSQL connection and advisory lock behavior; assess current hardening, not an old issue headline.
- [E04: Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts) — Shard-wide recovery queries, deduplication, replies and transaction wrapper; no cross-database transaction guarantee.
- [E05: Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts) — Activity requires WorkflowEngine/WorkflowInstance. Only completed activity results memoized; replay can repeat external effects.
- [Q02: SQLite transaction model](https://www.sqlite.org/lang_transaction.html) — Write transaction and locking semantics; supports analysis of local receipts/fence checks.
