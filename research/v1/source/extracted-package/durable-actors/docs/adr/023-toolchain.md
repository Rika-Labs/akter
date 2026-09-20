# ADR 023: Strict compatible native toolchain

Date: 2026-09-17  
Status: Conditional on validation

## Context
Effect diagnostics/native TypeScript and Oxlint companions have a compatibility matrix. Installing unrelated latest releases can silently disable intended checks.

## Decision
Pin a documented supported tuple, inventory all Effect rules as errors and verify an intentional diagnostic sentinel. Keep standard lint and Effect diagnostics explicit.

## Alternatives considered
A guessed effecttsgo plugin config or wildcard is not acceptable evidence. Duplicate lint modes add noise without more safety.

## Consequences and risks
Toolchain setup may block if a patch/mode is unsupported; report it rather than silently weakening checks.

## Validation and revisit trigger
G01; update only with a new support matrix and CI proof.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md)
- [Effect Oxlint integration guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config)
- [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config)
