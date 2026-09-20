# ADR 003: Effect Cluster instead of a new cluster

Date: 2026-09-17  
Status: Conditional

## Context
Routing, virtual identity, passivation and persistent message machinery already exist. Building their distributed coordination from scratch would consume the project.

## Decision
Use Entity/RPC and SQL message/runner storage as substrate, explicitly mark durable commands persisted, and add our actor-local commit/fence/receipt semantics.

## Alternatives considered
Direct Rivet/DO use avoids a runtime project but changes the product. A custom cluster maximizes control at much higher correctness/operations cost.

## Consequences and risks
Current source behavior and hosting topology constrain us. Cluster ownership is not a substitute for storage-side fencing.

## Validation and revisit trigger
G03/G04/G06 must pass. Revisit only a concrete unsupported behavior or measured limit, not hypothetical future scale.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts)
- [SQL runner ownership](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts)
- [Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts)
