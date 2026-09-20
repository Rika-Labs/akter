# ADR 016: HTTP and CLI are adapters

Date: 2026-09-17  
Status: Accepted

## Context
Domain logic must be callable from HTTP, CLI, another actor or future agent without importing persistence internals.

## Decision
Use Effect HttpApi and CLI for transport; actors return typed domain outcomes; transport maps status/output semantics.

## Alternatives considered
Route-first domain logic duplicates behavior across interfaces. Making every endpoint an actor adds unnecessary lifecycle overhead.

## Consequences and risks
Authentication, deadlines, accepted-work receipts and reconnect semantics remain transport concerns.

## Validation and revisit trigger
Review generated client/OpenAPI and Node/Bun transport tests as public APIs stabilize.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
