---
title: "Observability"
description: "Inspect durable actors and shards with audited grants and bounded telemetry."
---

# Observability

Inspect durable state, checkpoints, and the segment log rather than speculative memory. The implemented operator surface is `inspect actor`, `inspect shard`, `log tail`, `log export`, `snapshot`, and `replay` through separate `POST /operator`. [Actor forks](../api/forks.md) use a separately granted server/CLI interface directly over a store, not that HTTP endpoint.

## Grants and audit

Operators are separate from application `Caller` values. Each operation requires its own capability and scope. `inspect` shows outcome tags, not stored values; `outcomes.read`, `log.read`, `snapshot.read`, `fork`, and `replay` are separate grants. Reads create an audit record before answering and fail closed if it cannot be written. Mutations commit their audit entry with their effect. Scope denials are audited too.

Audit records contain the operator, action, capability, target, reason, and outcome, never credentials or payload values. A customer bearer token or an actor's `System` caller is not an operator grant.

## Telemetry names

Stable target spans are `akter.admission`, `akter.<Actor>/<action>`, `akter.commit`, `akter.job/<Actor>/<job>`, and `akter.delivery`. Metrics include `akter.actions`, `akter.action.duration_ms`, `akter.batch.entries`, `akter.append.duration_ms`, `akter.append.ambiguous`, `akter.shard.opens`, `akter.replay.entries`, `akter.page.misses`, `akter.activations`, `akter.jobs`, `akter.job.seconds`, `akter.admission.refused`, and `akter.gc.deleted`.

Prometheus replaces dots with underscores. Metric labels never include tenant, actor id, or command id. Logs and spans redact credentials and payloads. Import `Telemetry` from `@rikalabs/akter/server` and compose `Telemetry.layer({ otlp: { baseUrl, headers? }, devtools: { url? } })`. `Telemetry.prometheus()` returns the body, and `Akter.serve({ prometheus: true, ... })` serves `/metrics`. No OTLP logs exporter is provided. E7 tests exercise grant denial, audit-before-answer, DevTools span delivery, Prometheus/OTLP export, and redaction; they do not certify a hosted provider. [ADR 0137](https://github.com/Rika-Labs/akter/blob/main/docs/decisions/0137-inspection-audited-operations-telemetry.md) defines the names and boundaries.

`Telemetry.usage` reads typed, cumulative per-runner attribution from the live runtime, independently of the Effect process-wide metric registry. Its action count excludes durable declared failures and defects; `akter.actions` retains those diagnostic outcome series. Job seconds round up separately for each local attempt interval. Drain includes optional cumulative `actions` and `jobSeconds` after interrupting attempts. Persist deltas by runner incarnation and reconcile gaps; these counters are not billing authority. See the [server API](../api/01-server-api.md#runner-usage).
