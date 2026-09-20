# ADR 019: Memory first, shared Valkey only when useful

Date: 2026-09-17  
Status: Accepted

## Context
A correct actor runtime does not require Redis for every entity. Shared cache adds infrastructure and invalidation costs.

## Decision
Use bounded activation-local Effect cache first. Add shared Valkey behind Cache semantics when a benchmark justifies cross-activation reuse.

## Alternatives considered
One Redis per actor is rejected. Unrestricted Redis commands or using cache as durable authority is rejected.

## Consequences and risks
Cache loss/staleness must not alter business correctness; track fill/eviction and stampede behavior.

## Validation and revisit trigger
Revisit after measured source load/reuse, not before a working actor exists.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Valkey](https://valkey.io/)
- [Redis docs](https://redis.io/docs/latest/)
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
