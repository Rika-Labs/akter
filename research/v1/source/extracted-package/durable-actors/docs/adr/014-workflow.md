# ADR 014: Evaluate Effect Workflow bridge

Date: 2026-09-17  
Status: Conditional

## Context
Slow external work needs named durable progression and uncertain-outcome handling, not a long actor database transaction.

## Decision
Use Workflow/Activity if a stable actor-intent/start/completion bridge fits its documented semantics. Persist protocol routes, not callbacks.

## Alternatives considered
A custom workflow engine duplicates substantial complexity. Plain forks cannot survive process loss.

## Consequences and risks
Only completed activity outcomes are memoized; bodies can replay after suspension. Provider idempotency stays explicit.

## Validation and revisit trigger
G10; keep the public abstraction small until the prototype proves replay and code-version behavior.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts)
