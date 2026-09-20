# Package dependency rules

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Allowed graph

```
Effect
  -> core
  -> cluster -> core
  -> turso -> core
  -> projections -> core
  -> http -> core
  -> cli -> core + http
  -> platform-bun -> core
  -> platform-node -> core
  -> testing -> core

runner/gateway/relay application assembly
  -> relevant packages and selected providers
```

An arrow here means 'is an upstream foundation for' only on the first line; the explicit package dependencies are the right-hand `-> core` entries. For automated checks, `specs/package-graph.json` is the canonical directed dependency map: keys depend on values. Keep documentation and manifests synchronized.

## Rules

Core knows no Turso account API, PlanetScale host, Railway environment or Bun-only module. Cluster consumes a DatabaseProvisioner contract, not the concrete Turso package. Turso implements provisioning/client construction, not actor semantics. Projections consume committed change contracts and a typed sink, not private Cluster internals. The HTTP package maps errors and authentication to actor calls, not business repositories. CLI is another client.

The testing package depends on public core contracts and supplies conformance types/fixtures. Provider-specific tests live with their adapters or in application integration suites. Avoid `testing -> every adapter -> testing` dependency cycles.

## Layer assembly

Applications wire dependencies with `Layer.provide`/`provideMerge` as appropriate. A root `Layer.mergeAll(Cluster, Turso, App)` is not sufficient if these Layers require one another. Keep environment-specific assembly in app entries. Name SQL roles explicitly to avoid service collisions.

## Release boundaries

Initially maintain the runtime packages as one compatible prerelease group. Separately version documentation/apps. Do not publish a dependency graph with unpublished private packages in transitive runtime dependencies. Before making a package public, verify its tarball, exports, peer requirements and downstream consumer typechecks under Bun/Node.

## Enforcement

The scaffold checker rejects undeclared workspace dependencies, cycles, `src` path imports and Bun imports in portable packages. Later add a proper import-boundary lint/graph tool only when simple checks become insufficient. Architectural rules are not merely prose.

## Sources and evidence

- [D08: Turborepo configuration](https://turborepo.com/docs/reference/configuration) — Task graph, cached outputs, environment inputs; not a substitute for dependency architecture.
- [D15: publint](https://publint.dev/docs/) — Package manifest and export-map inspection.
- [D16: Are The Types Wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) — Published package type-resolution checks.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
