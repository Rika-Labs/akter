# v2 — Postgres-native durable actors, with Neki first-class

**Date:** 2026-09-19. **Predecessor:** [v1 archive](../v1/README.md).
**Status:** source-backed feasibility research and proposed direction, not implementation or benchmark evidence.

## Conclusion

**Buildable and worth a focused prototype:** durable identities whose commands atomically mutate ordinary relational rows, record outcomes, and schedule future work. PostgreSQL is the durable authority; actors organize mutation rights rather than own private databases. Neki should be a first-class sharded deployment target with explicitly narrower transaction and read guarantees; its adapter is not yet implemented or verified.

The useful product promise is:

> SQL reads the relational model. An actor command commits its state, receipt, events, and outgoing intents in one database transaction. Delivery and external work may be retried.

The framework, runners, adapters, migrations, and operational tools should be OSS and runnable without a hosted control plane. The complete self-hosted path uses ordinary Postgres. **Neki support does not currently establish that Neki itself can be independently self-hosted.** Reviewed official sources expose a PlanetScale Platform Preview, not a verified downloadable OSS distribution/license. No claim that Neki can never become OSS is intended. [S1–S5]

## Requirements versus recommendations

User requirements: no Cloudflare Durable Objects; first-class Neki and Postgres; OSS; self-hostable.

Recommendations in this document are not settled user decisions. In particular: the exact OSS license, routing key, all-outbox send path, Effect integration boundary, and initial API size remain choices to validate. Preserve the earlier preference for Effect, Bun, Node compatibility, and PGlite, but do not treat untested compatibility as established fact.

“First-class Neki” means designing locality into the first schema, exercising actual multi-shard Neki before freezing that schema, and maintaining the same conformance contract as Postgres. It does **not** mean pretending the two backends have identical global guarantees or waiting until a late M6 milestone to discover incompatibilities.

## What we can and cannot promise

| Capability | Assessment | Boundary |
| --- | --- | --- |
| Durable per-actor commands over Postgres | Feasible | Inbox, receipt, actor rows, and transaction implementation still need proof |
| State + receipt + events + timers + outgoing intents atomic | Feasible | All writes on one transaction connection and one physical shard; not the external effect itself |
| One writer per actor | Feasible | Actor-row lock, generation check, and handoff must participate in the same database authority |
| SQL joins across actor-owned tables | Feasible | Appropriate privileges; costly queries still consume DB capacity |
| Snapshot across multiple SQL reads | Feasible within one Postgres domain | Use an explicit read-only repeatable-read transaction; default read committed is statement-scoped [S6] |
| Single-shard Neki actor turn | Feasible in principle | Colocate every turn-owned row; enforce `__neki.tx_mode = 'single'` [S2–S4] |
| Global Neki snapshot / atomic cross-shard commit | Not supported by reviewed Neki | Cross-shard results can mix points in time; partial commits are possible [S2] |
| Cross-actor sends | Feasible | Durable intent + at-least-once delivery + destination dedupe; not a distributed transaction |
| Durable agents and workflows | Feasible | Model/API calls outside turns, results return through deduplicated commands; cancellation is cooperative |
| Exactly-once external payments, email, or model calls | Cannot promise generically | Provider idempotency and reconciliation are required |
| Millions of stored identities | Plausible, not measured | Stored identities are not resident processes; actual throughput/storage depend on workload |
| Transparent arbitrary concurrent turns for one actor | Exclude initially | Breaks the simple serialization model; declared commutative operations are separate research |
| Self-hosted runtime with no vendor account | Feasible on Postgres | Include migrations, recovery tools, telemetry, and deployment instructions in OSS |
| Self-hosted Neki distribution | Unverified | Obtain source/license/install/support evidence from PlanetScale before claiming it |
| Same multi-process behavior proven by PGlite tests | No | PGlite documents a single exclusive connection [S8] |
| Malicious handler SQL safely sandboxed by actor RLS | No | Mutable session context and privileged SQL require a stronger trust boundary [S7] |

## Smallest coherent architecture

```diagram
┌─────────────────────────────┐
│ Client: command + stable ID │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Bun/Node runner             │
│ Effect services and actors │
└──────────────┬──────────────┘
               ▼
┌──────────────────────────────────────────────────┐
│ PostgreSQL OR one Neki shard for this turn        │
│ inbox · actor fence · business rows · receipt     │
│ events · timers · source-owned outgoing intents   │
│                ONE COMMIT                        │
└──────────────────────┬───────────────────────────┘
                       ▼
┌──────────────────────────────────────────────────┐
│ Post-commit delivery / workers                    │
│ destination inbox dedupe · external activities   │
└──────────────────────────────────────────────────┘
```

