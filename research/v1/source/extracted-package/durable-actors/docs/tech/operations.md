# Storage / secrets / observability defaults — 20-axis review

Research date: 2026-09-17. Decisions are recommendations; conditional claims require the cited validation gates.

## Purpose
Standard managed capabilities around the actor kernel.

## Alternatives
R2/S3/Tigris, memory/Valkey/Redis alternatives, managed/self-hosted telemetry and secrets.

## Selection rationale
Start with memory cache, S3-compatible blobs, explicit secret manager and OTLP.

## Maturity
Assess each exact provider/feature; protocol compatibility is not complete equivalence.

## Performance
Region/network/retention matter more than abstraction syntax.

## Developer experience
Uniform services with honest different durability semantics.

## Effect integration
Effect services/streams/tracing wrap actual provider boundaries.

## Bun integration
Adapter-level HTTP/TLS/stream tests on Bun.

## Node compatibility
Same API/behavior tests on Node.

## CI behavior
Mocks for units plus protected provider conformance.

## Local behavior
Filesystem blobs, env-backed allowlisted secrets, memory cache; no paid resources required.

## Production behavior
R2 pilot, external secret manager, OTLP/Grafana evaluation, shared Valkey only when justified.

## Maintenance risk
Provider changes, retention defaults and command coverage require upgrades.

## Licensing
Check provider/engine terms separately, especially cache alternatives.

## Pricing
Account for fixed minimums, request fees, egress from compute and telemetry cardinality.

## Lock-in
S3/RESP/OTLP help portability but feature subsets still need tests.

## Migration path
Rehearse exports, key rotation, cache flush and alternate endpoint tests.

## Known issues / uncertainties
Prefix isolation alone is not authorization; Redacted alone does not prevent privileged leaks.

## Operational burden
Backups, cleanup, quotas, key management, cardinality and retention.

## Security implications
Scoped credentials, no secret payload logs, no cache as correctness authority.

## Sources
- [S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Tigris docs](https://www.tigrisdata.com/docs/)
- [Valkey](https://valkey.io/)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html)
- [OpenTelemetry collector](https://opentelemetry.io/docs/collector/)
- [Grafana Cloud pricing](https://grafana.com/pricing/)
