# ADR 0138: Framework release posture

Status: accepted, 2026-10-13 (rewrite/0.2); release-posture decision only.

**Responsibility:** separate the finished 0.2 product description from implementation evidence and technical release channels.

**Owner role:** framework release and documentation.

## Context

Dallen requires the current framework README and product documentation to describe the finished Akter 0.2 product when the framework is complete, without product preview, prerelease, or early-status positioning. The framework must not receive an early product release. The repository also contains package canaries, pull-request preview procedures, proposed contracts, and dated evidence whose status must remain accurate.

## Decision

The 0.2 product release waits for completion of the framework under its owning contracts, milestone gates, and verification requirements. This decision does not declare those gates satisfied or authorize publication or the replacement of `main`.

Current product prose describes Akter 0.2 directly, without labeling the product a preview, alpha, beta, or prerelease. Documentation wording is not evidence of implementation completion or provider support.

Technical pull-request preview commands, immutable prerelease versions, canary dist-tags, and registry procedures remain unchanged. Historical ADRs and dated verification facts remain historical. Contract proposal statuses and missing-evidence markers retain their authority and can change only through their existing evidence process.

Akter Cloud has a separate release decision and evidence gates; this record does not change hosted pricing, provider support, rollout, or lifecycle claims.

## Alternatives

- Retain product preview positioning: rejected because it conflicts with the requested finished-product posture.
- Replace every preview or prerelease match: rejected because it would corrupt technical procedures and historical evidence.
- Treat documentation edits as release approval: rejected because prose cannot establish completion or support.

## Consequences

Readers get one product description and explicit evidence boundaries. Upgrade guidance distinguishes the fresh-store transition from 0.1 from ordinary 0.2 redeployments, which retain their store. Package channels remain usable for development without becoming an early product release.

## Evidence

This records Dallen's release-posture direction on 2026-10-13. [ADR 0124](0124-engine-rewrite-and-command-log.md) continues to own branch authority and the clean 0.2 break; [runtime contracts](../contracts/README.md) and [verification](../verification/README.md) continue to own guarantees and their evidence. No runtime or provider test is claimed by this decision.

## Revisit conditions

Revisit only if Dallen changes the release posture. Completion, provider support, publication, and the `main` swap still require their own gates and approvals.
