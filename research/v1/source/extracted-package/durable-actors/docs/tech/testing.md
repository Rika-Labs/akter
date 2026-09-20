# Vitest / @effect/vitest / Bun tests — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Deterministic semantic tests and cross-runtime conformance.

## Alternatives
Bun-only runner, Node test, custom harness. Use official Effect helpers plus Bun lane.

## Selection rationale
Avoid rebuilding TestClock/Layer test integration while honoring Bun production support.

## Maturity
Match @effect/vitest peer major exactly; inspected rc.115 expects Vitest 5.

## Performance
Parallel units; controlled integration/fault concurrency to avoid flaky resource interference.

## Developer experience
Mirrored files, shared fixtures, readable failure seeds.

## Effect integration
Effect TestClock/Layers and typed failure assertions.

## Bun integration
Native Bun lane tests actual Bun imports/adapter behavior.

## Node compatibility
Node semantic suite and runtime conformance remain first-class.

## CI behavior
Separate static, unit, remote, fault, benchmark jobs; no fake green chaos job.

## Local behavior
Fast no-cloud units, explicit integration resources.

## Production behavior
Test results feed release gates but do not replace staging drills.

## Maintenance risk
Runner/version integration updates coordinated with Effect.

## Licensing
Review test dependency licenses; not bundled in runtime packages.

## Pricing
CI/provider test costs bounded and attributed.

## Lock-in
Keep conformance scenarios runner-independent where practical.

## Migration path
Change runner only if Effect lifetime/clock/error tests remain equivalent.

## Known issues / uncertainties
`bun run vitest` may still run on Node; distinguish host explicitly.

## Operational burden
Fixtures, cleanup, remote credentials, seed retention and flaky-test ownership.

## Security implications
No production targets by default; redact provider data from logs/artifacts.

## Sources
- [Effect Vitest package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json)
- [Vitest documentation](https://vitest.dev/guide/)
- [Bun testing](https://bun.com/docs/test)
