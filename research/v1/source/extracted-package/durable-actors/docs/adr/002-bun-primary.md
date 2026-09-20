# ADR 002: Bun primary with Node support

Date: 2026-09-17  
Status: Accepted

## Context
The user wants Bun developer/runtime ergonomics without excluding Node deployments. Bun has its own server, filesystem, SQLite and package toolchain APIs.

## Decision
Use Bun package management/scripts and primary runtime. Keep native APIs in platform-bun/tooling and provide platform-node with the same protocol behavior.

## Alternatives considered
Node-only loses the requested Bun focus. Bun-only core sacrifices portability and broad dependency testing. Supporting every JS host initially dilutes conformance effort.

## Consequences and risks
Two runtime lanes add CI and adapter maintenance. The primary @effect/vitest host must not be mislabeled as Bun execution.

## Validation and revisit trigger
Revisit platform optimizations only after a measured benefit and equivalent conformance test. A runtime-specific correctness failure blocks release.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [Bun testing](https://bun.com/docs/test)
- [Effect platform Bun](https://github.com/Effect-TS/effect/tree/main/packages/platform-bun)
