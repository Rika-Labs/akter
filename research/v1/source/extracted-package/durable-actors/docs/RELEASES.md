# Release and publication

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Use Changesets for release intent/changelogs and a coordinated prerelease group for the actor runtime packages. Keep packages private in this skeleton. The owner must approve license, npm scope, maintainer identity, export surface, compatibility claims and security contact before publication.

## Build once, verify, publish

A protected workflow builds package artifacts from a known commit, runs format/lint/type/tests/export validation and produces checksums/SBOM as appropriate. Publication uses a supported GitHub-hosted OIDC environment and verifies artifact identity. Blacksmith can perform builds/tests; do not assume npm trusted publishing accepts its self-hosted runner identity.

Use npm provenance/trusted publisher configuration with least privilege rather than long-lived all-packages tokens. Configure package permissions manually in the registry as an owner action. No script in this archive creates accounts, publishes packages or modifies repository settings.

## Package validation

Pack the actual package and install it into isolated Bun and Node consumer fixtures. Test root/subpath imports, declarations, absent internal exports and peer version requirements. Use publint and AreTheTypesWrong. A workspace import succeeding does not prove an npm tarball works. Ensure workspace ranges/catalog references resolve correctly during publication.

## Versions

Treat Effect RC/toolchain upgrades as coordinated compatibility changes. Public actor API is prerelease until recovery behavior and wire versions are settled. Separate package version, wire protocol version, actor schema version and deployment code version. A patch version cannot silently change replay semantics.

## Rollback

A previous npm package or container image can be restored only if its code supports current stored schema/messages. Document safe rollback range with each release. Destructive schema contraction requires a separate staged rollout and support window.

## Release readiness

No unresolved critical durability/security gates; Node/Bun conformance evidence; published migration/upgrade notes; workload cost baselines; support/runbook ownership; accurate limitations. Do not publish 'production ready' based solely on clean linter output.

## Sources and evidence

- [D13: Changesets](https://github.com/changesets/changesets) — Version/changelog workflow, separate from registry authentication.
- [D07: npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) — Validate supported hosted CI environments; keep release job independent from Blacksmith.
- [D15: publint](https://publint.dev/docs/) — Package manifest and export-map inspection.
- [D16: Are The Types Wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) — Published package type-resolution checks.
- [D18: GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — Least privilege, immutable action pins, untrusted PR precautions.
