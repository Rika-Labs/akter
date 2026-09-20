# Durable Actors brief — adversarial review

Reviewed: the Rika Labs "Durable Actors: Product and Architecture Brief" (Sections 1–34 plus 12 attack questions).
Evidence labels: **[V]** verified this session in `effect-ts/effect@main` (4.0.0-rc.115) or official vendor docs; **[A]** prior knowledge, high confidence but not re-checked; **[U]** unknown — needs measurement.

## Verdict: not ready to implement as written; ready after two decisions

The programming model (Sections 4–14, 26–27, 30) is sound and maps almost 1:1 onto Effect Cluster. Two architectural choices undermine it:

1. Putting actor state in Turso while messages live in Postgres *creates* the entire Section 21 recovery protocol — and Cluster already provides a transactional outbox if state lives in its SQL database. Turso is also the wrong substrate for the Section 16 concurrency goal.
2. The V1 surface as specified is no longer differentiated: Rivet shipped `@rivetkit/effect` (beta, 2026‑06‑16) with `Actor.make` / `Action.make` / `toLayer` / typed Schema errors / per-actor SQLite / schedule / broadcast.

## Findings, severity-ordered

### 1. High — The two-store problem is self-inflicted; Cluster already gives you a transactional outbox when state lives in its SQL database [V]

Verified in source:

- `ClusterSchema.WithTransaction` wraps the handler *and* the reply write in one `storage.withTransaction` (`internal/entityManager.ts` L608–617 → `rpc/RpcServer.ts` L288–325: the `onExit` write is attached before `onRequest` wraps it). Handler state writes through the same `SqlClient` commit atomically with Cluster's "receipt" — the `WithExit` row in `cluster_replies`.
- Outgoing persisted sends, `DeliverAt` timers, and `Workflow.execute` (ClusterWorkflowEngine represents workflow runs, activities, deferreds, and clock wake-ups as persisted entity messages) are all `INSERT INTO cluster_messages` through the same `SqlClient` in the calling fiber. Inside a `WithTransaction` handler they commit with the state.
- Redelivery excludes messages that have a `WithExit` reply; `UNIQUE(request_id, kind)` makes a second reply commit fail, which under `WithTransaction` rolls back the duplicate execution's state writes too.

With state in the same Postgres, Section 21 collapses to: **one transaction = state mutation + reply + outgoing sends + timers + activity starts.** No receipts table, no intent relay, no per-actor lazy migrations (one migration set, run once), and no projection relay for V1 (global SQL is SQL on a replica).

Choosing Turso is what manufactures the receipts/outbox/relay machinery: a defense compensating for a boundary you chose. Repair the boundary rather than defend it.

What single-store gives up, honestly: physical per-actor isolation, per-actor export/data residency, storage that scales horizontally by adding databases; one Postgres becomes the ceiling for both messages and state; Section 20's "customer-owned global DB" boundary becomes "state and messages live in one Postgres, yours or ours." Keep Turso as a *provider* behind the state-store boundary for tenants that need those properties — which is exactly the fit Turso's own docs recommend.

Verify [U]: a persisted send from inside a transactional handler runs `saveRequest` in-txn and then notifies the target runner *before* commit; the target may read nothing and fall back to the 10 s `entityMessagePollInterval`. Atomicity holds regardless; the fix, if needed, is a post-commit poke. Decisive test: a `WithTransaction` handler that writes state, sends, schedules, starts a workflow, then fails must leave zero rows anywhere.

### 2. High — Cluster has no fencing token; stale-writer protection must be built by the framework and live in the state store [V]

- Ownership is a hash ring each runner computes locally from `cluster_runners` heartbeats, with leases in `cluster_locks` (`shardLockExpiration` 35 s, refresh ≈10 s) or Postgres advisory locks. On lease loss the runner force-interrupts its entities — after it notices. Between lease expiry and interrupt (plus any event-loop stall) two runners can run the same actor.
- Nothing exposes an epoch: `acquire` returns shard ids, `cluster_locks` has no version column, handler context contains only `CurrentAddress` / `CurrentRunnerAddress` / `KeepAliveLatch` / `Scope`.
- Cluster's only guard is on the reply path (`UNIQUE(request_id, kind)`): persisted messages only, and it does nothing for the lost-update anomaly when two runners run *different* messages of one actor concurrently at READ COMMITTED.

