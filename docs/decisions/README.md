# Architecture decisions

**Responsibility:** index the architecture decisions and their recorded rationale.  
**Authority:** historical decision record.  
**Owner role:** architecture.
**Change policy:** supersede via a new ADR; do not edit accepted ADRs in place.

Use an ADR when a choice changes an interface, invariant, data model, deployment guarantee, or supported workload. An ADR must state context, decision, alternatives, consequences, evidence, and revisit conditions.

Decisions do not override newer accepted requirements. When a decision is superseded, preserve it and link the replacement.

- [ADR 0001: Repository structure](0001-repository-structure.md) defines the one-package framework and role-folder layout.
- [ADR 0002: Clarify the adopted v4 contracts](0002-v4-contract-clarifications.md) reconciles the final API, transaction, and capability decisions without claiming runtime implementation.
