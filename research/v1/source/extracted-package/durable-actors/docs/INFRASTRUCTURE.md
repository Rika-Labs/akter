# Infrastructure ownership

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Choose one owner per resource

Railway owns application service deployment/configuration. Alchemy is the chosen infrastructure-as-code tool for external resources once the selected release/provider APIs are verified. Do not have both Alchemy and manual dashboard state independently mutate the same service without an import/ownership plan.

The exact Alchemy edition/version and Effect-native API must be verified. Do not conflate an older Promise-style API and a newer Effect-oriented API, or assume a Railway provider exists because Alchemy supports another provider. The infrastructure entry in this scaffold is intentionally non-provisioning and documented as a template.

## Resource inventory

- Application compute: Railway gateway/runner/relay roles.
- Control data: PlanetScale PostgreSQL direct endpoint plus role-specific pooled endpoint if validated.
- Actor data: Turso libSQL-compatible endpoint and provisioning API credentials.
- Blobs: R2 pilot or same-region S3 when justified.
- Cache: memory default; shared Valkey only after measured need.
- Secrets: external manager/KMS-backed platform binding.
- Telemetry: OTLP collector/exporter, Grafana Cloud evaluation target.
- Projection destinations: customer-owned and explicitly configured.

## Environment isolation

Local, CI, preview, staging and production have separate names/credentials and clearly tagged resources. Provider creation scripts require explicit environment confirmation. Use quotas and TTL cleanup for test/preview resources. Infrastructure state is sensitive; back it up, encrypt it and restrict access.

## Recovery and drift

Document restoration of control DB and actor DBs as a coordinated process. Keep exports/provider state needed to recreate routing without losing identity mappings. Periodically reconcile orphan databases/blobs and state drift. Do not delete apparently unused resources until queued work/retention references are checked.

## Portability

Self-hosting means a documented operational contract and tested standard adapters, not that every provider's managed feature is available for free. Database export/import, object-store capability tests and control SQL schema ownership are the actual escape paths. Changing SQLite to PostgreSQL is not transparent when application SQL and migrations are dialect-specific.

## Sources and evidence

- [D05: Alchemy](https://alchemy.run/) — Infrastructure-as-code choice; resolve exact version/provider support before runnable stack.
- [D01: Railway monorepos](https://docs.railway.com/guides/monorepo) — Service build/start boundaries and watch paths.
- [P01: PlanetScale PostgreSQL pooling](https://planetscale.com/docs/postgres/connecting/pgbouncer) — Transaction pool on port 6432; session-sensitive locks require suitable direct/session connection.
- [T01: libSQL versus Turso Database](https://docs.turso.tech/libsql) — The maintained SQLite fork and newer Rust rewrite are different engine/driver compatibility targets.
- [A01: S3 consistency](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) — Object-store consistency does not create atomicity with actor database commits.
- [A02: Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/) — S3-compatible storage alternative, request/storage billing; ecosystem egress still exists.