Required design, identical in Postgres or Turso: an `actors(id, generation, turn)` row. Activation: `UPDATE actors SET generation = generation + 1 WHERE id = $id RETURNING generation`. Every command transaction: `UPDATE actors SET turn = turn + 1 WHERE id = $id AND generation = $gen`; zero rows → abort and fail the activation. The row lock also serializes turns across a split brain, so this doubles as the V1 concurrency primitive (Q12 covers how it relaxes later). This is Orleans' ETag pattern [A] applied per actor.

### 3. High — Turso's actual constraints contradict several brief assumptions [V]

- HTTP interactive transactions have a **5‑second window**; connections close after 10 s idle (docs.turso.tech/sdk/http/reference). The "Turso transaction: mutation + receipt + intents" must be one batched request; a turn cannot hold a transaction across awaits.
- **Multi-DB Schemas is deprecated**, and "during a migration, all databases are locked to write operations." Turso now recommends pull-based (lazy) migration — the brief's plan — so the framework owns per-DB schema versions and rolling-deploy skew (a v3 runner activating a DB already at v4 must refuse and release the shard).
- Two engines now: libSQL ("where we started") and Turso Database (recommended for new projects, "early preview" on Turso Cloud). Turso Database's MVCC is documented as experimental: "not production ready," "indexes cannot be created," "all the data is eagerly loaded from disk to memory." Its manual also lists no triggers/views/savepoints. Do not build the Section 16 concurrency model on Turso's concurrent writes.
- `PRAGMA user_version` is read-only and `busy_timeout` unsupported; `@effect/sql-libsql` (4.0.0-beta) exists but "streaming queries are not implemented."
- Pricing is favorable: unlimited databases on paid plans, idle DB = storage only, billing by storage + rows read/written + syncs; free tier 100 DBs.
- [U] Database creation latency via the Platform API and its rate limits — this sits on the first-message path of every new actor. Measure before committing; consider pre-provisioned pools.

### 4. High (strategic) — V1 as specified already exists as Rivet's Effect SDK [V]

`@rivetkit/effect` (beta, 2026‑06‑16): `Actor.make` / `Action.make` with `effect/Schema` payloads, successes and tagged errors; `Counter.toLayer(...)`; `Actor.CurrentAddress`; typed actor-to-actor client with callee errors flowing into the caller's error channel; persisted state as `SubscriptionRef`-like `State`; `Actor.Sleep`; per-actor embedded SQLite "migrated before wake and co-located with the actor"; schedule / broadcast / queues via raw context. Rivet's engine self-hosts on Postgres, filesystem, or FoundationDB and, per Rivet, persists per-actor SQLite via a custom VFS to HA storage — i.e., they already solved the co-located-state problem you are fighting.

Section 32 rightly says identity / sleep-wake / private DB / typed calls are not differentiation. The brief still implicitly leans on "Effect-native typed protocol" as a differentiator; it isn't anymore. What remains defensible is in Q10.

### 5. Medium — `request` durability is undefined, and it decides both latency and the scope of any recovery protocol [V]

Cluster dedup and at-least-once apply only to RPCs annotated `ClusterSchema.Persisted` (default `false`). A persisted request costs ≈3 extra DB round trips — client `saveRequest`, server storage read (latch-triggered, not poll-bound), `saveReply` (folded into the handler transaction under `WithTransaction`); the 200 ms `entityReplyPollInterval` only bites on failover. Volatile requests get no dedup, no redelivery, no ordering. Recommendation: commands persisted, queries volatile. That makes the query/command split carry real semantics, not just intent.

### 6. Medium — Ordering and admission contracts are missing from the brief [V]

