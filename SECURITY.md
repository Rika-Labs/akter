# Security policy

Akter is alpha software. Interfaces and guarantees can still change, and it has not had an external security review.

## Scope

This policy covers the open-source Akter framework packages in this repository (such as `@rikalabs/akter` and the `akter` CLI) and Akter Cloud, including its console, API, edge and managed runtime. The hosted service's policy is also published at https://akter.dev/security, with machine-readable contacts at https://akter.dev/.well-known/security.txt.

Out of scope: vulnerabilities in third-party dependencies that have no effect on Akter (report those upstream). There is no bug bounty program.

## Supported versions

Only the latest `0.x` alpha release of the framework packages receives security fixes. Older alphas are not patched; upgrade to the latest one.

## Reporting a vulnerability

Report privately, either by email to security@akter.dev or through GitHub Security Advisories for `Rika-Labs/akter` (the repository's **Security** tab, **Report a vulnerability**). Please do not open a public issue or pull request for a suspected vulnerability.

Include:

- for the framework: the affected package and version, or the commit you tested, the runtime and the database server
- for Akter Cloud: the affected service, the region if known, and timestamps or request identifiers
- what an attacker can do and what access they need
- steps or a minimal project that reproduces it, with credentials and personal data removed
- a way to contact you

Only test accounts, applications and data you control or have explicit permission to test. Do not disrupt the service, run denial-of-service tests, scan broadly, send spam or keep access. If you come across another person's data, stop and report what you saw without copying more of it.

We acknowledge reports within 3 business days, keep you updated while we investigate, and coordinate a fix and disclosure timeline with you. We credit you in the advisory if you want. This policy is a reporting channel, not permission for intrusive testing.

Account and billing questions about Akter Cloud go to support@akter.dev.
