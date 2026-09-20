# ADR 001: Effect v4 as foundation

Date: 2026-09-17  
Status: Accepted preference; release tuple conditional

## Context
The framework needs typed behavior, schemas, resource scopes and compatible transport/SQL primitives. Effect v4 consolidates many relevant modules, but the selected APIs remain a moving prerelease surface.

## Decision
Use Effect v4 directly, pin the tested ecosystem tuple, and keep unstable integration inside explicit package boundaries. Import Effect primitives from Effect rather than reexporting the library.

## Alternatives considered
Effect v3 reduces migration novelty but diverges from the chosen APIs; Promise-first libraries create a parallel runtime; a new effect system is out of scope.

## Consequences and risks
Upgrades require source/type/runtime review. A package compiling against another RC is not sufficient evidence for persistence behavior.

## Validation and revisit trigger
Revisit if required v4 contracts cannot be stabilized behind a small adapter or release churn dominates progress. Gate G01 and runtime conformance apply.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json)
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
