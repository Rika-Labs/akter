# Threat model

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

| Threat | Entry point | Main control | Test/evidence |
|---|---|---|---|
| Cross-tenant actor access | Gateway/ref resolution | Authenticated namespace + protocol grants | Negative tenant/actor lookup tests |
| Privileged command spoof | User-supplied command tag | Public protocol allowlist and execution auth | Direct internal-tag request rejection |
| Stale writer | Paused/reconnected runner | Sink-local fence under transaction | Two-owner failpoint test |
| Credential leak | Logs/projections/errors | Redacted values, payload logging off, scoped grants | Canary-secret scan |
| SQL/runtime table corruption | Raw actor SQL | Trusted-code boundary/reserved table policy; later authorizer | Isolation tests and documented exclusions |
| Provisioning cost attack | Actor creation | Admission quota before paid provisioning | Burst/create quota test |
| Projection SSRF | Customer sink config | Destination validation, TLS, network policy | Metadata/private endpoint rejection |
| Projection data exfiltration | projected fields | Explicit export configuration and grants | Field-level exclusion tests |
| Replay/dedupe abuse | Reused request ID | Payload digest, incarnation and retention contract | Same key/different body conflict |
| Blob cross-prefix access | Signed URLs/keys | Per-request authorization and scoped signatures | Traversal/prefix/method tests |
| Cache poisoning | Shared cache credentials | Namespaced mediated access, not authority | Flush/stale/cross-app tests |
| Message/fanout storm | Actors calling actors | Root budgets and bounded admission | Cyclic/fanout load tests |
| Untrusted code escape | Hosted application | Process/container isolation, syscall/network limits | Independent sandbox evaluation |
| Malicious PR build | CI | No secrets on forks, cache isolation, action pins | Workflow policy audit |
| Dependency compromise | Install/publish | Lockfile, trusted scripts, provenance, protected OIDC | Supply-chain checklist |
| Restore inconsistencies | Admin recovery | Incarnation/version coordination | Restore/replay exercise |

## Trust limitations

The MVP hosts trusted code per isolated application deployment, not arbitrary users in a shared JavaScript VM. This is a deliberate reduction in attack surface. A fully managed code-hosting service requires a security review and incident response owner beyond framework unit tests.

## Incident response

Preserve logical command IDs and audit trails without retaining secret payloads. Support tenant/application suspension, credential revocation, projection egress shutdown and actor write freeze. Document how these affect accepted-work obligations. Report whether commands were accepted, committed, externally executed or still unknown; do not equate process termination with rollback.

## Before launch

Complete an external design review of tenant isolation, secret provisioning, projection egress and administrative replay/delete operations. Validate restore and credential rotation. Establish a real security contact and response policy before changing the skeleton's private packages into public artifacts.

## Sources and evidence

- [D18: GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — Least privilege, immutable action pins, untrusted PR precautions.
- [A09: AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) — Choose control-plane-managed secrets, grants, rotation and audit.
- [A10: Better Auth](https://www.better-auth.com/docs/installation) — Dashboard authentication candidate; does not implement actor authorization.
- [P04: PostgreSQL advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html) — Session-level and transaction-level advisory locks have different lifetime requirements.