- Persisted messages are processed in `rowid` (insert-commit) order with `concurrency: 1`; there is no per-sender FIFO for volatile messages, concurrent senders, or `concurrency > 1`. Publish it: "await the reply before the next send if you need causal order."
- `mailboxCapacity` 4096 in-flight → `MailboxFull`; `maxResidentEntities` 10,000 per runner; `maxIdleTime` 1 minute; redelivery on the *same* runner waits a hard-coded 10‑minute `last_read` claim window. These are user-visible; document or override them.

### 7. Medium — Scheduling and activities are thinner than the brief implies [V]

- `DeliverAt` is a trait on the payload, requires `Persisted`, and is served by the 10 s storage poll: good for "30 minutes," not for sub‑10 s. `DurableClock.sleep` ≤ 60 s is an in-memory sleep.
- `Workflow`, `Activity`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `WorkflowEngine` (with an in-memory layer) and `ClusterWorkflowEngine` exist; activities are at-least-once and must be idempotent. The one missing primitive is "activity completes → message to entity X." That is one generic Workflow: run the Activity, then `client(actorId).Completed(result)` with `primaryKey = executionId`. Roughly 50 lines; do not build an activity subsystem.

### 8. Medium — Sections 15 and 19 describe two read systems; pick one for V1 [V/A]

Replica-served queries require query handlers to run on non-owner runners; Cluster routes every entity message to the owner, so this is a separate stateless RPC path over a replica connection with a consistency token (Postgres LSN or Turso `replication_index`). Projections to a customer DB are a CDC/outbox product. In single-store V1, "read copies" = Postgres read replicas and "global queries" = SQL on the replica; defer projections.

### 9. Low — Agent loops must be workflows, not turns

Section 25 is right that agents are actors, but a model call is external work; by the brief's own Section 13 rule it is an activity. An agent's loop is therefore a Workflow that sends messages to its actor, not a long turn holding the actor's lane.

### 10. Low — Foundation is `effect@4.0.0-rc.115` and everything used is under `unstable/` [V]

Expect churn in cluster/workflow/rpc/sql. Thin wrappers are justified as insulation — re-export Effect types, do not redefine them.

## Answers to the 12 questions

**1. Meaningful improvement or renamed transaction semantics?** Mostly renamed — embrace it. The boundary you describe is a database's serializability domain; the actor adds identity, placement, lifecycle, durable messaging, and encapsulation. Orleans has had reentrancy (`[Reentrant]`, `[AlwaysInterleave]`, `[ReadOnly]`), `[StatelessWorker]` read scaling, and ETag-fenced storage for a decade [A]; Restate has exclusive vs shared handlers [V]; the academic form of your thesis is Shah & Salles, "Reactors: A Case for Predictable, Virtualized Actor Database Systems" (SIGMOD 2018) and "Actor-Relational Database Systems: A Manifesto" (2017), plus Eldeeb & Bernstein's Orleans transactions [A]. The honest, deliverable claim: "an actor's store is a real transactional database, so turns get database-grade isolation without developer-visible locks."

**2. Can automatic concurrent turns be predictable?** Yes, iff the semantics are serializable: each turn behaves as if alone; developers predict outcomes, not latency or abort/retry counts. Anything weaker (commutative merges) is unpredictable unless declared — which is what `Actor.counter` / `Actor.amount` are. RedBlue consistency (Li et al., OSDI 2012) and Sieve (ATC 2014) showed automatic classification works only against developer-stated invariants [A]. Orleans' reentrancy is the cautionary tale: interleaving at await points inside a turn produced subtle bugs. Do not interleave within a turn; run whole turns concurrently under snapshot isolation and retry on conflict. Precondition: turns must be re-executable — DB writes and emitted intents only, no direct external effects. Enforce it with the handler context's types from day one.

**3. Does a private Turso DB per actor support the concurrency and fencing model?** Fencing: yes (generation row + conditional write, one batch). Concurrency: no, today. libSQL is single-writer per database with no snapshot-isolation conflict detection, so the runtime would build MVCC on top; Turso Database's MVCC is experimental. Postgres gives SERIALIZABLE now. Turso is a good *isolation / residency / export* provider, not the concurrency foundation.

