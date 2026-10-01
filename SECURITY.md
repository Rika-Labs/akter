# Security policy

Akter is alpha software. Interfaces and guarantees can still change, and it has not had an external security review.

## Supported versions

Only the latest `0.x` alpha release of the framework packages receives security fixes. Older alphas are not patched; upgrade to the latest one.

## Reporting a vulnerability

Report privately through GitHub Security Advisories for `Rika-Labs/akter`: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a suspected vulnerability.

Include:

- the affected package and version, or the commit you tested
- what an attacker can do and what access they need
- steps or a minimal project that reproduces it, ideally against a real Postgres
- any logs, receipts, or configuration that help, with secrets removed

We acknowledge reports within 3 business days. We will keep you updated while we investigate and credit you in the advisory if you want.

## Scope

In scope: the framework packages in this repository, such as `@rikalabs/akter`, and the code that ships with them.

Out of scope: the hosted cloud service and its infrastructure, and vulnerabilities in third-party dependencies that have no effect on these packages (report those upstream).

There is no bug bounty program.
