# ADR 020: Explicit scoped secret bindings

Date: 2026-09-17  
Status: Accepted

## Context
Actors need credentials but lookup fallback and shared provider tokens can leak cross-tenant authority.

## Decision
Use read-only allowlisted secret capabilities bound by deployment, redacted values, versioned rotation and external manager/KMS. No broad privilege fallback.

## Alternatives considered
Environment-only globals do not model tenant grants; per-actor raw secret storage risks projection/log leakage.

## Consequences and risks
Runtime authorization and code/container isolation are needed in addition to typed service access.

## Validation and revisit trigger
Security gate G08 before broad managed hosting; choose provider after operational review.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