**4. Queries/read copies without a second state system?** Compatible if `query` is a pure function of the actor's own tables, served from a replica of the *same* store, with an explicit consistency contract (default eventual, with a read-your-writes token). Incompatible if queries read from separately materialized read models. Enforce purity at the type level: the `query` handler context exposes no write, schedule, or activity capabilities.

**5. Is Postgres-message + Turso-state receipts/outbox sufficient under every crash boundary?** Sufficient only with all of: reply payload stored in the receipt; outgoing intents with deterministic `primaryKey`s derived from the receipt; outbox drained at activation before any new turn; generation fence inside the same Turso transaction; everything in one ≤ 5 s batch; receipt retention ≥ Cluster's redelivery horizon; external effects only inside activities.

| Crash point | With receipts (Turso + Postgres) | Single store (`WithTransaction`) |
|---|---|---|
| before state commit | redeliver, re-run | redeliver, re-run |
| after commit, before intents sent | redeliver → receipt hit → resend (dedup) | n/a: intents committed with state |
| after intents, before Postgres `saveReply` | redeliver → receipt hit → resend → reply | n/a: reply committed with state |
| stale runner overlapping new owner | fence in Turso txn | fence row + `UNIQUE` reply |
| rolling-deploy schema skew | per-DB version check; refuse and release | one migration set, run once |
| non-idempotent external call inside a turn | uncovered | uncovered |

It works. It is also all of Sections 21–22 and half of 24, for a problem the single-store design does not have.

**6. Smallest correct V1 that preserves the migration path?**

```diagram
                 HTTP / CLI / WS   (RpcServer, EntityProxyServer)
                          │
                          ▼
   Actors.get(Order,"123") ── Sharding.makeClient ──▶ Entity "Order" (concurrency: 1)
                                                          │ handler under WithTransaction
                                                          ▼
   ┌────────────────────────── ONE Postgres transaction ──────────────────────────┐
   │ UPDATE actors SET turn = turn+1 WHERE id=$id AND generation=$gen   (fence)  │
   │ actor-scoped tables (actor_id leading PK, injected by the Database service) │
   │ INSERT cluster_messages: sends, DeliverAt timers, ActorActivity workflow    │
   │ INSERT cluster_replies (WithExit)                                            │
   └──────────────────────────────────────────────────────────────────────────────┘
                          │ commit
                          ▼
   post-commit poke to target runners  ·  PubSub broadcast (volatile)
```

Included: `Actor.make` = `Entity.make` + protocol annotations (`Persisted` on commands) + store binding; `query` vs `command` in the types; `ctx` = scoped `Database`, `schedule` (DeliverAt sugar), `activities.start` (one generic Workflow), `broadcast`; `TestRunner` + in-memory `WorkflowEngine` + the pglite SQL driver for tests; an `ActorStateStore` provider interface with a Postgres implementation. Excluded: Turso, receipts/outbox, projections, read replicas, semantic state types, DDL DSL (use `Model.Class` + `Migrator` + SQL).