Initially one region and one deployment. Runner, timer scanner, relay, and activity executor can share a process; split processes only for measured workload isolation. Do not require Kafka, Redis, a cloud control plane, a separate query store, or Cloudflare infrastructure.

### Transaction contract

1. Accept a command by persisting its inbox record with actor identity, protocol version, stable command ID, and payload digest. Acknowledging acceptance does not claim execution.
2. Begin a turn on one pinned database connection. On Neki set `__neki.tx_mode = 'single'` **before** `BEGIN` on that connection; a setting applied on some other pooled connection is ineffective. Restrict turn reads as well as writes to the supported domain.
3. Lock the actor row, validate the activation generation, and recheck the receipt under serialization. Actor creation and competing first activations also need a race-safe path.
4. Execute short, actor-local database work. No network calls, blocking cross-actor requests, or detached transactional fibers. Do not derive authoritative cross-actor invariants from a world query.
5. Persist state, emitted events, outgoing intents, timers, receipt, and inbox completion in the same transaction. Typed rejection rolls back handler writes to a savepoint and persists a rejection; transient database failures retry the transaction without falsely finalizing it.
6. Publish success only after commit confirmation. If the connection drops during commit, outcome is unknown: retry/query with the **same** command ID and consult the receipt.
7. Post-commit notifications are hints. Durable polling recovers lost notifications. External side effects execute outside the turn and require their own idempotency contract.

Receipt retention limits deduplication. Keep receipt/tombstone retention at least as long as supported retries and pending relay lifetimes; otherwise a very late delivery can execute again. A handler may execute more than once after rollback; only the committed transition is deduplicated.

### Prefer one send path until a fast path earns its complexity

Proposed simplification: every inter-actor send appends a **source-owned outgoing intent**, including same-database sends. A relay inserts the destination inbox with a stable ID, then marks the source intent delivered. Destination commit followed by lost acknowledgement causes a safe duplicate delivery.

This sacrifices immediate same-domain inbox insertion and adds delivery latency/write load. In return, the turn never needs to discover whether two actors happen to share a physical shard, and correctness does not depend on a cached topology during resharding. Measure that tradeoff before adopting it permanently; a same-domain optimization can be added later with separate tests.

Bound relay work and transaction duration. Do not hold a source database transaction open while waiting indefinitely for a remote target, as the historical relay pseudocode does. A short claim transaction with an expiring claim token, delivery outside the transaction, and token-checked completion is a candidate when concurrent relays are needed. Duplicate delivery remains normal even with claims.

Do not promise cross-source FIFO. If source-order delivery is required, store a durable source sequence and enforce it across retries and concurrent relay workers. UUIDv7 and timestamps are not commit order. Timers guarantee eventual eligibility/delivery, not exact wall-clock execution.

## Neki changes the storage design, not the actor API

Neki's router speaks the Postgres protocol, but SQL compatibility does not imply transactional equivalence. The current default transaction mode is `multi`; explicitly opt into `single`. `__neki.fanout` is a useful additional development guard, **not** a replacement for transaction routing. DDL and reference/GSI maintenance have special fanout behavior. [S2–S4]

- Colocate actor metadata, business rows, inbox, receipts, events, timers, and source-owned intents through the same shard index and shard group. A globally placed receipt table would break the turn.
- Choose a canonical identity encoding including actor type and ID (and project if databases are shared). Avoid ambiguous slash concatenation. A shard key must be immutable and present in routed queries.
- Prefer a stable actor-derived routing key as the starting hypothesis. The previous `db_shard = EffectHash(id) % 300` is an optimization proposal, not a correctness requirement. It couples persistent data placement to a compute scheduler and caps routing granularity at a small fixed bucket count. A bucket design is still reasonable if polling measurements justify it; version it independently of Effect internals.
- Neki supports `xxhash`, `modulo`, and `range` indexes. Equal placement requires matching topology, not merely equal-looking column names. Use `EXPLAIN (NEKI_PLAN)` to prove actual routing. [S3]
- Every uniqueness/dedupe invariant needs shard-local enforcement. Explicitly include the routing identity in keys and ensure replies can be located from a request without a global scatter lookup.
- Stock Effect mailbox schemas, global sequence ordering, polls, and reply lookups are not automatically Neki-local. A custom `MessageStorage` adapter is likely; its necessity and scope must be proved with the chosen Effect release.
- Neki sequences exist, but their backing sequence resides on one shard. Avoid making actor locality or ordering depend on them; do not claim Neki categorically lacks sequences. [S3]
- Keep runner registration/placement metadata in an explicit coordination domain if needed. Prefer supported expiring row-lock placement on pooled connections over assuming session advisory locks survive the router. Actor fencing remains separate from placement.
- Native multi-shard DDL is non-atomic. Partial migration status must remain visible and block incompatible code until every required shard is ready. [S2]
- The reviewed preview does not support attaching externally managed Postgres as a migration source; its documented path imports into Neki-managed unsharded storage. Adding a shard column now does not make future migration “only a topology change.” [S4]
- RLS with transaction-local actor context through the Neki router is **unverified**. Neither its absence from the limitations list nor role support proves the exact policy works. Test it before freezing the public write-safety guarantee; do not silently replace enforcement with a development-only parser. [S4, S5]

