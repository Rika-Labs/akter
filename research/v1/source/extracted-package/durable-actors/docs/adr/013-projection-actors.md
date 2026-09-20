# ADR 013: Defer automatic materialized actor views

Date: 2026-09-17  
Status: Deferred

## Context
Named read actors with custom indexes are appealing, but add another copy, consistency lag and rebuild/router state.

## Decision
Document a later single-source projection-actor package. Do not make it required for ordinary global queries or V1.

## Alternatives considered
Direct indexed PostgreSQL reads are simpler. A cached API can serve many workloads without another actor database.

## Consequences and risks
The source stream may fan out directly to actor views; PostgreSQL need not be a mandatory intermediate. Derived tables must not create projection loops.

## Validation and revisit trigger
Adopt after a measured hot-view requirement and G07; benchmark cold/hot reads and total update cost.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Electric Shapes](https://electric-sql.com/docs/guides/shapes)
- [PowerSync architecture](https://docs.powersync.com/architecture/overview)
- [Materialize documentation](https://materialize.com/docs/)
