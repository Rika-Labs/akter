# Security architecture

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Trust boundaries

Distinguish platform control plane, customer application deployment, actor authority, external provider and end-user client. Effect service injection is a programming abstraction, not an OS security boundary. The first managed pilot should isolate customer application code in separate deployment/container boundaries and scoped credentials. Do not run arbitrary tenants inside one Bun VM merely because their actor IDs differ.

## Authentication and authorization

Dashboard login and runtime actor authorization are separate. Better Auth is a control-plane authentication candidate; it does not define actor grants. Runtime commands require authenticated application/environment identity, principal and permission for the target actor protocol. Recheck sensitive permissions at execution time when queued work may outlive authorization changes. Record the policy/grant version used.

ActorAddress is not a capability on its own. Signing or hiding an ID is not sufficient. Public clients must not resolve arbitrary actor types, enumerate other tenants, create unbounded actors or choose privileged command tags.

## Data plane

Use TLS verification, scoped provider tokens, managed rotation and bounded requests. Private actor DBs require separate credentials or a mediating service that enforces namespace. Prevent actor SQL from modifying platform-wide tables. Reserved internal tables in the same actor DB remain a trusted-code contract until a real authorization mechanism is implemented.

Projection configuration is an outbound data-export surface. Validate destinations, prevent access to link-local metadata/private control endpoints, separate migrations from writer roles and limit fields. Blob prefixes require actual access policy. Cache prefixes are not isolation against a client holding shared unrestricted Redis credentials.

## Resource abuse

Limit actor creation, database provisioning, message size, fan-out, activity concurrency, storage retention and projection backlog. Check quotas before accepting durable cost. Rate limits that protect shared infrastructure must not live only in a disposable per-actor cache.

## Supply chain

Bun installs use a lockfile and explicit trusted dependency lifecycle scripts. Pin GitHub Actions to reviewed immutable revisions. Untrusted PRs receive no provider credentials or write access to privileged caches. Release publication happens in a supported protected OIDC environment after package checks. Scan images/dependencies and publish SBOM/provenance once a real release exists.

## Initial exclusions

No untrusted shell execution service, no global multi-tenant worker VM, no customer-supplied network plugins in the platform process, and no compliance certification claim. The security policy identifies these exclusions rather than implying a small framework has inherited every provider's certification.

## Sources and evidence

- [A10: Better Auth](https://www.better-auth.com/docs/installation) — Dashboard authentication candidate; does not implement actor authorization.
- [A09: AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) — Choose control-plane-managed secrets, grants, rotation and audit.
- [D07: npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) — Validate supported hosted CI environments; keep release job independent from Blacksmith.
- [D18: GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — Least privilege, immutable action pins, untrusted PR precautions.
- [B04: Bun install](https://bun.com/docs/pm/cli/install) — Lockfile and trusted dependency lifecycle policies.
