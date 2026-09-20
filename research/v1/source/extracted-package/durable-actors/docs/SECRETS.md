# Secrets and capability grants

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

Secrets are read-only capabilities within actor code. Store secret definitions and encrypted versions in the control plane or an external secret manager; do not copy them into actor tables, projections, public events or blob metadata. Use Effect Redacted values for accidental display protection, while acknowledging that privileged code can still explicitly unwrap and leak them.

## No implicit privilege escalation

An actor type declares allowed secret names/capabilities. Deployment binds those names to explicit secret versions/scopes. Avoid a broad fallback chain that unexpectedly substitutes an application-wide credential when a tenant-scoped secret is missing. Missing required binding is a configuration failure, not a reason to read a more privileged secret.

Derive tenant/application identity from authenticated runtime context. Actor code cannot choose another tenant string to read that tenant's secret. Projection sink credentials and provider provisioning tokens are control-plane capabilities, not automatically available to every actor.

## Hosted pilot choice

Use an external secret manager/KMS-backed control-plane mechanism for database/provider credentials. AWS Secrets Manager with KMS is a conservative reference implementation; keep an adapter boundary for customer-managed Vault or equivalent. Railway environment variables may bootstrap trusted service credentials, but are not a complete tenant-scoped secret store.

## Rotation

Version secrets, audit grants, expire cached material and define reconnect behavior for provider clients. A running activity may need the version it started with or an explicit refreshed credential; never silently change identity mid-operation. Database rotation must preserve recoverability of in-flight work while revoking stale access promptly.

## Local/self-host

Environment-backed secrets are acceptable for local trusted development, with explicit name allowlists and sample placeholders. Kubernetes/Vault/cloud manager adapters can serve production. Do not print effective config containing secret values. `.env.example` contains variable names only; actual files are ignored.

## Tests

Denied name, cross-tenant actor ID spoof, missing binding, old version revoked, provider auth failure after rotation, log redaction and projection exclusion. For untrusted application code, per-tenant process/container isolation and scoped service credentials are necessary beyond a TypeScript service type.

## Sources and evidence

- [A09: AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) — Choose control-plane-managed secrets, grants, rotation and audit.
- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [D18: GitHub workflow security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) — Least privilege, immutable action pins, untrusted PR precautions.
