# ADR 010: Serialized short mutation turns

Date: 2026-09-17  
Status: Accepted

## Context
Actors need understandable state ownership and responsiveness to new commands while slow external work runs.

## Decision
Serialize local mutating turns. Stage external/peer work and resume through messages. Bounded authoritative reads outside a write transaction can be allowed explicitly.

## Alternatives considered
Fully concurrent handlers require per-domain locking/revision discipline; holding transactions through remote calls risks deadlocks and starvation.

## Consequences and risks
One actor is a throughput ceiling. Domain granularity and partitions must follow invariant boundaries.

## Validation and revisit trigger
Allow alternative read scheduling only with a precise consistency contract and tests; do not make global concurrency a casual option.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts)
- [Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts)
