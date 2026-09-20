# Publishing / Changesets / Renovate — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Version intent, dependency maintenance and verifiable distribution.

## Alternatives
Manual releases, semantic-release, other update bots. Changesets+Renovate selected.

## Selection rationale
Explicit package-level change intent fits a public framework.

## Maturity
Tools are established, but current registry/runner OIDC compatibility must be verified.

## Performance
Release speed is secondary to clean packed artifacts and compatibility.

## Developer experience
Clear prereleases/changelogs; no automatic release from arbitrary commits.

## Effect integration
Group Effect RC packages and preserve typed public contracts.

## Bun integration
Verify Bun workspace/catalog packing and package consumption.

## Node compatibility
Pack/install/typecheck on Node consumer fixtures too.

## CI behavior
Protected supported hosted OIDC publish after Blacksmith build/test.

## Local behavior
Developers write changesets; publication remains owner-controlled.

## Production behavior
Artifact checksums/provenance map release to tested commit.

## Maintenance risk
Registry policy changes and peer-version drift need monitoring.

## Licensing
Actual project license must be approved before publication.

## Pricing
Registry/CI costs small relative to runtime, but support/version maintenance matters.

## Lock-in
npm is intentional distribution; package manifests remain standard.

## Migration path
Keep clean package tarballs and changelog history for alternate registry if needed.

## Known issues / uncertainties
Do not publish private placeholders or declare runtime exports that do not exist.

## Operational burden
Security contact, maintainer access, release ownership and rollback compatibility.

## Security implications
OIDC, least privilege, pinned actions, no credentials on forks, supply-chain metadata.

## Sources
- [Changesets](https://github.com/changesets/changesets)
- [Renovate](https://docs.renovatebot.com/)
- [publint](https://publint.dev/docs/)
- [Are The Types Wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
