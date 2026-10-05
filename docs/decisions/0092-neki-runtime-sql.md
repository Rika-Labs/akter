# ADR 0092: Runtime SQL that a Neki router forwards

**Status:** accepted (2026-10-05). The actor runtime's statements run on one live single-shard Neki database; Neki is still not a supported runtime database.

**Responsibility:** record which SQL a Neki router refuses, and how the framework's relay, turn, Cluster and control-plane statements avoid it without changing what they lock, read or write.

**Authority:** implementation decision record; amends [ADR 0057](0057-neki-suite-preparation.md) (the Neki suite's database) and [ADR 0091](0091-neki-control-plane-database.md) (the runtime refusals it left open).

**Owner role:** runtime and control plane.

**Change policy:** supersede through a new ADR.

## Context

With the control plane booting on Neki ([ADR 0091](0091-neki-control-plane-database.md)), the router refused the outbox relay's claims after boot. To find every refusal, not only the first two, the Postgres integration suites of `@rikalabs/akter`, `apps/api`, `apps/edge`, `@akter/deployments`, `@akter/billing` and `@akter/metering` were run against a Postgres server logging every statement. The 4,078 distinct statements were then replayed with their logged parameters on the live `akter-preview` cluster (Neki build `v0.0.0-20261003201000-836aff6f3e3a`, one shard), each inside a rolled-back transaction, on a database migrated by the framework and on one holding the control plane's schema.

What the router did, checked on 2026-10-05:

1. **Logical databases are unsharded.** The data topology lists only the `postgres` database. Every table of a database made with `CREATE DATABASE` is in the `authoritative` shard group, and `EXPLAIN (NEKI_PLAN)` shows one `Route [AnyShard]`.
2. **Router-managed functions force router planning.** The router evaluates `now()`, `statement_timestamp()`, `transaction_timestamp()`, `current_timestamp`, `localtimestamp`, `pg_backend_pid()`, `current_setting()`, `set_config()` and user-defined functions itself. A statement that calls one is planned by the router's own planner, even on an unsharded database. A statement that calls none is forwarded unchanged. Forwarded functions include `clock_timestamp()`, `random()`, `gen_random_uuid()`, `txid_current()`, `pg_current_xact_id()`, `current_database()` and `hashtext()`.
3. **The router's planner refuses** (`NK013`, "not implemented"):
   - `[100]` a subquery in `UPDATE ... RETURNING`, in `UPDATE ... SET` (embedded or correlated), and in an `UPDATE ... FROM` source's `SET` or `WHERE`;
   - `[816]` a data-modifying CTE (any `UPDATE` in a `WITH`);
   - `[967]` a CTE that a nested CTE references more than once;
   - `[107]` an expression it must extract inside `LIMIT`;
   - `[117]` `INSERT ... SELECT ... ON CONFLICT DO UPDATE` (`INSERT ... VALUES ... ON CONFLICT DO UPDATE ... WHERE` runs);
   - `[146]` a router-managed function whose arguments read a column.
4. **Functions the router cannot run at all:** `pg_current_wal_insert_lsn()`, `pg_blocking_pids()` and `pg_stat_clear_snapshot()` (`[200]`), and `pg_logical_slot_peek_binary_changes()` (`[64]`).
5. **Sessions targeted at a shard** (`SET __neki.shard`) refuse every router-managed function, and refuse `EXPLAIN (NEKI_PLAN)`.
6. **Other limits:** one session cannot hold a session advisory lock and a transaction advisory lock at once (`[61]`); temporary tables (`[338]`) and views calling router-managed functions (`[122]`) are refused.
7. **`pg_backend_pid()` is the router's process id.** `pg_locks` reports the shard backend's, so a session cannot find its own advisory locks by pid.

The framework statements that failed:

| Statement                                                                          | Refusal                                                                                   | Cause                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------- |
| Relay claim of due intents, jobs, feed, control and subscription rows (`claimDue`) | `[100]` subquery in `UPDATE RETURNING`                                                    | `statement_timestamp()`                |
| Capped-job group probe (`cappedGroups`)                                            | `[967]` CTE `due` referenced twice                                                        | `statement_timestamp()`                |
| Capped-job group claim (`claimCapped`)                                             | `[107]` expression in `LIMIT`                                                             | `statement_timestamp()`                |
| Subscription feed expansion page                                                   | `[100]` subquery in `UPDATE FROM WHERE`                                                   | `statement_timestamp()`                |
| Subscription subscribe, settle and widen (`changeRows`)                            | `[117]`, `[100]` embedded subquery in `UPDATE SET`, `[100]` subquery in `UPDATE FROM SET` | `statement_timestamp()`                |
| Every turn's commit flight (`COMMIT_VERSION`)                                      | `[200]` `pg_current_wal_insert_lsn`                                                       | the function itself                    |
| Cluster table-lock acquire (`Runner.socket`)                                       | `[117]`                                                                                   | `NOW()` in Effect's `SqlRunnerStorage` |
| API `unpinActor`                                                                   | `[100]` correlated subquery in `UPDATE SET`                                               | `now()`                                |

Statements only the test harness issues (`pg_blocking_pids`, `pg_stat_activity` filters, `pg_stat_clear_snapshot`, `pg_sleep`, test advisory locks) and the logical-decoding fleet views (which the Neki backend does not claim) are left as they are.

## Decision

1. **The outbox clock is read once per statement, from the shard on Neki.** Every statement that compares or sets a due time against the outbox clock lists an `outbox_clock` CTE first, `MATERIALIZED`, and reads `(SELECT ms FROM outbox_clock)` plus the test offset. On Postgres and PGlite the CTE reads `statement_timestamp()`, the value the statements read before. On Neki it reads `clock_timestamp()`, so the router forwards each statement unchanged, and the statements keep their shape: the same CTEs, the same `FOR UPDATE ... SKIP LOCKED` rows, the same single-statement atomicity and the same results.
   - Due times are written by turns and `databaseTime` with `clock_timestamp()` on the shard. The relay now compares them on that same clock, not the router's.
   - The value is read when the statement first needs it, after the statement starts, so a row committed before the claim was sent is still due.
   - This is also the form a shard-targeted session accepts.
2. **A Neki commit reports version 0.** A turn's commit flight reads `NEKI_COMMIT_VERSION`: version `'0'` and the shard's `clock_timestamp()`. The commit version only gates reads on a streaming replica, and a Neki database has none. `Database.postgres({ neki: true, replica })` throws, so a replica can never be trusted with version 0.
3. **Cluster table locks are acquired with `VALUES` on Neki.** When `Database.Neki` is set and Cluster uses table locks, `coordinatedRunnerStorage` replaces only `acquire`. The replacement inserts the same rows as `INSERT ... VALUES ... ON CONFLICT (shard_id) DO UPDATE ... WHERE` held-by-this-runner-or-expired, in the byte order of the shard ids (Cluster's `ORDER BY shard_id COLLATE "C"`). It then reads back the shards this runner holds, bounds the pair by Cluster's lock-operation interval, and fails with `PersistenceError` as Cluster does. Registration, refresh and release stay Cluster's, which Neki runs. Unlike Cluster's own acquire, it runs on the coordination pool rather than Cluster's reserved lock connection.
4. **`unpinActor` reads under the row lock, then writes.** It computes the kept pins with `SELECT ... FOR UPDATE` and writes them with a plain `UPDATE ... RETURNING` in the same transaction. The row is locked from the read to the write, so concurrent pins are not lost, as before.
5. **The Neki suite runs in the database its URL names.** `TEST_NEKI_DATABASE_URL` names an empty database that whoever runs the suite creates and drops, because the router refuses `DROP DATABASE ... WITH (FORCE)`. The first runtime build gets 15 minutes, since a fresh Neki database migrates statement by statement with propagation waits.

## Evidence and limits

The following ran against `akter-preview` on 2026-10-05, each on its own `akter_dev_*` database:

- The Neki conformance suite (`testing/conformance/neki/backend.test.ts`).
- The ADR 0070 Neki migration scenarios (`runtime/database/neki/migrations.test.ts` with `TEST_NEKI_DATABASE_URL`): fresh start, SIGKILL recovery at every boundary, concurrent start and the 0025 → 0026 upgrade.
- A soak: `apps/api` with `CONTROL_PLANE_DATABASE_ENGINE=neki`, booted on a fresh database, driven through sign-up and a deployment create over HTTP while the relay ran.

The Postgres integration suites of the same packages pass unchanged.

These remain unproven:

- A sharded topology. These databases are unsharded, so every statement routes to one shard. On a sharded `actor_data` group, the relay's bucket scans are not keyed by `routing_key`. The router would plan them as scatters, and its planner refuses data-modifying CTEs. Per-shard claims through `__neki.shard` sessions ([ADR 0067](0067-due-work-shard-ranges.md)) accept the forwarded form but are not exercised.
- Advisory-lock Cluster storage, the default for `Actors.layer`, which the API uses. It runs on Neki, but Cluster's lookup of its own locks by `pg_backend_pid()` finds none, so it re-takes them (re-entrantly) on every acquire, and `release` cannot confirm a release. One process is unaffected. Several processes sharing one Neki database should use table locks.
- `Fleet.view`: logical decoding on Neki.
- Multi-shard atomicity.
