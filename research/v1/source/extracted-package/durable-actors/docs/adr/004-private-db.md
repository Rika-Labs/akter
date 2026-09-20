# ADR 004: Private relational database per actor

Date: 2026-09-17  
Status: Accepted product direction; economics conditional

## Context
The product wants actor-local tables/indexes and independent relational schema ownership, similar in developer model to DO/Rivet.

## Decision
Give each actor incarnation a private supported relational DB; retain the freedom to group multiple domain rows in one actor aggregate.

## Alternatives considered
Shared PostgreSQL is simpler for global joins and fewer databases. Per-table/per-schema Postgres adds different isolation/metadata tradeoffs. A custom SQLite storage engine is rejected.

## Consequences and risks
Database fleet provisioning, migrations, quotas and cross-actor queries become significant responsibilities. Remote DB access is not local-memory latency.

## Validation and revisit trigger
Revisit granularity/provider if database-count or write economics fail representative workloads. Do not promise a transparent dialect switch.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [libSQL versus Turso Database](https://docs.turso.tech/libsql)
- [Turso pricing](https://turso.tech/pricing.md)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
