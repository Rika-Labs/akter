# Observability and debugging

Research date: 2026-09-17. Status: design specification, not implemented runtime behavior.

## Default

Instrument with Effect logging/tracing/metrics and export OTLP. For local development, use an OpenTelemetry Collector and a lightweight console/trace receiver where useful. For the first managed pilot, Grafana Cloud is the default evaluation target for metrics/logs/traces; compare actual ingestion and retention costs before contract. Sentry may cover dashboard exceptions but does not replace structured actor recovery telemetry.

## Correlation

Attach application/environment, actor type/id/incarnation, command ID, causation/root submission, code version, runner, shard and workflow/activity ID to spans/logs where appropriate. High-cardinality actor IDs belong in traces/log fields—not unrestricted metric labels. Metrics should use bounded dimensions such as actor type, environment, result class and operation kind.

## Required metrics

Accepted/committed/rejected command counts; pending age/bytes; actor activation/migration latency; fence rejection; remote DB open/transaction/rollback latency; outbox age; timer lateness; activity unknown outcomes; projection lag/backlog/dead letters; event replay gaps; subscription buffer bytes; provisioning failures; per-tenant quota pressure.

## Operator timeline

An inspection view should join command acceptance, activation, local receipt, outgoing intentions, relay status, projection status and final response without implying one global transaction. Keep logical IDs stable across attempts. Make the difference between 'local commit succeeded' and 'external workflow still running' visible.

## Redaction

Default to metadata-only logging. Never record SQL parameter values, full command payloads, blob content or secrets in telemetry by default. Trace sampling and retention rules differ for normal events versus security/unknown-effect incidents. A debug mode must have explicit access, expiry and audit.

## SLO proposals, not claims

Initial pilot targets: no lost acknowledged command in fault tests; 99.9% monthly control API availability; healthy-region warm command p95 target chosen after benchmark; projection-lag target defined per sink contract, not when the customer's DB is offline. An SLO is not a guarantee until measured and commercially approved.

## Build versus reuse

Investigate Effect DevTools protocol for local traces, but do not couple production recovery tooling to an unstable UI. A small durable submission/outbox inspection API is necessary even if a dashboard later reuses existing tools.

## Sources and evidence

- [E10: Effect v4 API index](https://effect.website/docs/v4/api/effect) — Module availability and unstable import paths. Supplied user export also inspected.
- [A11: OpenTelemetry collector](https://opentelemetry.io/docs/collector/) — OTLP decouples runtime telemetry from vendor; implement cardinality/redaction discipline.
- [A12: Grafana Cloud pricing](https://grafana.com/pricing/) — Managed observability candidate; cost/cardinality constraints apply.
