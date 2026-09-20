# ADR 008: Local receipts bridge cross-store commits

Date: 2026-09-17  
Status: Required invariant

## Context
Actor application writes live in libSQL while Cluster messages/replies live in PostgreSQL. There is no shared local transaction across them.

## Decision
Commit actor mutation, receipt and intentions locally; then register/dispatch recoverable delivery work and finish the control-store reply. Retries recover the stored outcome.

## Alternatives considered
Pretending Layer/SQL creates distributed atomicity is incorrect. Two-phase commit across these providers is not selected. Keeping all state in Postgres would avoid this split but changes the private DB model.

## Consequences and risks
Receipts, payload hashes, retention, discovery and relay state are mandatory. A green handler return is not the only durability evidence.

## Validation and revisit trigger
G04/G05; if the protocol cannot be proved with bounded complexity, reconsider the storage architecture before public API expansion.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts)
- [SQLite transaction model](https://www.sqlite.org/lang_transaction.html)
