# Dependency policy

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Bun workspaces use explicit dependencies and a committed lockfile. No undeclared cross-package imports. Use exact versions for Effect RC/native compiler integration; application-level ancillary tools may use controlled ranges only after the repository establishes its update policy. The bootstrap records concrete selected versions.

## Selection criteria

Choose a dependency because it removes a concrete owned responsibility, not because it has a familiar name. Inspect maintenance, license, release history, runtime support, security surface, transitive native code and exit path. A package providing SQL queries does not remove actor transaction/recovery design.

## Native and lifecycle scripts

Bun trustedDependencies is an allowlist. Do not automatically trust every native installer. Document why a required lifecycle script is permitted and pin its package. Effect compiler/lint patching is explicit setup, not an unexplained postinstall side effect. Preserve a report of patched versions and checksums where possible.

## Automated updates

Renovate groups Effect ecosystem versions together and native compiler/Effect tsgo/Oxlint companion versions together. Update Bun independently with runtime regression tests. Do not auto-merge prerelease runtime/storage changes. Security-only updates still need compatibility tests when they touch persistence/transport.

## Vulnerability handling

Use dependency/container scanning and triage exploitability in our deployment. Do not suppress scanner output without owner/reason/expiry. SBOM and provenance improve traceability, not correctness or absence of vulnerabilities.

## Publication

Effect is a peer/shared foundation, not bundled copies per package. Avoid hidden version forks that create duplicate service identity or incompatible types. Isolated consumer tests check peer dependency resolution under both supported runtimes.

## Sources and evidence

- [B02: Bun isolated installs](https://bun.com/docs/pm/isolated-installs) — Isolated dependency layout helps expose phantom dependencies.
- [B04: Bun install](https://bun.com/docs/pm/cli/install) — Lockfile and trusted dependency lifecycle policies.
- [E11: Effect TypeScript-Go tooling](https://github.com/Effect-TS/tsgo/blob/main/README.md) — Observed support matrix: @effect/tsgo 0.45.0; TypeScript 7.0.2; Oxlint 1.81/1.82; oxlint-tsgolint 7.0.2001.
- [D14: Renovate](https://docs.renovatebot.com/) — Group coupled compiler/Effect toolchain updates.
- [D17: Trivy SBOM](https://trivy.dev/docs/latest/guide/supply-chain/attestation/sbom/) — Container/SBOM scanning; not proof of actor correctness.
