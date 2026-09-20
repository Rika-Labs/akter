# ADR 021: OTLP with bounded metrics cardinality

Date: 2026-09-17  
Status: Accepted

## Context
Distributed actor recovery needs logical IDs across attempts. Traces/logs and metrics have different cardinality cost models.

## Decision
Use Effect instrumentation and OTLP; actor IDs in traces/logs, bounded dimensions in metrics. Grafana Cloud is pilot evaluation target.

## Alternatives considered
Vendor-specific runtime telemetry traps the framework; logging every payload leaks data and raises costs.

## Consequences and risks
We still build an inspectable receipt/outbox timeline. A DevTools integration is optional.

## Validation and revisit trigger
Revisit backend based on cost and debugging effectiveness; preserve OTLP portability.

## Implementation discipline
This is an architectural decision record, not evidence that the feature exists. Link implementation PRs, exact component versions and gate results here before changing a conditional status to accepted/verified. A conforming adapter must preserve the stated semantics, not merely satisfy TypeScript types.

## Sources
- [OpenTelemetry collector](https://opentelemetry.io/docs/collector/)
- [Grafana Cloud pricing](https://grafana.com/pricing/)
- [Effect v4 API index](https://effect.website/docs/v4/api/effect)
