# ADR 0135: Effect primitive inventory

Status: proposed, 2026-10-12 (rewrite/0.2).

**Responsibility:** record which Effect 4.0.3 modules the 0.2 engine uses and for what, which it deliberately does not use, the `effect/eventlog` evaluation, and the version and platform rules.

**Owner role:** runtime architecture.

## Context

Effect is the runtime foundation ([ADR 0121](0121-effect-4-0-3.md)). The engine plan named about 214 Effect modules. Several are marked unstable in 4.0.3 (cluster, reactivity, rpc, workflow, persistence), and some carry assumptions the 0.2 design rejects: Cluster's SQL runner storage takes database-wide advisory locks, its message storage is a second durable store, and its `Singleton` cannot span two releases. D24 keeps Effect Cluster behind Akter's own `Sharding` service for routing, membership, transport and testing, and lists what is not used. D18 removes `effect/sql`.

## Decision

### 1. Used

| Area             | Modules                                                                                                                       | Use                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Routing          | `effect/cluster`: `Sharding`, `ShardingConfig`, `Entity`, `EntityProxy`, `EntityProxyServer`, `EntityAddress`, `ShardId`      | Route an action to its shard owner behind Akter's `Sharding` service; derive the `/rpc` group from actor entities |
| Membership       | `RunnerStorage` implemented on the bucket (`cluster/runners/<id>`, `cluster/assignments`, `If-Match` on ETag)                 | Runner registration and shard assignment; advisory only ([ADR 0126](0126-shard-ownership-on-the-bucket-log.md))   |
| Transport        | `SocketRunner`, `Runners`, `RunnerServer`, `RunnerAddress`, `RunnerHealth` over Akter's kept mTLS peering                     | Runner-to-runner calls on Node and Bun                                                                            |
| Testing          | `TestRunner`, `RpcTest`, `WorkflowEngine.layerMemory`, `TestClock`, `TestSchema`                                              | The simulator and unit tests                                                                                      |
| Wire             | `effect/rpc`: `RpcGroup`, `RpcServer` (WebSocket and HTTP protocols), `RpcClient`, `RpcSerialization` (JSON), `RpcMiddleware` | The one client protocol ([ADR 0130](0130-views-sessions-events-and-rpc.md))                                       |
| Jobs             | `effect/workflow`: `Workflow`, `Activity`, `DurableClock`, `WorkflowEngine` (as `ShardWorkflowEngine`)                        | Jobs journaled on the shard log ([ADR 0129](0129-jobs-timers-and-shard-workflow-engine.md))                       |
| Live reads       | `effect/reactivity`: `Reactivity`; `Schema.toDifferJsonPatch`, `Schema.toEquivalence`                                         | Rerun views on durable change; send patches                                                                       |
| Encoding         | `Schema`, `SchemaBinary`                                                                                                      | Contracts, segments and pages                                                                                     |
| Execution        | `FiberMap`, `Queue`, `Deferred`, `Semaphore`, `RequestResolver`, `Crypto`                                                     | Committer, activations, page batching, digests and derived ids                                                    |
| Observability    | `Tracer`, `Metric`, `Logger`; `effect/observability` OTLP and Prometheus                                                      | Stable telemetry ([ADR 0137](0137-inspection-audited-operations-telemetry.md))                                    |
| CLI and platform | `effect/cli`; `@effect/platform-bun` and `@effect/platform-node` equivalents                                                  | Every `akter` command; every Bun layer has a Node counterpart                                                     |

### 2. Not used

| Module                                                                   | Why                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `effect/sql`, `@effect/sql-pg`, `@effect/sql-pglite`, `SqlRunnerStorage` | No database in the framework (D18)                                                               |
| `MessageStorage` (a no-op layer is provided), `SqlMessageStorage`        | Cluster messages are volatile; the log is the durable store                                      |
| `ClusterWorkflowEngine`, `ClusterCron`, `DeliverAt`                      | Jobs, cron and timers run on the shard log and timer wheel                                       |
| `SingleRunner`, `HttpRunner`                                             | `SingleRunner` wires SQL message storage; runners use sockets                                    |
| `Singleton`                                                              | GC takes a create-once `gc/<epoch>` lease ([ADR 0127](0127-snapshots-pages-lists-history-gc.md)) |
| `HttpApi` derivation, `OpenApi`, Scalar                                  | One RPC protocol (D14); the public Cloud API contract keeps its own `HttpApi`                    |
| `persistence/RateLimiter`, Redis                                         | Quotas are edge admission plus store limits; no Redis in the stack                               |
| `Atom`, `AtomRpc`, `ManagedRuntime` facades                              | React and Promise clients are not in 0.2.0 (D8, D9)                                              |
| `DurableDeferred`, `Workflow.withCompensation`                           | Not exposed to jobs in 0.2.0                                                                     |

### 3. The E1 adapter spike decides the Cluster boundary

If the spike shows that using Cluster for routing, membership and transport needs `Unsafe` or non-exported APIs, or SQL assumptions that cannot be isolated, Akter owns routing, membership and transport (about 1,500–2,000 lines) behind the same `Sharding` interface, and this record is amended with the evidence. The spike records every `Unsafe` API the engine depends on.

### 4. Why not `effect/eventlog`

`effect/eventlog` is a local-first sync system: entry ids are UUIDv7 stamped by the writing client and journals sort by them; concurrent writes reach handlers as conflicts; the SQL server serializes every write in one process behind `Semaphore.make(1)`, publishes through an in-process `PubSub`, never trims, and reports handler failures as `"Persistence failure"`. Akter needs the server to order commands, typed failures, batching per shard, multiple runners and a short log. The engine reuses `SchemaBinary` and `Reactivity` and copies one pattern: subscribers start from a position and see only committed entries. `effect/eventlog` is revisited only for an offline-first client feature.

### 5. Version and platform rules

`effect` and every `@effect/*` package stay pinned at exactly 4.0.3 through 0.2.0 ([ADR 0121](0121-effect-4-0-3.md)). An upgrade moves the whole family together and passes the simulator seed matrix and the bucket-protocol suites first. Node 24+ and Bun 1.4+ are both supported (D6); a Bun-specific layer without a Node counterpart is a defect in the inventory.

## Supersedes and amends

No earlier record is superseded.

- Amends [ADR 0121](0121-effect-4-0-3.md): the exact cohort carries; the SQL packages leave it.
- Amends [ADR 0069](0069-node-runtime.md): every new layer has a Node counterpart with equal failure evidence.

## Alternatives

- **Own routing, membership and transport from the start.** Deferred to the E1 spike's evidence (§3).
- **Use Cluster's SQL storage on a small Postgres.** Rejected by D18.
- **Build the engine on `effect/eventlog`.** Rejected (§4).
- **Float the Effect version.** Rejected: unstable modules change between minor releases.

## Consequences

- The engine depends on unstable modules; exact pins and the seed matrix are the guard.
- `Sharding` is Akter's interface, so replacing Cluster later changes one adapter.

## Evidence

| Milestone | Evidence                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1        | Spike report: `EntityProxy.toRpcGroup` served over WebSocket and HTTP; `RunnerStorage` on the memory store with two runners; `ShardWorkflowEngine` passing `layerMemory` behaviors; the list of `Unsafe` and non-exported APIs used |
| E3        | Multi-runner simulator and MinIO runs with bucket-backed `RunnerStorage` on Node and Bun                                                                                                                                            |

## Revisit when

- Effect publishes a stable Cluster or Workflow API that changes the adapter.
- The spike or later evidence shows Cluster's assumptions leaking into authority.
