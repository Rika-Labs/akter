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
