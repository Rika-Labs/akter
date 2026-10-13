# ADR 0137: Log and snapshot inspection, audited operator operations and stable telemetry

Status: partially accepted, 2026-10-12 (rewrite/0.2). E7 establishes default-tenant inspect/log/snapshot/replay, audit-before-answer and the telemetry exporter boundary; fork/delete/export and hosted/general-tenant operations retain their owning milestone's gate.

**Responsibility:** decide how operators inspect actors, shards, the log and snapshots, which operator operations exist and how they are authorized and audited, and which telemetry names are stable.

**Owner role:** operations and security.

## Context

0.1 exposes SQL inspection views over its runtime tables, a local inspector page, a live telemetry recorder for the console, operator grants with audited repair, and stable span and metric names ([ADR 0028](0028-sql-inspection-views.md), [ADR 0049](0049-observability-names-metrics-and-defect-spans.md), [ADR 0050](0050-operator-authority-and-audited-repair.md), [ADR 0087](0087-live-runtime-telemetry.md)). With the runtime tables gone, deleting the inspector would silently drop the audit, access and telemetry guarantees; this record restates them over the log, checkpoints and pages.

## Decision

### 1. Operators are a separate principal

An operator is not a `Caller`. Operator calls accept only an operator credential that resolves to an `OperatorGrant { operator, capabilities }`; no application credential or `System` caller converts to a grant. A capability is `{ action, tenant, actorType?, actorId?, commandId? }`, with `tenant` an id or `"*"`. The CLI's implicit bearer token comes only from `AKTER_OPERATOR_TOKEN`; `--token-env` selects another variable explicitly.

