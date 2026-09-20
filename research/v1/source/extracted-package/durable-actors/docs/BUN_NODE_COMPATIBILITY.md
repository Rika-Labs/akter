# Bun / Node compatibility contract

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Supported surface

Portable packages may depend on Effect, standard ECMAScript and explicit cross-runtime contracts. They do not import `bun:*`, call Bun globals, use Node-only modules unabstracted, or assume process-global environment/configuration. Runtime-specific packages provide implementations. Tooling may use `node:*` APIs supported by the pinned Bun version and is tested separately.

## Baseline

Primary: exact Bun version in `.bun-version` selected from the verified registry snapshot. Required compatibility target: Node 24 LTS. Additional forward lane: Node 26 while it is not the LTS baseline for this research date. Exact compiler/linter tuple lives in `toolchain.lock.json`; do not mix independently upgraded native compiler tools.

## Acceptance matrix

| Area | Bun test | Node test |
|---|---|---|
| Emitted ESM / export map | Required | Required |
| Protocol encode/decode | Required | Required |
| Actor command receipt replay | Required once runtime exists | Same shared conformance cases |
| libSQL rollback/connection loss | Remote integration | Remote integration |
| PostgreSQL direct/session locks | Integration | Integration |
| HTTP / SSE / WebSocket | Connect, abort, slow client, proxy | Same test cases |
| Timers/TestClock | Runtime adapter + semantic tests | Semantic tests |
| SIGTERM/drain/kill -9 | Linux process test | Linux process test |
| CLI / subprocess | Argument/stdin/stdout/cancel | Same cases |
| Blob signing/streaming/TLS | Provider contract tests | Same cases |
| Native addons | Explicit allowlist | Explicit allowlist |

## Package exports

Use ordinary `types` and ESM `import` exports for portable packages. Separate platform-bun/platform-node entrypoints avoid hidden conditional logic. Do not publish source-only `.ts` files and assume every Node consumer can execute them. Avoid dual ESM/CJS packaging until there is customer demand and tests for the dual-package hazard.

`@types/bun` belongs in Bun-specific tests/adapters, not ambient global types for every package. Portable tsconfigs use `types: []` or their deliberate minimal environment. Cross-runtime type tests must catch accidental Bun globals.

## Regression policy

A change fails compatibility if behavior diverges at a public protocol/durability boundary, even if both builds succeed. A platform-specific optimization needs an equivalent fallback and a benchmark showing value. Unsupported library/native addon combinations are recorded in a compatibility matrix with a workaround or rejected feature—not silently ignored.

## What this archive validates

The initial source is contract-only. Import/build smoke checks establish packaging compatibility, not actor execution equivalence. The actual validation report records tools available and commands run. All runtime-specific conformance cases remain explicit implementation gates.

## Sources and evidence

- [B01: Bun Node compatibility](https://bun.com/docs/runtime/nodejs-compat) — Bun tracks Node compatibility; compatibility is not completeness and requires our own production path tests.
- [B10: Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json) — Select Node 24 LTS support baseline for Sept 2026; Node 26 is additional forward compatibility lane.
- [E13: Effect platform Bun](https://github.com/Effect-TS/effect/tree/main/packages/platform-bun) — Runtime implementations; exact exports must be checked against pinned release.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
