# ADR 007: PlanetScale control PostgreSQL

Date: 2026-09-17  
Status: Conditional

## Context
Cluster storage needs a compatible PostgreSQL control database. Session-sensitive runner locks require a different connection guarantee from transaction pooling.

## Decision
Pilot PlanetScale Postgres, using a direct/session-affine endpoint for RunnerStorage and separately named SQL services. Keep Neki out of V1.

## Alternatives considered
RDS/other managed PostgreSQL are compatibility fallbacks. Distributed SQL or Neki before a query/lock audit adds avoidable risk.

## Consequences and risks
Connection budgets, failover, private networking and regional latency are explicit acceptance work.

## Validation and revisit trigger
G06; reconsider provider if direct-session behavior, operational contract or cost is unsuitable.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer)
- [PlanetScale PostgreSQL pricing](https://planetscale.com/docs/postgres/pricing)
- [Neki preview](https://planetscale.com/changelog/neki)
- [SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts)
