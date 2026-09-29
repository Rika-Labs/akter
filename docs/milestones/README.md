# Milestones

**Responsibility:** index the milestone documents and their delivery order.  
**Authority:** delivery plan.  
**Owner role:** delivery/runtime lead.
**Change policy:** a change requires delivery lead sign-off.

Each milestone owns a vertical slice with explicit non-goals, acceptance tests, evidence, and exit criteria. No later feature is allowed to hide an unproven earlier invariant.

M0's embedded Postgres foundation is complete. M1 is in progress. M2 and M4 are built and closed with the open items listed in their exit status sections, and M3, M5 and M6 are not closed. Provider and recovery gates apply as soon as their feature is introduced. Grouping them under M5 doesn't allow support to be claimed before they pass.

- [M0](M0-foundation.md): framework package skeleton, Postgres runtime, fenced command turns, receipts, `ActorTest`, and database conformance.
- [M1](M1.md): actor members, state, owned tables, blobs, events, intents, timers, effects, server reducers, and retention policies.
- [M2](M2.md): several runners on one database, the multi-runner relay, singletons and cron, workflows with version markers, connections with parking and hibernation, and streams. Also effect cancellation and per-actor effect caps, `turn.mint`, executor progress frames, the design of cross-actor event subscriptions, the two-round-trip turn, turn batches, and the testing base.
- [M3](M3.md): served HTTP, WebSocket, SSE, and OpenAPI; the browser-safe Promise client with optimistic reducers; cross-actor event subscriptions. HTTP serving, the client, and subscriptions start during M2.
- [M4](M4.md): embedded, served, and hosted operations: drain, observability, restore, tenancy, operator authority, a single-region hosted edge, read-your-writes, placement, tenant-scoped content-addressed blobs, and PGlite as an embedded production backend.
- [M5](M5.md): Postgres conformance, Neki suites prepared for [#66](https://github.com/Rika-Labs/durable-actors/issues/66), simulation extensions, and certification of every verification gate.
- [M6](M6.md): adoption of existing Postgres schemas, bounded live-query observation, fleet views, inspection and export, offline clients, generated MCP and language clients, and scale-to-zero serving.
- Later, when hosted usage asks: regional placement and the cold tier. Their ADRs are written in M4; nothing is built until then.
- M7 (withdrawn): the durable agent runtime is Outlast, a separate product ([ADR 0017](../decisions/0017-m1-record-corrections.md)). Features it needs from the framework are scheduled in ordinary milestones only when they are general.
- M8 (gated): generated durable applications with validation, isolation, versioned activation, and rollback ([ADR 0016](../decisions/0016-generated-durable-applications.md)). Nothing in M8 is built until a gate review passes. That review needs:
  - M3 done;
  - the hosted edge from M4;
  - the generated protocols from M6;
  - a sandbox provider that has passed a threat-model review.

  The review checks for reproducible builds, tenant scoping, rollback, and adversarial tests, and it ends in a go or no-go ADR.

## Waves

Delivery runs in waves of parallel slices. Each slice is one pull request or a short stack. A milestone's slices can span several waves, and later milestones' design ADRs start early.

| Wave | Slices                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Close M1: blobs, retention and `examples/chat`, the M1 benchmark pass, the licence and the rename to `@durable-actors/core` (CR.1a), the quickstart (CR.2), and the `0.1.0-alpha` publish (CR.1b)                                                                                   |
| 2    | M2 design ADRs (0020–0023), the multi-runner harness, singleton failover, the statement-count gate, property tests, CI reliability, benchmark coverage, residency, runtime CPU, and the docs site (CR.3), which is docs only                                                        |
| 3    | Multi-runner relay, workflow engine, two-round-trip pipeline, deterministic simulation, `turn.mint`, SQL inspection views (CR.4), the served-protocol ADR (M3.1) and HTTP serving (M3.2), and the ADRs for effect control (0024), `turn.mint` (0025) and event subscriptions (0026) |
| 4    | Cron, workflow compatibility, connections, effect cancellation and per-actor caps, the progress-frames ADR (0030), turn batches, runner-kill and relay-crash drills, the Promise client (M3.4), cross-actor event subscriptions (M3.7), and `examples/orders` (CR.8)                |
| 5    | Commutative merging, executor progress frames, the M2 exit example, observability (M4.3), M4's hosting ADR                                                                                                                                                                          |
| 6    | The rest of M3: WebSocket and SSE, client feeds and optimistic reducers, examples, the `durable dev` inspector (CR.5), `@durable-actors/react` (CR.6), and published performance targets with a Rivet comparison (CR.12)                                                            |
| 7    | M4                                                                                                                                                                                                                                                                                  |
| 8    | M5                                                                                                                                                                                                                                                                                  |
| 9    | M6                                                                                                                                                                                                                                                                                  |

Scale runs, the 72-hour soak, and Neki runs happen on dedicated hardware, outside the waves, in [#66](https://github.com/Rika-Labs/durable-actors/issues/66). No milestone waits on them.

## Developer experience and adoption

From the plan to compete with Rivet. Each slice lives in the milestone of its wave. "CR" numbers are that plan's unit names; the table follows the waves. Deferred without a slot: CR.10 (deploy templates and a Postgres provider and pooler gate), CR.14 (tooling for coding assistants), CR.15 (a serverless design) and CR.16 (a hosted-offer decision). CR.13's Effect guide is part of CR.3.

| Slice | What it adds                                                                                                                                                                                                                                 | Milestone   | Wave |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| CR.1a | Apache-2.0 licence and the rename to `@durable-actors/core`, ADR 0029 ([#90](https://github.com/Rika-Labs/durable-actors/issues/90))                                                                                                         | [M1](M1.md) | 1    |
| CR.1b | Publish `0.1.0-alpha` at M1 close ([#99](https://github.com/Rika-Labs/durable-actors/issues/99))                                                                                                                                             | [M1](M1.md) | 1    |
| CR.7  | M3.1, M3.2 and M3.4 moved ahead of the rest of M2 ([#91](https://github.com/Rika-Labs/durable-actors/issues/91), [#92](https://github.com/Rika-Labs/durable-actors/issues/92), [#93](https://github.com/Rika-Labs/durable-actors/issues/93)) | [M3](M3.md) | 3–4  |
| CR.2  | Quickstart: `create-durable-actors` on file-backed PGlite ([#86](https://github.com/Rika-Labs/durable-actors/issues/86))                                                                                                                     | [M1](M1.md) | 1    |
| CR.3  | Docs site with guides, `llms.txt`, and a comparison page ([#87](https://github.com/Rika-Labs/durable-actors/issues/87))                                                                                                                      | [M2](M2.md) | 2    |
| CR.4  | Read-only SQL views over runtime tables, ADR 0028 ([#88](https://github.com/Rika-Labs/durable-actors/issues/88))                                                                                                                             | [M2](M2.md) | 3    |
| CR.11 | Observability (M4.3) moved to wave 5                                                                                                                                                                                                         | [M4](M4.md) | 5    |
| CR.5  | `durable dev` and a local inspector                                                                                                                                                                                                          | [M3](M3.md) | 6    |
| CR.6  | `@durable-actors/react`                                                                                                                                                                                                                      | [M3](M3.md) | 6    |
| CR.8  | `examples/orders` with a CI crash drill ([#95](https://github.com/Rika-Labs/durable-actors/issues/95))                                                                                                                                       | [M3](M3.md) | 4    |
| CR.12 | Published performance targets with a correctness column, and a public comparison with Rivet                                                                                                                                                  | [M3](M3.md) | 6    |

Decided on 2026-09-26: Apache-2.0; the package is `@durable-actors/core` with `/runtime`, `/testing` and `/client` subpaths, because the unscoped npm name belongs to another publisher; an alpha at M1 close; HTTP serving and the client ahead of the rest of M2; and a public comparison with Rivet after P4 and P5, over a real network, with published methods. The publish waits on the delivery lead creating the `@durable-actors` npm org.

Still waiting on the delivery lead, and not scheduled: **CR.9**, pulling the adoption ADR ([0054](../decisions/0054-existing-schema-adoption.md), accepted) forward to read existing tables inside a turn.

## Testing and performance programmes

These run across milestones. Each milestone document lists the slices it owns.

| Programme                                                                                                                          | Slices                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Multi-runner in-process harness                                                                                                    | M2.1                                                                                                        |
| CI gate on statements per operation                                                                                                | T2 (M2)                                                                                                     |
| Property tests                                                                                                                     | T3 (M2)                                                                                                     |
| CI reliability and process-kill coverage                                                                                           | T4, T4b (M2)                                                                                                |
| A benchmark scenario for every feature, on a cloud VM                                                                              | T5 (M2), then every slice                                                                                   |
| Deterministic simulation (`ActorTest.simulate`)                                                                                    | T6 (M2), M5.4                                                                                               |
| Failure drills for correctness: runner kill and relay crash; Postgres failover                                                     | T7 (M2), T10 (M4)                                                                                           |
| Cloud-VM benchmark passes at milestone close                                                                                       | M1.10, T9 (M3), T15 (M6)                                                                                    |
| Round trips and turn batches                                                                                                       | P1–P6 (M2); two round trips is the target                                                                   |
| [Required scale benchmarks](../verification/03-performance.md#required-scale-benchmarks), 72-hour soak, drills at scale, Neki runs | [#66](https://github.com/Rika-Labs/durable-actors/issues/66), run by the delivery lead; nothing waits on it |

## Reserved numbers

Migrations and ADRs are reserved up front so parallel slices don't collide. Only migrations must follow wave order, because the migrator depends on it; ADR numbers are reservations and may merge out of order.

Migrations follow the wave order, because the Effect migrator skips any id at or below the latest one applied. An "if needed" number that goes unused just leaves a gap, which the migrator allows. A slice that needs a migration it wasn't assigned takes the next number above the highest merged migration. It then renumbers every unmerged reservation above it and updates their issues.

Within a wave, migrations merge in number order. If a higher number is ready first, it is renumbered above the highest merged migration at merge time instead of merging ahead. Until a deployed database exists, a local database that already ran a higher number is recreated.

| Migration                    | Slice                                             | Wave |
| ---------------------------- | ------------------------------------------------- | ---- |
| `0009_blobs`                 | M1.blob actor blobs (merged after `0008_effects`) | 1    |
| `0010_retention`             | M1.9 retention                                    | 1    |
| `0011_relay`                 | M2.4 multi-runner relay                           | 3    |
| `0012_workflows`             | M2.7 workflow engine                              | 3    |
| `0013_inspection_views`      | CR.4 SQL inspection views                         | 3    |
| `0014_connections`           | M2.10 connections                                 | 4    |
| `0015_effect_control`        | M2.13 effect cancellation and per-actor caps      | 4    |
| `0016_final_effect_failures` | #127 final effect failures with retries left      | 4    |
| `0017_subscriptions`         | M3.7 cross-actor event subscriptions              | 4    |
| `0018_rls`                   | M4.5 row-level security                           | 7    |
| `0019` (unused gap)          | M4.9 read-your-writes stores nothing (ADR 0052)   | 7    |
| `0020_content_blobs`         | M4.13 tenant-scoped content-addressed blobs       | 7    |
| `0021_payload_versions`      | M4.7 event and effect payload evolution           | 7    |
| `0022_parent_placement`      | M4.11 parent-actor placement                      | 7    |
| `0023_operator_audit`        | M4.6 operator authority and audited repair        | 7    |
| `0024_adoption`              | M6.1 existing-schema adoption (ADR 0054)          | 9    |
| `0025_fleet`                 | M6.3 fleet views (ADR 0056)                       | 9    |

M2.5 (cron) needs no migration ([ADR 0021](../decisions/0021-multi-runner-relay-singleton-and-cron.md)). M2.15 (`turn.mint`) needed none. M4.7 and M4.11 took `0021_payload_versions` and `0022_parent_placement` when ADRs 0032 and 0033 were accepted, and M4.14 needs none ([ADR 0035](../decisions/0035-pglite-embedded-production-backend.md)).

ADRs 0018 and 0019 belong to the benchmark harness (#38) and runner capacity (#44). The ADRs below are reserved, and unplanned ADRs take 0040 and up.

| ADR                                                   | Subject                                              | Slice |
| ----------------------------------------------------- | ---------------------------------------------------- | ----- |
| 0020                                                  | Two-round-trip turn pipeline                         | P1    |
| 0021                                                  | Multi-runner relay, singleton, and cron              | M2.3  |
| 0022                                                  | Workflow engine storage and version markers          | M2.6  |
| 0023                                                  | Connections, parking, and streams                    | M2.9  |
| 0024                                                  | Effect cancellation and per-actor effect concurrency | M2.12 |
| 0025                                                  | `turn.mint`                                          | M2.14 |
| 0026                                                  | Cross-actor event subscriptions                      | M2.16 |
| 0027                                                  | Served protocol                                      | M3.1  |
| 0028                                                  | SQL inspection views over runtime tables             | CR.4  |
| 0029                                                  | Licence, package name, and release policy            | CR.1a |
| 0030                                                  | Executor progress frames                             | M2.17 |
| 0031                                                  | Hosted ingress, tenant directory, and region design  | M4.1  |
| 0032                                                  | Event and effect payload evolution                   | M4.7  |
| 0033                                                  | Parent-actor placement                               | M4.11 |
| 0034                                                  | Tenant-scoped content-addressed blobs                | M4.13 |
| 0035                                                  | PGlite as an embedded production backend             | M4.14 |
| 0036                                                  | Cold tier                                            | M4.12 |
| 0051                                                  | Optional row-level security                          | M4.5  |
| 0049                                                  | Observability                                        | M4.3  |
| 0050                                                  | Operator authority and audited repair                | M4.6  |
| 0052                                                  | Read-your-writes from replicas                       | M4.9  |
| [0054](../decisions/0054-existing-schema-adoption.md) | Existing-schema adoption                             | M6.1  |
| [0055](../decisions/0055-query-observation.md)        | Query observation                                    | M6.2  |
| [0056](../decisions/0056-fleet-views.md)              | Fleet views                                          | M6.3  |
