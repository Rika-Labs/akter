# Conformance

**Responsibility:** ensure every backend and transport obeys the same contracts.  
**Authority:** evidence.  
**Owner role:** verification.
**Change policy:** a change requires the conformance suite to be updated in the same change.

`durable-actors/testing` MUST export `ActorTest`, `conformance`, and `describeConformance`. The same named cases MUST run against PGlite, real Postgres, and Neki. PGlite is valid for fast/unit coverage; lock contention and true concurrent connection behavior MUST run on real Postgres. A backend is supported only when its applicable cases pass.

Required v4 gates:

| Gate                               | Required evidence                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Neki cross-shard-group transaction | Prove atomic support or use the Neki `actor_outbox` fallback.                                              |
| Neki locking and pinning           | Generation `FOR UPDATE`, single transaction mode, pinned connection, advisory-lock-disabled pool behavior. |
| Railway advertise address          | Replicas reach each advertised private runner address.                                                     |
| PGlite in tests                    | Framework and message-storage DDL/migrations run; contention cases route to Postgres.                      |
| Cluster header size                | Largest supported principal fits envelope headers.                                                         |
| PGlite under Bun                   | Fresh per-layer databases and migrations run under Bun.                                                    |
| In-process multi-runner            | N runners, expiring per-address locks, runner kill, and shard movement after `shardLockExpiration`.        |
| Crash points                       | Before-handler, before-COMMIT, after-COMMIT, and runner death prove rollback/redelivery/receipt replay.    |
| Intent rollback                    | An intent from a before-COMMIT failure is never delivered.                                                 |
| Workflow tenant isolation          | Equal keys in two tenants produce distinct executions; resume restores tenant and `onBehalfOf`.            |
| `waitFor` registration             | Owner event in the start/registration race still resolves the wait.                                        |
| Per-call caller over HTTP          | Different bearer tokens produce different principals; absent credentials are Unauthorized, not Anonymous.  |
| Turn boundary at runtime           | A captured handle called in a turn dies with `Request/reply inside a turn` and rolls back.                 |
| Neki intent relay                  | Relay moves committed `actor_outbox` intents after COMMIT exactly once and recovers after relay crash.     |
| State migration chain              | Seeded old state upcasts and commits current state; invalid chains fail at `Actor.make`.                   |
| Connection park                    | Activation hibernates with sockets open; frame restores state/resumed; broadcast wakes.                    |
| Singleton uniqueness               | Two runners produce one cron tick and one `run`; runner kill moves residency within lock expiry.           |

Each gate MUST link to executable cases or an explicit unsupported result. See [failure matrix](02-failure-matrix.md) and [invariants](invariants.md).
