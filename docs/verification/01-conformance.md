# Conformance

**Responsibility:** ensure every backend and transport obeys the same contracts.  
**Authority:** evidence.  
**Owner role:** verification.
**Change policy:** a change requires the conformance suite to be updated in the same change.

`durable-actors/testing` MUST export `ActorTest`, `conformance`, and `describeConformance`. The same named cases MUST run against PGlite, real Postgres, and Neki. PGlite is valid for fast/unit coverage; lock contention and true concurrent connection behavior MUST run on real Postgres. A backend is supported only when its applicable cases pass.

## Faithful test boundary

`ActorTest` MUST exercise the real turn, Cluster entity, SQL tables, serialization, receipts, and outbox. There is no handler-only fake-context runtime. Only the database, transport, clock, executor implementations, and caller are substituted. Use production `SqlMessageStorage` on the test transaction connection, not in-memory message storage whose writes could survive a rolled-back turn.

`ActorTest.layer({ as, database, runners, effects })` supplies the test environment. Each layer build owns a fresh tenant; tests use distinct actor IDs or explicitly reset that tenant. Executors are held by default and run, fail, or drain under test control. Bound actor inspection reads committed state without waking an activation; seeding can install old state for migration tests, and the System handle can drive internal commands.

Fault controls cover crash hooks, pause/release, redelivery, stale generations, and Postgres lock contention. `TurnHooks` and `TurnReport` are testing-only exports; production observability uses spans, metrics, and events. In-process multi-runner tests must simulate serialization and give each runner its own message-storage wrapper; they do not substitute for real multi-process Postgres fencing evidence. Effect `TestClock` controls eligible delays, while actual SQL lock behavior is tested on the real backend.

## Design verification gates

The ledger records 17 gate rows below. No executable pass is recorded here: active gates remain **unverified** until linked to actual evidence. The earlier Neki cross-shard alternative is retained for traceability but superseded by the mandatory relay decision in [ADR 0002](../decisions/0002-v4-contract-clarifications.md).

| Gate                               | Required evidence                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neki cross-shard-group transaction | Superseded alternative: the accepted design uses tenant-local `actor_outbox` and the Neki intent relay gate; direct cross-shard writes need a new ADR.                                          |
| Neki locking and pinning           | Generation `FOR UPDATE`, single transaction mode, pinned connection, advisory-lock-disabled pool behavior.                                                                                      |
| Railway advertise address          | Replicas reach each advertised private runner address.                                                                                                                                          |
| PGlite in tests                    | Framework and message-storage DDL/migrations run; contention cases route to Postgres.                                                                                                           |
| Cluster header size                | Largest supported principal fits envelope headers.                                                                                                                                              |
| PGlite under Bun                   | Fresh per-layer databases and migrations run under Bun.                                                                                                                                         |
| In-process multi-runner            | N runners, expiring per-address locks, runner kill, and shard movement after `shardLockExpiration`.                                                                                             |
| Crash points                       | Before-handler, before-COMMIT, after-COMMIT, and runner death prove rollback/redelivery/receipt replay.                                                                                         |
| Intent rollback                    | An intent from a before-COMMIT failure is never delivered.                                                                                                                                      |
| Workflow tenant isolation          | Equal keys in two tenants produce distinct executions; resume restores tenant and `onBehalfOf`.                                                                                                 |
| `waitFor` registration             | Owner event in the start/registration race still resolves the wait.                                                                                                                             |
| Per-call caller over HTTP          | Different bearer tokens produce different principals; absent credentials are Unauthorized, not Anonymous.                                                                                       |
| Turn boundary at runtime           | A captured handle called in a turn dies with `Request/reply inside a turn` and rolls back.                                                                                                      |
| Neki intent relay                  | Crash before/after destination insert and source acknowledgment; retries preserve one logical destination intent and retained receiver outcome.                                                 |
| State migration chain              | Seeded old state upcasts and commits current state; invalid chains fail at `Actor.make`.                                                                                                        |
| Connection park                    | Activation hibernates with sockets open; frame restores state/resumed; broadcast wakes.                                                                                                         |
| Singleton uniqueness               | Two runners produce one logical cron tick and one `run` owner; runner kill moves residency after safe acquisition. Record expiry and resume times separately against the gated recovery target. |

Each gate MUST link to executable cases or an explicit unsupported result. See [failure matrix](02-failure-matrix.md) and [invariants](invariants.md).

Evidence MUST record the revision, test name and command, backend/runtime versions, fault point, durable result, and outcome. A skipped provider test is not a pass, and a typechecked research sketch is not runtime conformance. CI already provisions Postgres; the framework test implementation is still pending.
