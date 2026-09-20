# ADR 027: Protected npm publication separate from build runners

Date: 2026-09-17  
Status: Accepted

## Context
Blacksmith is preferred CI compute, while registry OIDC support has runner restrictions.

## Decision
Build/test on Blacksmith; publish from a supported protected GitHub-hosted OIDC job with artifact verification and least privilege.

## Alternatives considered
Long-lived universal npm tokens and publishing from untrusted PR workflows are rejected.

## Consequences and risks
Owner configuration, scope ownership, security contact and license are prerequisites. Publication stays disabled in the skeleton.

## Validation and revisit trigger
Revisit if npm officially supports the desired runner identity with equivalent provenance/security.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [Blacksmith documentation](https://docs.blacksmith.sh/)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
