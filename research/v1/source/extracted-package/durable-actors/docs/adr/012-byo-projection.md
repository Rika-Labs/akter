# ADR 012: Customer-owned projection database

Date: 2026-09-17  
Status: Accepted

## Context
Different platform customers have different schemas and operational requirements. Shared universal application projection tables create unsafe coupling.

## Decision
The default cloud hosts actor execution/private DBs and projection delivery; each application supplies its query sink. Keep control metadata separate.

## Alternatives considered
Managed per-customer projection DB could be a future product; a single universal schema is rejected for arbitrary customer applications.

## Consequences and risks
Sink availability/credentials/DDL are an external dependency. Backlog and schema failures must be visible and bounded.

## Validation and revisit trigger
Revisit managed sinks only after customers request them and isolation/cost/migration ownership is designed.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Debezium outbox routing](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer)
