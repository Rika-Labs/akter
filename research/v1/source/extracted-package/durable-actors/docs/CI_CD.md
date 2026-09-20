# CI/CD design

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Pull requests

Use Blacksmith for installs, lint/type checks, unit tests, library builds and container validation after the repository owner enables the runner integration. Runner labels are deployment/account configuration, not a package requirement. The template defaults to a documented Blacksmith Ubuntu label and permits a repository variable override.

Pipeline order: frozen install -> scaffold check -> formatter -> standard Oxlint -> Effect diagnostics -> typecheck -> tests -> build -> package export/import checks. Integration tests requiring secrets run only in approved trusted contexts. Fork PRs must not receive Turso/PlanetScale/Railway credentials or share privileged writable caches.

## Compiler/diagnostics

Pin Bun, TypeScript, Effect tooling, Oxlint and native lint companion as a tested tuple. All installed Effect diagnostics are explicit error entries. The setup script inventories the selected tool's documented rule IDs and verifies an intentional diagnostic sentinel in an isolated fixture. If the patch/plugin mode is unavailable, fail with an actionable compatibility report; do not silently fall back to plain TypeScript and claim strict enforcement.

## Node/Bun lanes

Primary tests use the supported @effect/vitest host. Emitted ESM import probes run under both Node 24 and Bun. A separate native Bun test lane covers runtime-specific code. Node 26 is a forward-compatibility lane. Real behavior cases are added as adapters are implemented.

## Releases

Build/test on Blacksmith, then publish only from a supported protected GitHub-hosted OIDC environment with artifact verification. npm trusted publishing support is not assumed for self-hosted runners. Packages remain private and publication disabled in this scaffold. Pin actions by immutable commit; verify pins during update PRs.

## Deployment

Railway production deployment requires protected environment approval and a known image/commit. Preview deployments are explicit and disposable; no automatic provider resources for every untrusted branch. Store migrations and compatibility evidence with the release. Avoid two systems independently managing the same Railway service.

## Nightly

Fault injection, remote DB conformance, migration matrices, larger projection sequences and benchmarks use controlled test accounts. Preserve failure seeds and logs with redaction. Initially the workflow checks that these gates are implemented before running; it must not produce green badges for nonexistent chaos tests.

## Sources and evidence

- [D06: Blacksmith documentation](https://docs.blacksmith.sh/) — CI runner labels, cache and security model; runner availability is account-dependent.
- [D07: npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) — Validate supported hosted CI environments; keep release job independent from Blacksmith.
- [D18: GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — Least privilege, immutable action pins, untrusted PR precautions.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [E12: Effect Oxlint integration guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md) — Resolve the patching/configuration syntax from the selected version, not an invented plugin interface.
- [E08: Effect Vitest package](https://github.com/Effect-TS/effect/blob/9ad9891e24058065bcd445772e005f8ce4b3e42f/packages/vitest/package.json) — Inspected rc.115 package requires Vitest >=5 <6.
