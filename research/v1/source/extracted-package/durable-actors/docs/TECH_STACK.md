# Selected stack and remaining conditional choices

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Area | Selected default | Status |
|---|---|---|
| Language | TypeScript with a verified native compiler tuple | Compatibility gate |
| Runtime/package manager | Bun first; Node 24 LTS compatibility | Selected |
| Core programming | Effect v4, direct imports | Selected; RC tuple pinned |
| Virtual entity substrate | Effect Cluster | G03/G04/G06 conditional |
| Actor database | Turso libSQL-compatible endpoint | G02 conditional |
| Database API | Effect SQL; Drizzle optional | Selected |
| Control database | PlanetScale Postgres, direct session path for ownership | G06 conditional |
| Projection sink | Customer-owned Postgres | Selected boundary; pipeline beta |
| Realtime | Effect Stream + HTTP/SSE first | Selected |
| External work | Effect Workflow bridge | G10 conditional |
| Packages/tasks | Bun workspaces + Turbo | Selected |
| Lint/format | Oxlint + all Effect diagnostics error + Oxfmt | G01 conditional exact integration |
| Tests | Vitest/@effect/vitest + native Bun lane | Selected matched major |
| Library build | ESM + declarations, no bundled Effect | Selected |
| App dev | Vite portal; Effect/Vite after API verification | Optional integration gate |
| CI | Blacksmith on GitHub Actions | Account enablement required |
| Publication | Changesets; protected hosted npm OIDC; publint/type checks | Disabled until release gates |
| Updates | Renovate with coupled version groups | Selected |
| App deployment | Railway role-based services | Topology gate |
| Infrastructure | Alchemy, one owner per resource | Version/provider gate |
| Blob service | S3-compatible; R2 managed pilot, local filesystem | Provider conformance required |
| Cache | Memory first; Valkey if measured useful | Selected |
| Secrets | Explicit bindings, external manager/KMS; env only local | Selected security model |
| Dashboard authentication | Better Auth for control plane only | Later control-plane implementation |
| Telemetry | Effect OTLP; Grafana Cloud evaluation; vendor-neutral collector | Selected format, vendor pilot |
| Container registry | GHCR | Configure on first real image release |
| Supply-chain checks | Immutable actions, lockfile, provenance, SBOM/Trivy | Release hardening milestone |
| Load/fault tools | k6 external load + custom invariant harness | Planned, not implemented |
| License | Apache-2.0 recommended; private/UNLICENSED now | Owner/legal decision |

Every substantive component has a 20-axis review under docs/tech or a dedicated provider/runtime document. A conditional choice is not a missing opinion: it is a concrete recommendation with an explicit experiment that can falsify it.

## Sources and evidence

- [E01: Effect v4 package snapshot](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/effect/package.json) — Inspected source snapshot identifies 4.0.0-rc.115. A repository version is not proof that every registry artifact is available.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [E08: Effect Vitest package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json) — Inspected rc.115 package requires Vitest >=5 <6.
- [D06: Blacksmith documentation](https://docs.blacksmith.sh/) — CI runner labels, cache and security model; runner availability is account-dependent.
- [D07: npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) — Validate supported hosted CI environments; keep release job independent from Blacksmith.
- [D05: Alchemy](https://alchemy.run/) — Infrastructure-as-code choice; resolve exact version/provider support before runnable stack.
- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
