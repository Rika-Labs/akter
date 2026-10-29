---
title: "Observability"
description: "Inspect durable actors and shards with audited operator grants, and export traces, metrics, and usage."
---

# Observability

Inspect what is durable, not what is in memory: state, checkpoints, and the segment log. This page covers operator access, audit records, and telemetry.

## Operator commands

Operator requests use a separate `POST /operator` endpoint and the [`akter` CLI](../api/06-cli.md#operator-commands): `inspect actor`, `inspect shard`, `log tail`, `log export`, `snapshot`, `replay`, and `retention`. [Forks](../api/forks.md) use a separate interface that opens a store directly.

## Grants and audit

Operators are separate from application callers. Each operation needs its own capability, scoped to a tenant and optionally to an actor type, actor id, or command id:

| Capability                       | Allows                                                                 |
| -------------------------------- | ---------------------------------------------------------------------- |
| `inspect`                        | Actor state, lists, pending work, and outcome tags (not stored values) |
| `outcomes.read`                  | Stored success and failure values                                      |
| `log.read`                       | Retained log entries                                                   |
| `snapshot.read`                  | Checkpoints and pages                                                  |
| `fork`                           | Forking an actor                                                       |
| `replay`                         | Replaying a refused shard                                              |
| `retention.set`                  | Changing store-wide retention                                          |
| `export`, `delete`, `audit.read` | Further grantable actions in the grant model                           |

A customer bearer token and an actor's `System` caller never become an operator grant.

Every read writes an audit record, and denied scopes are audited too. A mutation commits its audit record together with its effect. Audit records contain the operator, action, capability, target, reason, and outcome, and never credentials or payload values.

<Note>
The contract also requires that a read answers only after its audit record is written, and fails closed if it cannot be written. No test covers that ordering yet, so do not rely on it.
</Note>

## Traces and metrics

Import `Telemetry` from `@rikalabs/akter/server` and compose `Telemetry.layer`:

```ts
import { Telemetry } from "@rikalabs/akter/server"

const telemetry = Telemetry.layer({
  otlp: { baseUrl: "https://otel.example", headers: { authorization: "Bearer ..." } },
  devtools: { url: "ws://localhost:34437" },
})
```

OTLP exports traces to `/v1/traces` and metrics to `/v1/metrics` under `baseUrl`. There is no OTLP logs exporter. Logs and spans redact credentials and payloads.

`Akter.serve({ prometheus: true, ... })` serves `/metrics`, and `Telemetry.prometheus()` returns the same text. Prometheus replaces dots in names with underscores.

**Spans:** `akter.admission`, `akter.<Actor>/<command>`, `akter.commit`, `akter.job/<Actor>/<job>`, `akter.delivery`.

**Metrics:** `akter.actions`, `akter.action.duration_ms`, `akter.batch.entries`, `akter.append.duration_ms`, `akter.append.ambiguous`, `akter.shard.opens`, `akter.replay.entries`, `akter.page.misses`, `akter.activations`, `akter.jobs`, `akter.job.seconds`, `akter.admission.refused`, and `akter.gc.deleted`. `akter.actions` and `akter.action.duration_ms` count commands; they keep their 0.2 names so dashboards and alerts keep working.

Metric labels are designed to exclude the tenant, actor id, and command id. Tests check the stable names and labels but not that exclusion.

## Usage counters

`Telemetry.usage` reads cumulative per-runner command and job-second counts from the live runtime. Its command count excludes declared failures and defects, which `akter.actions` still records as diagnostic series. Persist deltas by runner incarnation and reconcile gaps. These counters are attribution, not billing authority. See [Runner usage](../api/01-server-api.md#runner-usage).
