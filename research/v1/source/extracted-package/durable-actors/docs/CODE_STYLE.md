# Code style

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Use small files with one clear capability or domain concern. File size is a smell, not a hard rule: splitting one cohesive transactional algorithm across ten files can hide its invariants.

## Naming and structure

Files use kebab-case. Domain values/types use descriptive PascalCase. Effect service modules may export `Interface`, `Service`, `layer` and `defaultLayer` internally; public packages expose one clear capability name. Avoid TypeScript namespaces and avoid accidental circular self-reexports in library internals. Public index files are deliberate exports, not a dependency shortcut.

Expected failures are typed tagged values/Schema error classes, not an undifferentiated native Error. Defects are reserved for broken invariants/programmer errors. Do not turn every provider rejection into a defect. Use Effect.tryPromise at unavoidable Promise boundaries and preserve cause/context safely.

## Data

Use Schema at persisted/network boundaries. IDs are branded/canonicalized. Schema types are not automatic storage encodings: booleans/dates/bytes have explicit codecs. Use integer/decimal-safe representations for money and 64-bit counters. Avoid `any`, blind casts and `as` to conceal missing capabilities.

## Public methods

Name Effect.fn spans at service operations where useful. Do not create a tracing span around every pure helper. Private pure helpers stay ordinary functions. Inject clock/random/provider clients where determinism or testing matters.

## Documentation

State the failure/durability contract next to any public operation. Document whether an operation is live, persisted, idempotent, retryable, cancellable and actor-local. Avoid comments asserting guarantees the implementation does not enforce.

## Formatting/lint

One root Oxfmt policy; no competing Prettier configuration. Oxlint plus all selected Effect diagnostics at error severity. Exceptions must be narrow, documented and reviewed. An upstream rule conflict is a compatibility issue; do not disable the whole diagnostic family to pass CI.

## Sources and evidence

- [O01: OpenCode service conventions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/opencode/AGENTS.md) — Flat modules, small Interface, Context.Service, layer/defaultLayer, named Effect.fn, scoped workspace state. Application conventions are not actor semantics.
- [O02: OpenCode v2 instructions](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/specs/v2/instructions.md) — Additional architecture guidance; use as design inspiration, not copied implementation.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [D09: Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config) — Choose supported config file; use current parser, do not assume arbitrary TypeScript config support.
- [D10: Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config) — Formatter configuration and ignore rules; root .oxfmtrc.json chosen for simplicity.
