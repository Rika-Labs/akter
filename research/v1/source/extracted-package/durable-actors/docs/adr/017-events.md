# ADR 017: Retained events distinct from broadcast

Date: 2026-09-17  
Status: Accepted

## Context
PubSub/live sockets cannot recover missed events after a process failure. EventLog naming alone does not prove actor-local transactional append.

## Decision
Store important events in the local commit and expose cursor replay; use live notification as an optimization. Evaluate EventLog before adoption.

## Alternatives considered
Live-only feeds are fine for presence but insufficient for durable task history. Full event sourcing is not required for every actor.

## Consequences and risks
Retention, snapshot cursor, incarnation, slow consumers and redaction are part of the API contract.

## Validation and revisit trigger
Adopt an upstream journal only if its transaction/replay behavior matches our source-of-truth model.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect EventLog](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/eventlog/EventLog.ts)
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
