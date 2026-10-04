# Attributed console commands

Status: accepted (2026-10-04, under Dallen's standing approval for the cloud control plane). Amends [ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md) §2 and supersedes the fixed-caller sentence of [ADR 0081](0081-console-command-idempotency.md).

## Context

[ADR 0031](0031-hosted-ingress-tenant-directory-and-regions.md) has the edge sign an assertion whose `caller` is the identity the edge itself verified from the request's credential. When the console sends a command, the edge verifies only the control plane's deployment service credential, so actors, receipts and audit saw every console command as `akter-control-plane`. ADR 0081 recorded that as intended. A console used by several people needs the person who sent each command visible to the actor's `access` policy and in its receipts.

## Decision

The edge may sign a caller that the control plane asserts, under these conditions only:

- The control plane authorizes first. It verifies a Better Auth session or API key and requires project write permission before the request reaches the edge. Attribution never grants access on either side.
- The control plane names the caller `user:<id>` for a session and `api-key:<id>` for an API key, the same subject its audit entries use, and sends it in the `akter-on-behalf-of` header next to its deployment service credential.
- The edge honors the header only when the request's principal is the control plane's service credential. That is a hosted API key registered by rollout with subject `akter-control-plane`, bound to one deployment. A JWT is never treated as the service credential, because its issuer chooses its subject. A value that doesn't match `user:<id>` or `api-key:<id>` is refused with `InvalidInput` before metering.
- On every other request the edge strips the header and signs the credential's own caller. The header never reaches a runner, which trusts only the signed assertion. Tenant, region, expiry and the credential's metering are unchanged.

Inspection reads carry no attributed caller; they run as the service credential in its own tenant.

## Consequences

- Actor `access` policies, receipts and audit see the console user rather than the control plane.
- The edge now signs a caller it did not verify itself. The trust rests on the service credential being creatable only by rollout and bound to one deployment, so the control plane can't attribute a caller in another organization's deployment.
- Within one organization, a runner can't tell a console `user:<id>` from an application JWT whose subject has the same shape. Applications that need to tell them apart should not rely on the subject alone; [contract 11](../contracts/11-control-plane.md) §10 says so.

## Evidence

Edge tests refuse forged and malformed headers on tenant API keys and JWTs and strip them on every path. The `apps/api` stack test shows the runner receiving the signed-in user and a tenant key's forged header ignored.