## Corrections to the older architecture

| Historical claim / choice | v2 correction |
| --- | --- |
| “Any process may read every table in a cell in one snapshot” | Only authorized readers; snapshot scope is one Postgres domain, and isolation must be explicit. A sharded cell is not one snapshot. |
| “No handler runs twice for one message ID” | A rolled-back attempt may run again. Promise at most one committed transition within the dedupe window. |
| RLS makes arbitrary raw SQL safe | Actor-context RLS is a cooperative guardrail, not a hostile-code boundary. A handler with arbitrary SQL can attempt to change that context. |
| World role uses `default_transaction_read_only = on` | Enforce SELECT-only grants and no owner/admin capabilities. A default setting is not a permission boundary. |
| Wrong-actor UPDATE always produces a policy violation | RLS can simply filter rows and return zero affected rows; INSERT/WITH CHECK violations differ. The historical example without WHERE changes the current actor's allowed rows, not necessarily zero rows. [S7] |
| Neki can fall back to a parser if RLS fails | Either prove an equivalent production enforcement mechanism or explicitly narrow the contract; a parser/dev check is not equivalent. |
| PGlite proves production lock behavior | Keep it for fast handler/schema tests; use actual concurrent Postgres connections and independent runners for fencing/failover. |
| Fixed 300 buckets aligned with Effect forever | Make storage topology a deliberate, versioned contract; benchmark polling before coupling it to scheduler internals. |
| Neki comes at M6 | Move multi-shard Neki compatibility to the first technical gate, alongside Postgres. |
| Cell/global control plane, complete console, jobs, cron, blobs all needed initially | Start with the transactional command core and one activity bridge; expand after failure semantics are demonstrated. |
| One retry policy: dead-letter after three defects | Classify domain rejection, transient infrastructure failure, permanent decode/version error, and handler defect. Bound retries without turning a DB outage into mass terminal command failure. |

Additional design hazards: per-type event retention is not implemented simply by dropping monthly partitions containing multiple types; a timestamp added to a partitioned primary key does not itself enforce the intended logical event uniqueness; purging a dedupe row can resurrect an old command. Those require explicit retention protocols, not more product APIs.

Actor ownership must include the type, not just an unqualified ID when types share tables. Fence generation updates must occur through a controlled ownership path; a generation column does not prevent stale processes from continuously reacquiring ownership. An in-flight old turn holding the row lock may finish before the new generation is installed; that is serialized handoff, not an invariant violation.

Restore is not merely “increment incarnation and continue.” A database restored into the past may forget a payment already sent externally. Restore requires relay/worker quiescence, an explicit recovery epoch, and reconciliation with external systems before resuming effects. Backups cannot roll back the outside world.

## Effect is useful, but integration still owns the guarantee

