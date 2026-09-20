# Effect v4 — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Typed execution, errors, schema, service construction, resources and streams.

## Alternatives
Effect v3; Promise-first frameworks; custom typed runtime. None better matches the chosen direction now.

## Selection rationale
Reuses coherent primitives instead of inventing actor-specific versions of every capability.

## Maturity
Inspected rc.115 source; treat unstable modules as explicit compatibility risk.

## Performance
Measure fiber/serialization/SQL overhead, but provider round trips likely matter more in many workloads.

## Developer experience
Typed requirements/errors help composition; excessive generics or hidden Layers can harm it.

## Effect integration
Direct native integration is the framework foundation.

## Bun integration
Use Bun platform adapter and version-matched packages.

## Node compatibility
Use Node platform adapter; keep public contracts runtime-neutral.

## CI behavior
Exact pins, strict diagnostics and grouped upgrades.

## Local behavior
TestClock, test Layers and in-memory fixtures help deterministic local work.

## Production behavior
Production adoption gated on the combined runtime, not the availability of Effect itself.

## Maintenance risk
RC changes across Cluster/Workflow/SQL/RPC can require coordinated refactors.

## Licensing
Effect source is MIT-licensed; validate notices/transitive packages in actual artifact.

## Pricing
Operational cost is compute/storage/integration work, not a hosted Effect license.

## Lock-in
Intentional programming-model commitment; reduce extra vendor coupling.

## Migration path
Changing away is a framework rewrite; stabilize public actor semantics before extra wrappers.

## Known issues / uncertainties
Scope/Stream/Tx primitives do not imply persistence; Layer.mergeAll is not automatic DI.

## Operational burden
Train contributors on lifetimes, errors, replay and typed protocol boundaries.

## Security implications
Types/services aid review but do not provide OS isolation or authorization.

## Sources
- [Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json)
- [Effect Cluster entity example](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/ai-docs/src/80_cluster/10_entities.ts)
- [Cluster message persistence contract](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/cluster/MessageStorage.ts)
- [Workflow Activity](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/src/unstable/workflow/Activity.ts)
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
- [Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md)
