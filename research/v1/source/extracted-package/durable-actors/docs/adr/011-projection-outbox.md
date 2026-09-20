# ADR 011: Automatic row projections via outbox

Date: 2026-09-17  
Status: Conditional beta

## Context
Users want global SQL reads without manually emitting row-change events. Source DB writes must not be separated from capture.

## Decision
Prototype generated row triggers and a local change log; relay to one PostgreSQL sink with transactional sink receipts/checkpoints.

## Alternatives considered
Interception misses raw SQL; WAL CDC is provider-specific; complete sync engines have different authority assumptions.

## Consequences and risks
We own snapshot/watermark/replay, deletes, migrations, backpressure and sink security. This is not a free feature of Effect Stream.

## Validation and revisit trigger
G07. Defer arbitrary multi-source queries or inverse sync until single-source correctness is proven.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [SQLite triggers](https://www.sqlite.org/lang_createtrigger.html)
- [Electric Shapes](https://electric-sql.com/docs/guides/shapes)
- [PowerSync architecture](https://docs.powersync.com/architecture/overview)
- [Debezium outbox routing](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
