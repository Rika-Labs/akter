# Blacksmith / GitHub Actions — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Fast build/test compute and repository automation.

## Alternatives
GitHub-hosted builds, self-run VMs, other CI. Blacksmith preferred for non-publication workloads.

## Selection rationale
User preference and caching potential; security/runner compatibility are explicit.

## Maturity
Runner labels/features are account/product-specific and must be enabled.

## Performance
Benchmark install/build/container cache hit rates; no assumed multiplier.

## Developer experience
Familiar GitHub workflow with configurable runner labels.

## Effect integration
Runs the same Effect validation commands as local.

## Bun integration
Pinned setup-bun and frozen installs.

## Node compatibility
Node 24/26 matrix and packed consumer probes.

## CI behavior
No secrets on fork PRs; protected integration jobs; immutable action pins.

## Local behavior
Developer scripts match CI stages.

## Production behavior
Release/deploy artifacts retain commit identity.

## Maintenance risk
Third-party runner outage and action revisions need ownership.

## Licensing
Provider terms and repository licensing separate.

## Pricing
Model runner minutes/cache/storage costs from actual plan.

## Lock-in
Keep runner selection configurable at repository level; workflows remain standard.

## Migration path
Fallback to supported GitHub-hosted label for critical tests.

## Known issues / uncertainties
npm trusted publishing restrictions mean release cannot blindly reuse self-hosted runner.

## Operational burden
Runner onboarding, cache security, billing and credential scope.

## Security implications
Untrusted build isolation, least privilege, protected deployments/publication.

## Sources
- [Blacksmith documentation](https://docs.blacksmith.sh/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
