# Architecture decisions

**Responsibility:** index the architecture decisions and their recorded rationale.  
**Authority:** historical decision record.  
**Owner role:** architecture.
**Change policy:** supersede via a new ADR; do not edit accepted ADRs in place.

Use an ADR when a choice changes an interface, invariant, data model, deployment guarantee, or supported workload. An ADR must state context, decision, alternatives, consequences, evidence, and revisit conditions.

Decisions do not override newer accepted requirements. When a decision is superseded, preserve it and link the replacement.

- [ADR 0001: Repository structure](0001-repository-structure.md) defines the one-package framework and role-folder layout.
- [ADR 0002: Clarify the adopted v4 contracts](0002-v4-contract-clarifications.md) reconciles the final API, transaction, and capability decisions without claiming runtime implementation.
- [ADR 0003: Failure rollback, automatic scoping, drain, and hosted trust](0003-failure-scoping-drain-and-hosted-trust.md) resolves the corresponding open decisions from ADR 0002 and requires context-scoped adapters, without claiming implementation or backend support.
- [ADR 0004: Receipt access, revocation, and command expiry](0004-receipt-access-revocation-and-expiry.md) restricts receipt access, preserves accepted work after revocation, and requires enforceable rejection of expired external command identities.
- [ADR 0005: Turn round trips, turn batches, and regional placement](0005-turn-latency-batching-and-regional-placement.md) limits a turn to two database round trips, lets waiting commands for one actor share a transaction, and places hosted tenants in home regions.
- [ADR 0006: Scale rules, placement keys, and query tiers](0006-scale-rules-placement-and-query-tiers.md) adds per-type placement keys and a framework routing key, enforces single-shard hot paths, defines local/group/fleet query tiers, and prohibits database-wide serialization points.
- [ADR 0007: Foundation command protocol](0007-foundation-command-protocol.md) specifies the first embedded Postgres identity, authorization, receipt, and transaction implementation and its unsupported boundaries.
- [ADR 0008: Foundation identity, policies, defects, and PGlite](0008-foundation-completion.md) completes M0 identity modes, lifecycle policies, creation gating, bounded turns, deterministic `onDefect` handling, System callers, and the shared PGlite/Postgres test boundary.
- [ADR 0009: Colocated tests and a separate browser project](0009-colocated-tests-and-browser-e2e.md) requires unit and integration tests beside matching source files and places browser E2E in its own workspace.
- [ADR 0010: One way to do everything: the Effect-native actor API](0010-one-way-effect-native-api.md) makes `Actor.make(name, definition)` the only actor shape, adds reducers, delivers context as typed per-phase services, removes layer options, and gives calls one form outside turns and intents one form inside.
- [ADR 0011: Direct commands, one outbox, and the performance architecture](0011-direct-commands-outbox-and-performance.md) makes commands direct with the receipt as their durable record, carries every intent and timer in one actor-shard outbox, pipelines turn batches, and records reducers, read-your-writes queries, compressed and cold state, single durability, operations, and simulation testing.
- [ADR 0012: Workflow storage, internal commands, effect routes, defects, merging, and home regions](0012-workflows-internals-effects-defects-merging-regions.md) adds a framework `WorkflowEngine` on the owner's shard, an `internal` definition section, declared `onSuccess`/`onDeadLetter` effect routes, telemetry-only defects, never-waiting commutative merges, and operator-assigned home regions.
