# Monorepo layout

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Structure

```
packages/
  core/           # contracts, descriptors, portable semantics
  cluster/        # standard runtime integration, control-store bridge
  turso/          # private DB provisioning/client adapter
  projections/    # optional capture/relay/sink contracts
  platform-bun/   # Bun-specific process/runtime services
  platform-node/  # Node-compatible services
  http/           # typed remote client/server transport
  cli/            # CLI transport and operator UX
  testing/        # reusable contract-test interfaces/fixtures
apps/
  docs/           # Vite setup/documentation portal now
  runner/         # planned deployment entry, no runtime yet
  gateway/        # planned entry, no live API yet
  relay/          # planned projection/work relay entry
examples/
  todos/ orders/ domains-certificates/ realtime/ projections/
infra/
  railway/ alchemy/ compose/
docs/ research/ specs/ models/ scripts/
```

Packages exist for explicit dependency/runtime boundaries, not every class. Do not split Cache/Secrets/Events into a dozen npm packages yet. Agents are documented as a future package, not implemented or published in the initial graph.

## Mirrored tests

For each `src/foo/bar.ts`, use `test/foo/bar.test.ts` when there is behavior or contract to test. Cross-package integration scenarios live under `test/integration` and reuse fixtures, not private imports. A `test/README.md` documents deliberate unimplemented suites. No snapshot of fake success is counted as a runtime test.

## Imports and exports

Each package has explicit ESM exports. Public root exports are intentional; internal modules import direct siblings, not the barrel. `src/internal` is never exported. Do not reach into `../../other-package/src`. Workspace dependencies are declared and build/task edges follow them.

Published libraries compile to `dist` with declarations. Source/test configs are separate so published artifacts do not include test runners, Bun globals, fixtures or secrets. All placeholder packages stay `private: true` until API and license/release gates pass.

## Root tooling

Bun workspaces and lockfile; Turbo for task scheduling; TypeScript/native compiler for declarations; Oxlint for static lint; Effect diagnostics at error severity; Oxfmt for formatting; Vitest/@effect/vitest for semantic tests; native Bun lane for platform conformance. Vite is an app tool, not the library compiler.

## Ownership

Core is owned by the framework team; adapter changes need conformance evidence; projection changes need ordering/rebuild tests. Infrastructure provider state is owned by exactly one tool. Docs and ADRs change in the same PR as public behavior. CODEOWNERS is a template until actual maintainers/repository teams are supplied.

## Sources and evidence

- [B02: Bun isolated installs](https://bun.com/docs/pm/isolated-installs) — Isolated dependency layout helps expose phantom dependencies.
- [B03: Bun workspaces/catalogs](https://bun.com/docs/pm/catalogs) — Shared version catalogs and workspaces; registry packaging must rewrite workspace references correctly.
- [D08: Turborepo configuration](https://turborepo.com/docs/reference/configuration) — Task graph, cached outputs, environment inputs; not a substitute for dependency architecture.
- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
