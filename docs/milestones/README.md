# Milestones

**Responsibility:** index the milestone documents and their delivery order.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

Each milestone owns a vertical slice with explicit non-goals, acceptance tests, evidence, and exit criteria. No later feature is allowed to hide an unproven earlier invariant.

M0's embedded Postgres foundation is complete. M1 is in progress, and M2–M6 are planned. Provider and recovery gates apply as soon as their feature is introduced. Grouping them under M5 doesn't allow support to be claimed before they pass.

- [M0](M0-foundation.md): framework package skeleton, Postgres runtime, fenced command turns, receipts, `ActorTest`, and database conformance.
- [M1](M1.md): actor members, state, owned tables, blobs, events, intents, timers, effects, server reducers, and retention policies.
- [M2](M2.md): several runners on one database, the multi-runner relay, singletons and cron, workflows with version markers, connections with parking and hibernation, and streams. Also the two-round-trip turn, turn batches, and the testing base.
- [M3](M3.md): served HTTP, WebSocket, SSE, and OpenAPI; the browser-safe Promise client with optimistic reducers.
- [M4](M4.md): embedded, served, and hosted operations: drain, observability, restore, tenancy, operator authority, the hosted edge, and placement.
- [M5](M5.md): Postgres and Neki conformance, failure drills, the 72-hour soak, scale-out, and certification of every verification gate.
- [M6](M6.md): adoption of existing Postgres schemas, bounded live-query observation, fleet views, inspection and export, offline clients, generated MCP and language clients, and scale-to-zero serving.
- M7 (withdrawn): the durable agent runtime is Outlast, a separate product ([ADR 0017](../decisions/0017-m1-record-corrections.md)). Features it needs from the framework are scheduled in ordinary milestones only when they are general.
- M8 (gated): generated durable applications with validation, isolation, versioned activation, and rollback ([ADR 0016](../decisions/0016-generated-durable-applications.md)). Nothing in M8 is built until a gate review passes. That review needs:
  - M3 done;
  - the hosted edge from M4;
  - the generated protocols from M6;
  - a sandbox provider that has passed a threat-model review.

  The review checks for reproducible builds, tenant scoping, rollback, and adversarial tests, and it ends in a go or no-go ADR.

## Waves

Delivery runs in waves of parallel slices. Each slice is one pull request or a short stack. A milestone's slices can span several waves, and later milestones' design ADRs start early.

| Wave | Slices                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Close M1: blobs, retention and `examples/chat`, the M1 scale run                                                                                                                   |
| 2    | M2 design ADRs (0020–0023), the multi-runner harness, singleton failover, the statement-count gate, property tests, CI reliability, benchmark coverage, residency, and runtime CPU |
| 3    | Multi-runner relay, workflow engine, two-round-trip pipeline, deterministic simulation, M3's protocol ADR                                                                          |
| 4    | Cron, workflow compatibility, connections, turn batches, runner-kill and relay-crash drills                                                                                        |
| 5    | Commutative merging, the one-round-trip fast path, the M2 exit example and scale run, HTTP serving, M4's hosting ADR                                                               |
| 6    | The rest of M3                                                                                                                                                                     |
| 7    | M4                                                                                                                                                                                 |
| 8    | M5                                                                                                                                                                                 |
| 9    | M6                                                                                                                                                                                 |

## Testing and performance programmes

These run across milestones. Each milestone document lists the slices it owns.

| Programme                                                                                                       | Slices                                                |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Multi-runner in-process harness                                                                                 | M2.1                                                  |
| CI gate on statements per operation                                                                             | T2 (M2)                                               |
| Property tests                                                                                                  | T3 (M2)                                               |
| CI reliability and process-kill coverage                                                                        | T4, T4b (M2)                                          |
| A benchmark scenario for every feature                                                                          | T5 (M2), then every slice                             |
| Deterministic simulation (`ActorTest.simulate`)                                                                 | T6 (M2), M5.4                                         |
| Failure drills: runner kill and relay crash; Postgres failover; Neki failover and reshard                       | T7 (M2), T10 (M4), T12 (M5)                           |
| 72-hour soak                                                                                                    | T13 (M5)                                              |
| Scale runs against the [required scale benchmarks](../verification/03-performance.md#required-scale-benchmarks) | M1.10, T8 (M2), T9 (M3), T11 (M4), T14 (M5), T15 (M6) |
| Round trips and turn batches                                                                                    | P1–P7 (M2)                                            |

## Reserved numbers

Migrations and ADRs are reserved up front so parallel slices don't collide.

Migrations follow the wave order, because the Effect migrator skips any id at or below the latest one applied. An "if needed" number that goes unused just leaves a gap, which the migrator allows. A slice that needs a migration it wasn't assigned takes the next number above the highest merged migration. It then renumbers every unmerged reservation above it and updates their issues.

| Migration                | Slice                         | Wave |
| ------------------------ | ----------------------------- | ---- |
| `0010_relay` (if needed) | M2.4 multi-runner relay       | 3    |
| `0011_workflows`         | M2.7 workflow engine          | 3    |
| `0012_cron` (if needed)  | M2.5 cron                     | 4    |
| `0013_connections`       | M2.10 connections             | 4    |
| `0014_rls`               | M4.5 row-level security       | 7    |
| `0015_commit_version`    | M4.9 read-your-writes         | 7    |
| `0016_adoption`          | M6.1 existing-schema adoption | 9    |

M4.7 (payload evolution), M4.11 (parent placement), and M4.12 (cold tier) get a number from their ADR only if they need one.

ADRs 0018 and 0019 belong to the benchmark harness (#38) and runner capacity (#44). The ADRs below are reserved, and unplanned ADRs take 0032 and up.

| ADR  | Subject                                          | Slice |
| ---- | ------------------------------------------------ | ----- |
| 0020 | Two-round-trip turns and an optimistic fast path | P1    |
| 0021 | Multi-runner relay, singleton, and cron          | M2.3  |
| 0022 | Workflow engine storage and version markers      | M2.6  |
| 0023 | Connections, parking, and streams                | M2.9  |
| 0024 | Served protocol                                  | M3.1  |
| 0025 | Hosted ingress, tenant directory, and regions    | M4.1  |
| 0026 | Cold tier                                        | M4.12 |
| 0027 | Parent-actor placement                           | M4.11 |
| 0028 | Event and effect payload evolution               | M4.7  |
| 0029 | Existing-schema adoption                         | M6.1  |
| 0030 | Query observation                                | M6.2  |
| 0031 | Fleet views                                      | M6.3  |
