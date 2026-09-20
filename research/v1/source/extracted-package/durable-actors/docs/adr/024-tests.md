# ADR 024: Vitest/Effect plus Bun conformance lane

Date: 2026-09-17  
Status: Accepted

## Context
Effect provides testing helpers tied to a Vitest major. Bun native tests are useful but not API-compatible replacements for those helpers.

## Decision
Use matched @effect/vitest/Vitest for semantic suites and native Bun tests for runtime-specific behavior; emitted package probes run on Node too.

## Alternatives considered
Bun-only tests would require rebuilding Effect test helpers; Node-only tests do not validate the promised Bun production path.

## Consequences and risks
Maintain shared conformance scenarios so the two runtimes test the same invariants without duplicated assertions drifting.

## Validation and revisit trigger
Revisit only when official runner support changes and equivalent conformance remains.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect Vitest package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json)
- [Bun testing](https://bun.com/docs/test)
- [Vitest documentation](https://vitest.dev/guide/)