Current source inspection targeted Effect `4.0.0-rc.116` at [this immutable revision](https://github.com/Effect-TS/effect/tree/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5), not the archived `effect-smol` beta. Effect is MIT-licensed; unstable Cluster APIs remain a versioning risk. [S9]

`WithTransaction` wraps handler and reply persistence. SQL transactions propagate through a **per-client transaction service**: constructing two clients with the same URL is not enough to share a transaction. The store and business layer must use the same transaction identity. Runner storage is a separate placement lifecycle, not the authority for atomic business mutations.

**Post-commit reply publication is not yet proven.** Direct inspection of current `MessageStorage.ts` lines 580–599 shows in-memory handlers being invoked after `storage.saveReply`; `SqlMessageStorage.ts` lines 560–569 wraps the persistence in `sql.withTransaction`, which may be nested inside the outer handler transaction. Wrapping the whole handler proves a persistence boundary, not that an in-memory callback cannot escape before outer COMMIT. A preliminary source-review conclusion that publication was automatically safe was therefore not accepted. Trace and fault-test the externally observed response path before shipping. [S9]

Reuse Effect Schema, services/Layers, SQL, and proven Cluster/Workflow components. Do not build a second durable mailbox just because an integration question is unresolved; first prototype transaction propagation, rollback, and publication. Conversely, do not advertise guarantees solely because an upstream annotation has “Transaction” in its name.

## Positioning and product fit

The differentiation is **ordinary relational business tables and actor command durability in the same transaction**, not inventing virtual actors or durable execution. Restate already has single-writer Virtual Objects and documents external database idempotency/versioning integrations; the older “workflow, not actor” comparison is inaccurate. Restate's own object state is K/V, with SQL for inspection rather than transactional mutation. [S10]

Best fits: order lifecycles, inventory reservations per stock item, devices/digital twins, durable agent sessions, and business processes whose ownership naturally fits a key. SQL supports support tooling, discovery, and relational reporting without a mandatory projection service.

Poor fits: applications dominated by arbitrary multi-entity ACID updates, one globally hot actor, globally consistent analytics over many Neki shards, long-running work holding actor locks, or workloads requiring hostile user code to run in-process. A transfer between two account actors needs an explicit reservation/saga protocol or a different aggregate boundary; plain Postgres transactions may be the simpler product when cross-entity atomicity dominates.

## Scope and operating costs

Prototype: actor identity, durable command/receipt, own-row SQL, fence, event append, timer-to-self, outgoing intent, one activity completion bridge, inspection, and restart recovery. First-class Postgres and Neki share these invariants. Keep arbitrary concurrent turns, cross-region actor migration, a hosted control plane, rich console, and a custom workflow language out of the first build.

The old latency/throughput numbers are estimates, not budgets or sales claims. For a strictly serialized hot actor, sustained throughput cannot exceed roughly one divided by mean turn occupancy; adding runners does not parallelize that actor. Benchmark p50/p95/p99 latency, skewed-key load, transaction round trips, SQL/WAL write amplification, mailbox age, relay lag, and recovery time. Neki adds router/shard/HA cost and scatter-query cost; self-hosted Postgres adds backup, upgrades, vacuum, and failover responsibility. No pricing figures were verified here.

License proposal: choose MIT or Apache-2.0 explicitly before publishing code; Apache-2.0 adds an explicit patent grant. Keep required adapters and recovery tools open, retain imported attribution, and make hosted features optional. This research does not apply a license to the repository.

## Evidence and remaining uncertainty

Primary pages below were read on **2026-09-19**. Neki pages were live-refetched; provider preview behavior can change. Sources establish database capabilities and implementation shapes, **not conformance of this unbuilt framework**.

| ID | Primary source | What it supports |
| --- | --- | --- |
| S1 | [Neki overview](https://planetscale.com/docs/neki), [announcement](https://planetscale.com/blog/announcing-neki) | Hosted Platform Preview, no SLA; no verified independent OSS distribution in reviewed sources |
| S2 | [Neki query planning](https://planetscale.com/docs/neki/query-planning) | No shared multi-shard snapshot, non-atomic distributed commit/DDL, `tx_mode`, fanout, routing settings |
| S3 | [Neki data topology](https://planetscale.com/docs/neki/data-topology) | Co-location, supported routing indexes/types, sequence placement, topology propagation |
| S4 | [Neki preview limitations](https://planetscale.com/docs/neki/platform-preview-limitations) | Preview restrictions, no atomic distributed transactions, external migration-source limitation |
| S5 | [Neki roles](https://planetscale.com/docs/neki/connecting/roles) | Branch-scoped roles, least privilege, separate administrative credentials; not proof of actor-context RLS |
| S6 | [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html) | Statement versus transaction snapshots; retries and serializable boundaries |
| S7 | [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | Owner/BYPASSRLS bypasses, USING/WITH CHECK behavior, TRUNCATE/REFERENCES exclusions |
| S8 | [PGlite docs](https://pglite.dev/docs/) | Node/Bun use, persistent local storage, single exclusive connection |
| S9 | [Effect SqlClient](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/sql/SqlClient.ts), [MessageStorage](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/cluster/MessageStorage.ts#L580-L599), [SqlMessageStorage](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/cluster/SqlMessageStorage.ts#L560-L569), [RpcServer](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/rpc/RpcServer.ts#L270-L325), [SqlRunnerStorage](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts), [license](https://github.com/Effect-TS/effect/blob/3d59ae6d5f9ff3e52cb6ed4a9f325320580218d5/LICENSE) | Pinned integration evidence and remaining callback/commit question |
| S10 | [Restate databases guide](https://docs.restate.dev/guides/databases) | Virtual Objects, K/V boundary, external DB patterns and their limitations |

No live Neki database, multi-process runtime, failover experiment, or benchmark was run. No runtime implementation was requested or introduced. [Validation gates](VALIDATION.md) specify what evidence should convert this research into a build commitment.