| Action          | Allows                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`       | an actor's state, lists, pending timers, jobs and connections; a shard's head, checkpoints and owner; outcome tags without values |
| `outcomes.read` | stored outcomes (success values and declared failures), narrowed by `commandId` when given                                        |
| `log.read`      | segment entries of a shard or actor within retention (`akter log tail`, `akter log export` as NDJSON)                             |
| `snapshot.read` | checkpoint and actor manifests and page contents (`akter snapshot`)                                                               |
| `fork`          | `akter fork` ([ADR 0132](0132-forks-and-retained-history.md))                                                                     |
| `replay`        | starting replay of a refused shard on the current build ([ADR 0133](0133-build-matched-replay.md))                                |
| `delete`        | deleting an actor for erasure ([ADR 0127](0127-snapshots-pages-lists-history-gc.md))                                              |
| `export`        | a seed of an actor's current state and pending work, carrying no tenant, caller or credential                                     |
| `audit.read`    | the audit records                                                                                                                 |

### 2. Every operator operation is audited

- A mutation (`fork`, `replay`, `delete`) writes an `Audit` entry in the same segment as its effect, so both become durable together or neither does.
- A read (`inspect`, `outcomes.read`, `log.read`, `snapshot.read`, `export`, `audit.read`) writes an audit record (`audit/<date>/<id>`, created once) before it answers; a read whose record cannot be written is refused. A refusal by scope is audited as denied.
- An audit record holds the operator, action, capability, target, reason and outcome, never credentials or payload values.

### 3. Inspection reads durable data only

Inspection reads checkpoints, segments and pages, or asks the shard owner for its durable state; it never activates an actor for write and never shows speculative state. `akter dev` gains inspection through the same CLI commands and DevTools; the 0.1 inspector page is removed.

### 4. Stable telemetry

Names use dots; Prometheus exposition replaces `.` with `_`. No metric carries a tenant, actor id or command id. Credentials and payloads are redacted from logs and spans.

| Span                      | Covers                                       |
| ------------------------- | -------------------------------------------- |
| `akter.admission`         | admission on the gateway runner to the reply |
| `akter.<Actor>/<action>`  | one action's execution on the owner          |
| `akter.commit`            | one segment append                           |
| `akter.job/<Actor>/<job>` | one job attempt; steps as child spans        |
| `akter.delivery`          | one cross-shard send or timer firing         |

| Metric                     | Type      | Labels                                    |
| -------------------------- | --------- | ----------------------------------------- |
| `akter.actions`            | counter   | `actor_type`, `outcome`                   |
| `akter.action.duration_ms` | histogram | `actor_type`                              |
| `akter.batch.entries`      | histogram | none                                      |
| `akter.append.duration_ms` | histogram | none                                      |
| `akter.append.ambiguous`   | counter   | none                                      |
| `akter.shard.opens`        | counter   | `reason` (`assigned`, `handoff`, `crash`) |
| `akter.replay.entries`     | histogram | none                                      |
| `akter.page.misses`        | counter   | `actor_type`                              |
| `akter.activations`        | gauge     | `actor_type`                              |
| `akter.jobs`               | counter   | `job`, `outcome`                          |
| `akter.admission.refused`  | counter   | `reason`                                  |
| `akter.gc.deleted`         | counter   | none                                      |

`akter.activations` keeps its 0.1 name and meaning; receipt, outbox, relay, cold-tier, subscription, fleet and pool metrics are removed.

## E7 implementation

`Akter.serve({ operatorAuth })` serves separate `POST /operator` requests; it never asks application `auth` to convert a caller to a grant. Read-only inspection recovers a captured checkpoint-plus-tail position without opening or activating an actor. Scope denial creates a denied audit, and a held or failed create-once audit holds or refuses the answer. Actor inspection returns stored outcome tags and retained rejected-send metadata, not stored outcome values. The separately scoped outcome read honors `commandId`. Snapshot/log data may include state and payload values only under their independent capabilities; telemetry and audit records never carry those values.

Replay appends `Replayed` and `Audit` together as [ADR 0133](0133-build-matched-replay.md) specifies. The CLI uses `effect/cli` and only `AKTER_OPERATOR_TOKEN` implicitly. It permits HTTPS or loopback HTTP, rejects credential-bearing URLs, and can select another credential variable explicitly.

`Telemetry.layer` composes Effect OTLP metrics/traces and DevTools behind one redacting tracer; failed span causes, attributes, links and event data are removed before the exporters. No OTLP logs exporter is installed. Prometheus is opt-in on `Akter.serve`, while local dev enables it on loopback. Page-miss and GC instruments are declared for E6's transitions, not proof that those transitions have landed. [E7 evidence](../verification/e7-find-operators.md) covers real exporter delivery, stable names, redaction and each operator command's allowed/denied/missing-grant path.

## Supersedes and amends

- Supersedes [ADR 0028](0028-sql-inspection-views.md) — scope: in full.
- Supersedes [ADR 0087](0087-live-runtime-telemetry.md) — scope: the receipt-timing recorder and inspector routes; live telemetry is the metrics above.
- Amends [ADR 0048](0048-mint-progress-and-inspection-record-corrections.md): its inspection corrections are historical.
- Amends [ADR 0049](0049-observability-names-metrics-and-defect-spans.md): names carry where the concept survives.
- Amends [ADR 0050](0050-operator-authority-and-audited-repair.md): grants, providers and audit-before-answer carry; repair targets become log, checkpoint and actor operations.
- Amends [ADR 0085](0085-cli-login-and-source-deploys.md): `inspect actor`, `inspect shard`, `log tail`, `log export`, `snapshot`, `fork` and `replay` replace the 0.1 operator commands.

## Alternatives

- **No operator audit for reads.** Rejected: reading stored outcomes and payloads is access to end-user data.
- **Audit records in a database.** Rejected by D18; mutations audit in the log, reads in create-once objects.
- **Keep the local inspector page.** Rejected: CLI commands and DevTools cover `akter dev` with one authorization path.

## Consequences

- Operator reads cost one extra object write each.
- Dashboards built on 0.1 metric names need updating at the swap.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E7        | CLI tests for each command with allowed, out-of-scope and missing grants; audit written before every answer and with every mutation; a crash between a mutation and its audit leaves neither; redaction tests for logs and spans |

## Revisit when

- Cloud's console needs live data these metrics do not cover.
- An audit sink outside the store is required by a compliance regime.
