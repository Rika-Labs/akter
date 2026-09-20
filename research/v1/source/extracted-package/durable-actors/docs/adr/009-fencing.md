# ADR 009: Storage-side ownership fence

Date: 2026-09-17  
Status: Required invariant

## Context
A paused runner can outlive a placement lease. A check in PostgreSQL before an unrelated actor DB mutation leaves a race.

## Decision
Install monotonic ownership at the actor DB and verify it under the same write transaction as application changes. Define handoff at the sink fence commit.

## Alternatives considered
Process-local mutex or lease timestamp alone cannot reject a stale remote writer. External API effects still require provider idempotency.

## Consequences and risks
The provider must expose sufficient conditional transaction behavior; application code must not bypass reserved runtime state.

## Validation and revisit trigger
G03; reject unsupported endpoint/configurations rather than weakening the guarantee label.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts)
- [SQLite transaction model](https://www.sqlite.org/lang_transaction.html)