**7. Which pieces should be direct Effect APIs?** Direct: `Schema`, `Layer`, `Context`, `Stream`, `PubSub`, `Effect.fn`, `Rpc.make` / `RpcGroup` (the protocol *is* an RpcGroup — re-export, don't redefine), `Entity.CurrentAddress`, `SqlClient` / `Model` / `Migrator`, `Workflow` / `Activity` for multi-step external work, `RpcServer` for transports, `TestRunner`. Wrap only where the actor adds meaning: `Actor.make`, `Actors.get` (client + query routing), the handler `ctx`, the state-store provider, the activity-completion bridge.

**8. Where are you rebuilding Cluster / Workflow / EventLog?** Durable messages + dedup + receipts = `Persisted` + `primaryKey` + `cluster_replies`. Timers = `DeliverAt` / `ClusterCron` / `DurableClock`. Activities = `Activity` + `Workflow`. `Actor.protocol` = `RpcGroup`; `Actor.command/query` = `Rpc.make` + annotation; `Actor.toLayer` = `Entity.toLayer`. Half of the `durable-runtime` list (identity, operation identity, causation, telemetry) is `EntityAddress` / `Snowflake` / `MachineId` / trace headers already. EventLog (`effect/unstable/eventlog`) is a client-side offline sync journal — don't use it for actor state, and don't build a journal either; "local history" is a table. `Database.projected()` + relay = CDC; Postgres logical replication and Turso's built-in CDC exist.

**9. Economics at 10⁶–10⁸ actors?** Single store: rows, not databases; 10⁸ actors is a partitioning problem, and the first bottleneck is `cluster_messages` (one table set, `FOR UPDATE` polling per shard; `ShardGroup` exists for partitioning; message/reply retention is [U] — check for a pruning API). Turso: plan limits are gone, but each DB carries SQLite's minimum footprint (≈40–100 KB with a handful of tables and indexes [A]) → 10⁸ actors ≈ 4–10 TB before any data (~$2–5k/month at listed rates — tolerable), plus 10⁸ Platform API creations, per-DB backups, and per-DB migration jobs [U on rate and per-group limits]. Cloudflare DO shows unlimited objects works when the platform owns the storage engine (unlimited objects, 10 GB each, ~1,000 req/s soft limit per object); you would not own it.

**10. Genuinely differentiated vs Rivet / DO / Orleans / Akka / Restate?** Not differentiated: identity, sleep/wake, private SQLite (Rivet, DO), typed Effect actions (Rivet Effect SDK), scheduling, broadcast, activities (Restate, Temporal, DBOS, Cloudflare Workflows), projections (Akka Projections, Kalix Views), regional replication (Akka Replicated Event Sourcing). Defensible if executed: (a) the whole stack is Effect — Cluster / Workflow / RPC / Schema — no engine binary, runs on the Postgres you already have; (b) relational per-actor state with *database-grade* concurrent turns (SSI) rather than single-threaded objects; (c) replica-served relational queries with consistency tokens (Restate's shared handlers run on the owner; Orleans' StatelessWorker is stateless). Restate's true exactly-once comes from a single log — the same lesson as Finding 1.

**11. Can distributed bounded write authority fit the actor abstraction?** The mechanism is proven: escrow (O'Neil 1986), the demarcation protocol (Barbará & Garcia-Molina 1994), bounded counters / Indigo (Balegas et al. 2015) [A]. The mental-model risk is real: `stock.take(2)` can fail locally while global capacity exists, so the API must say "may fail spuriously" or "may wait for a transfer." Fit it *with* actors, not inside the runtime: `Inventory("shoe-42")` as coordinator plus `Inventory("shoe-42")@region` actors holding escrow, with transfers as ordinary deduplicated messages. Each regional actor stays single-writer; no new runtime.

**12. Which decision today most likely blocks the concurrency model?** Three: (a) a state store without snapshot isolation (libSQL) — you would have to build MVCC; (b) turns that perform external effects directly — non-re-executable turns cannot be optimistically retried; (c) in-memory per-activation state as a feature (Rivet-style) — it kills both concurrent turns and replica reads; keep all state in the store. Also fix the ordering contract now (no per-sender FIFO), or developers will depend on V1's accidental serial behavior.

## Next actions, in dependency order

1. Decide the V1 store: Postgres single store behind an `ActorStateStore` boundary (recommended) vs Turso. This rewrites Sections 8, 19–22, 28–30.
2. Prove atomicity: a `WithTransaction` handler that writes state, sends a persisted message, schedules a `DeliverAt`, starts a workflow, then fails must leave zero rows anywhere. Measure send latency with and without a post-commit poke.
3. Prove fencing: two `Sharding` instances with `shardLockDisableAdvisory`, force a lease-expiry overlap, run a read-modify-write turn on both; the `actors.generation` fence must reject exactly one.
4. Measure persisted-request latency on PlanetScale from Railway; set a target (e.g., p50 < 10 ms overhead over volatile).
5. If Turso stays in scope: measure Platform API create latency and rate limits, and a full turn's batched transaction against the 5 s window.
6. Rewrite Section 32 against `@rivetkit/effect` specifically.
