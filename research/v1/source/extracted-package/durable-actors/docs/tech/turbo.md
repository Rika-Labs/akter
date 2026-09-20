# Turborepo — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Workspace task graph and cache.

## Alternatives
Bun workspace scripts alone, Nx, bespoke task orchestration. Turbo chosen for minimal cached graph.

## Selection rationale
Fits package builds/tests without defining the actor architecture.

## Maturity
Use supported configuration for pinned version.

## Performance
Cache benefits depend on correct outputs/input/env declarations.

## Developer experience
Simple root commands and explicit per-package scripts.

## Effect integration
No semantic Effect role; it orchestrates tooling.

## Bun integration
Bun workspaces/lock inputs participate in task hashing.

## Node compatibility
Node tools and runtime probes are ordinary tasks.

## CI behavior
Cache only deterministic build/test artifacts; not provider-dependent integration results as proof.

## Local behavior
Persistent dev tasks are not cached; docs portal separate from runtime.

## Production behavior
Not a production runtime dependency.

## Maintenance risk
Incorrect dependency/env graph can return stale outputs.

## Licensing
Check selected package licensing; no code reimplementation required.

## Pricing
CI cache service/storage fees, if enabled, are separately measured.

## Lock-in
Scripts remain ordinary commands so task runner can be replaced.

## Migration path
Keep package scripts as canonical units and regenerate orchestration.

## Known issues / uncertainties
A task graph is not a Layer or package-dependency correctness proof.

## Operational burden
Document outputs, cache inputs, environment allowlists and sensitive data exclusions.

## Security implications
Never upload credentials/provider response payloads to shared caches.

## Sources
- [Turborepo configuration](https://turborepo.com/docs/reference/configuration)
- [Bun workspaces/catalogs](https://bun.com/docs/pm/catalogs)
