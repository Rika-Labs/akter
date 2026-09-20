# ADR 029: Actors first, agents and specializations later

Date: 2026-09-17  
Status: Accepted

## Context
The conversation expanded from agents to a broad platform. Equal investment in actor framework, agent framework and managed cloud would dilute execution.

## Decision
Implement the minimal correct actor runtime and one real application first. Defer agents, general queues and materialized multi-source actors.

## Alternatives considered
Building every appealing abstraction now maximizes integration complexity before user value is proven.

## Consequences and risks
The monorepo preserves extension boundaries without creating fake implementations/packages for every future capability.

## Validation and revisit trigger
Revisit after real applications demonstrate repeated needs and core failure gates pass.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Rivet actor documentation](https://rivet.dev/docs/actors)
- [Effect Agent](https://effect-agent.com/)
- [Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts)
