# TypeScript / Effect tsgo / Oxlint / Oxfmt — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Type checking/declarations, Effect semantic diagnostics, fast lint and one formatter.

## Alternatives
tsc+Effect language service, ESLint/Prettier, Bun-only transpilation. Choose tested native tuple with explicit checks.

## Selection rationale
Strict Effect project benefits from compiler-aware rules; formatting should be boring.

## Maturity
Selected support matrix is version-specific, not interchangeable latest tags.

## Performance
Native tooling may reduce CI time; correctness and enabled diagnostics take priority.

## Developer experience
All Effect rules error with narrow documented exceptions; avoid duplicate lint messages from overlapping modes.

## Effect integration
Rules detect missing requirements, floating Effects, layer wiring and lifetime mistakes.

## Bun integration
Bun invokes tools; do not assume a Node-based binary ran under Bun.

## Node compatibility
Compiler outputs portable ESM/declarations; type fixtures cover Node consumers.

## CI behavior
Inventory rules and run a deliberately failing diagnostic sentinel before trusting green CI.

## Local behavior
Explicit setup, no hidden unsafe install patch; actionable report on unsupported tuple.

## Production behavior
Not runtime dependencies; emitted artifact compatibility is what matters.

## Maintenance risk
Native compiler patches/support matrix can lag new releases.

## Licensing
Record package licenses and native components in lock/SBOM.

## Pricing
Mostly developer/CI compute cost, not per-actor billing.

## Lock-in
Config/tooling is replaceable, but strict diagnostics are a project standard.

## Migration path
Fallback requires an explicit ADR preserving rule coverage, not silent disable.

## Known issues / uncertainties
Do not invent effecttsgo plugin names or wildcard severity support; use selected official guide.

## Operational burden
Maintain grouped Renovate updates and sentinel checks.

## Security implications
Pin binary dependencies and reviewed patch modes; no privileged scripts on untrusted PR.

## Sources
- [Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md)
- [Effect Oxlint integration guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md)
- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config)
- [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config)
