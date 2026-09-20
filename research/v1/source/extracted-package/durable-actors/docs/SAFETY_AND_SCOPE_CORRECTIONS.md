# Corrections to the exploratory conversation

This document has precedence over earlier informal examples. Those examples described desired APIs; they were not functioning package APIs or verified runtime guarantees.

| Earlier shorthand | Canonical interpretation |
|---|---|
| One atomic turn across SQLite and Postgres | One local SQLite commit for actor data, command receipt, durable reply and outgoing intents; subsequent delivery/acknowledgement is retryable. No distributed transaction is implied. |
| Effect Cluster makes every message durable | Persisted messaging must be explicitly enabled and contract-tested. |
| Single-threaded actor means no races anywhere | It serializes admitted turns for that identity. Stale owners, external systems, read models, concurrent clients and other actors still need explicit rules. |
| Fencing in Postgres solves all storage ownership | A remote writable resource must reject stale authority itself. Postgres-only fencing is insufficient for independently writable Turso databases. |
| A Layer supplies a sibling Layer automatically | `Layer.mergeAll` combines outputs; use dependency wiring such as `Layer.provide` or `Layer.provideMerge` at the correct lifecycle boundary. |
| One global Database Layer | A distinct actor-scoped database service must be acquired for each actor activation; transaction-dependent repositories must not capture the wrong connection. |
| SQL receives complete runtime type safety from a result generic | TypeScript result annotations are not runtime validation. Decode external rows and messages using codecs/Schema. |
| Every SQLite-compatible service supports all required features | Validate transactions, triggers, result encoding and migrations against the exact endpoint and engine version. libSQL and the newer Turso Database engine are distinct. |
| A native Bun SQLite database reproduces Turso production | It is a useful local mode, not a substitute for remote transaction, provisioning and failure tests. |
| Effect Activity is a standalone durable background function | Effect Workflow activities need the workflow engine context; result memoization does not make arbitrary external side effects exactly once. |
| PubSub is a distributed replayable bus | In-process fan-out is ephemeral. Cross-runner delivery and durable replay require separate backing protocols. |
| Actor placement means data is local and faster | A remote Turso client still performs network I/O. Precomputation can help; speed must be measured. |
| Projection makes writes synchronously visible globally | Projection is asynchronous. Source acknowledgements, destination checkpoints and lag must be exposed separately. |
| Events should carry actor ID as every metric label | Actor/message IDs are suitable for controlled logs/traces. Unbounded metric label cardinality is not the default. |
| Shared namespaces isolate untrusted tenants | Prefixing is not authorization. Host/process isolation and capability-restricted credentials are separate requirements. |
| Every actor owns a bucket/cache server | Logical namespaces over shared infrastructure; no dedicated Redis instance or bucket per actor. |
| A Scope is a sandbox | Scope manages resource lifetime, not hostile code confinement. |
| Actor termination rolls back completed side effects | Cancellation is best effort and cannot undo committed external operations. |
| Every schema maps automatically to SQL | Only an explicit supported codec/column subset is safe. Arbitrary transforms, unions and service-dependent schemas require registration or rejection. |
| Skills, projections and agents are all V1 core | Actor correctness comes first. Agents and multi-source/incremental query engines remain later products. |
| Retail unit prices prove gross margins | Full cost includes write/index amplification, provisioning quotas, baseline infrastructure, failed attempts, support and payment fees. |

The dossier favors an opinionated supported assembly with extension seams, not unlimited independently replaceable durability components.
