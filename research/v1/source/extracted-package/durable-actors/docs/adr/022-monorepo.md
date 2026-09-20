# ADR 022: Package monorepo with mirrored tests

Date: 2026-09-17  
Status: Accepted

## Context
The actor core, provider adapters, transports and deployment entries have different dependency/lifecycle boundaries.

## Decision
Use Bun workspaces, explicit packages and mirrored test paths; Turbo schedules tasks. Keep public APIs separate from implementation and vendor wiring.

## Alternatives considered
A single large package hides boundaries; dozens of tiny packages create release overhead without value.

## Consequences and risks
Scaffold checks enforce graph/export rules. Packages stay private until release gates pass.

## Validation and revisit trigger
Split/merge packages only for demonstrated dependency/deployment ownership, not feature taxonomy.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Bun workspaces/catalogs](https://bun.com/docs/pm/catalogs)
- [Turborepo configuration](https://turborepo.com/docs/reference/configuration)
- [OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md)
