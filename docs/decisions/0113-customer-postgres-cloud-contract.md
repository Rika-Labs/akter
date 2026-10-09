# ADR 0113: Customer Postgres and compute-only cloud billing

**Status:** accepted (2026-10-09, Dallen).

**Responsibility:** align the public cloud API and CLI with customer-owned Postgres and base subscription plus compute billing.

## Context

Alpha.3 exposed managed database provisioning and read-only states, storage allowances, storage metering and storage quotas. Akter Cloud now hosts compute over the customer's own Postgres on every plan. Retaining those fields would imply a database service and billing obligations the platform no longer offers.

## Decision

- Every environment uses customer Postgres through the write-only `DATABASE_URL`. The optional `Environment.database` report has required `source: "customer"`, `state: "missing" | "reachable" | "unreachable"`, nullable non-negative p50 `latency` in milliseconds, boolean `latencyWarning`, and nullable integer `runnerCap`.
- The deploy probe runs from the runner region. A p50 above 5 ms warns, never refuses on latency alone. Runner cap is `floor((max_connections - in_use - 10) / 9)`; a non-positive result means no runner fits the available connection budget. Unknown measurements remain `null`, not zero. No URL or URL-derived metadata is public.
- Billing is base subscription plus compute unit-hours. Remove storage allowances, hard caps, overage prices, meters, samples, per-project storage usage and managed database features. Keep the shared `QuotaExceeded` schema as the source of truth, removing its storage cap rather than adding a cloud-only override.
- `akter env list` prints names and timestamps without managed provenance. After a rollout reaches `live`, `akter deploy` reads the environment report through the existing transient-read retries and prints its warning and non-null runner cap. The CLI does not duplicate the cloud probe or cap calculation.
- This is a breaking alpha change with no compatibility aliases, shipped with #711's outage retries in framework and CLI version `0.1.0-alpha.4`. The cloud contract remains bundled at `@rikalabs/akter-cli/cloud-api`; it is not another release unit.

## Consequences and evidence

Cloud consumers must update database and billing decoders and stop emitting storage figures. This does not change actor turns, database ownership, runtime migrations or provider support. Hosted probe, connection-budget enforcement and billing implementation remain owned and verified in the private platform repository.

The schema owners are [projects](../../packages/cloud-api/src/projects.ts), [billing](../../packages/cloud-api/src/billing.ts) and the shared [quota error](../../packages/akter/src/errors/actor.ts). The [CLI reference](../api/06-cli.md) defines presentation. [Verification](../verification/customer-postgres-contract.md) distinguishes public contract evidence from hosted behavior.
