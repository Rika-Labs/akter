# ADR 0091: The hosted control plane opts into Neki, and application schema changes follow Neki's DDL rules

**Status:** superseded by [ADR 0112](0112-postgres-and-pglite-only.md) (2026-10-08). The framework Neki option and DDL mode are removed; transactional `Database.schemaChange` remains. The record below is historical.

**Responsibility:** let a production process declare that its database is Neki, and make every schema change the API and edge make at startup visible on Neki.

**Authority:** implementation decision record; amends [ADR 0070](0070-neki-startup-migrations.md)'s propagation barrier.

**Owner role:** runtime and control plane.

**Change policy:** supersede through a new ADR.

## Context

The PR-preview API crashed on boot against a Neki database with `Migrator 3_routing_state ... relation "actor_generations" does not exist`. `apps/api` opened the control-plane database with `Database.postgres({ url })` and no `neki` flag, so the framework ran its transactional migrator. Neki does not show DDL inside the transaction that issued it. `Database.postgres({ neki: true })` existed ([ADR 0070](0070-neki-startup-migrations.md)), but nothing in production set it.

The applications also changed their own schema at startup outside the framework:

- `@akter/postgres` applied its `.sql` files, one multi-statement transaction per file.
- The cloud, billing, metering, email, source, API-key, lifecycle, local-billing and edge quota tables were each created in a transaction holding an advisory lock.
- Better Auth applied its schema through its own pool, one autocommit statement at a time, with nothing waiting for Neki to propagate one statement before the next depended on it.

Checks against the live `akter-preview` cluster (Neki build `v0.0.0-20261003201000-836aff6f3e3a`, one shard) found three things:

1. `__neki.wait_for_ddl()` with no arguments does not exist (`42883`). The function is `wait_for_ddl(schema_version bigint, cluster_version bigint, timeout interval = NULL)`. It blocks until every router has applied that version. `__neki.ddl_versions()` reports the versions the session's own router has applied, and its schema version advances on the same session as soon as DDL there completes. Versions are per database. So ADR 0070's barrier would have failed at its first call.
2. A table created inside `BEGIN` is invisible inside that transaction and does exist after `COMMIT`. A transactional migration whose later statements depend on its earlier DDL therefore fails, which matches the preview crash.
3. `CREATE DATABASE` works for a role that inherits `postgres`. `DROP DATABASE ... WITH (FORCE)` is refused (`permission denied to terminate process`); a plain drop works once its connections close.

## Decision

1. **Declaring Neki.** `Database.postgres({ neki: true })` remains the opt-in for a process that runs actors. `Database.Neki` is the same boolean context reference, public, with default `false`. `postgres({ neki })` provides it. A process that opens its own Postgres client and runs no actors provides it itself.
2. **Application schema changes.** `Database.schemaChange(effect, lock)` (or `effect.pipe(Database.schemaChange(lock))`) runs `effect` on the ambient `SqlClient` while holding advisory lock `lock`.
   - On Postgres, the lock and every statement share one transaction, exactly as each call site did before.
   - On Neki, it reserves one session and takes a session advisory lock. It waits once for DDL that other processes made. Then every statement autocommits on that session, and after each `CREATE`, `ALTER`, `DROP`, `COMMENT`, `GRANT` or `REVOKE` it waits for propagation before the next statement runs.
   - Statements reach the reserved session through the client's transaction-connection service, so call sites keep using the client they already captured.
   - A crash on Neki can leave part of a setup applied, so every statement given to it must be safe to run again. The setup is rerun at every start.
3. **Barrier.** The propagation barrier is `SELECT __neki.wait_for_ddl(v.schema_version, v.cluster_version) FROM __neki.ddl_versions() v`. This replaces ADR 0070's argument-less call for both the framework migrator and `schemaChange`.
4. **Control-plane SQL files.** `@akter/postgres`'s `migrate(url, { startAt?, neki? })` runs each pending file through `schemaChange` under its existing lock key `741902113`, split into statements at semicolons outside quotes and dollar-quoted bodies. The file is recorded only after its last statement. The historical files now use `IF NOT EXISTS`, `OR REPLACE` and `ADD COLUMN IF NOT EXISTS`. On Postgres, files already applied are skipped by name, so this changes nothing there. On Neki, a file interrupted part way through is rerun from its first statement.
5. **Application call sites.** Every startup schema block in `apps/api`, `apps/edge`, `@akter/deployments` (lifecycle tables, under the existing key `hashtext('deployment_rollout_tables')` = `239197811`) and `@akter/billing` (local billing) uses `schemaChange` with its existing lock key. The billing `DO` block, which mixed DDL and an `UPDATE` in one statement, becomes four rerunnable top-level statements. Better Auth's planned statements (`getMigrations(...).compileMigrations()`) run through `schemaChange` instead of its own runner.
6. **Configuration.** `apps/api` and `apps/edge` read `CONTROL_PLANE_DATABASE_ENGINE` (`postgres` by default, or `neki`).
   - The API passes the engine to `migrate` and `Database.postgres`, and the Better Auth, repository, billing, metering, lifecycle, source and API-key setups inherit `Database.Neki` from that layer.
   - The edge provides `Database.Neki` beside its own `PgClient`.
   - `bun run migrate` in `@akter/postgres` reads the same variable.

## Evidence and limits

- `runtime/database/schema.test.ts` runs on real Postgres with a propagation stand-in. It checks that the Postgres path is one transaction (a failure leaves no table), that the Neki path autocommits each statement and waits once at the start and once after each DDL, and that two Neki holders of one lock never interleave.
- The "API schema on" cases in `apps/api/src/server.test.ts` boot the whole API database setup with `CONTROL_PLANE_DATABASE_ENGINE=neki`, sign a user up through Better Auth and check the resulting schema. They cover four cases: a fresh database, a restart, a rerun of every control-plane SQL statement over its own result, and an upgrade from a database a previous release left part way through `0005`.
- The "edge schema on" case in `apps/edge/src/quotas.test.ts` builds the edge's quota schema twice on a fresh migrated database.
- Without `TEST_NEKI_CONTROL_PLANE_URL`, these app tests use Postgres with a stand-in whose barrier refuses to run inside a writing transaction, plus an event trigger that refuses DDL once its transaction has written. With the variable, each case creates and drops its own `akter_dev_` database on that Neki server.
- All of these cases passed against `akter-preview` on 2026-10-05.

The live router also refused the runtime's relay statements after boot: `subqueries in UPDATE RETURNING are not yet supported` and `nested CTE "due" referenced more than once cannot be executed on the router yet`. The control plane's schema now boots on Neki, but its actor runtime does not yet run there. Several things remain unverified on Neki: placement of advisory locks across shards, multi-shard routing, and the SIGKILL and concurrent-start scenarios in ADR 0070.

## Alternatives rejected

- **A separate `Database.neki` constructor.** It would duplicate every pool option of `Database.postgres`, which already carries the flag.
- **Journaling application statements as ADR 0070 does.** Application setup reruns on every start and is idempotent by construction, so rerunning it is its recovery. A journal would add a third history table for no stronger guarantee.
- **Leaving Better Auth's own runner in place.** It autocommits, but nothing makes a later index or foreign key wait for its table on another router.

## Consequences

New startup schema code in the control plane must go through `Database.schemaChange` and be rerunnable statement by statement. It must not use `DO` blocks, and may take `LOCK TABLE` only when `Database.Neki` is false, since a Neki change has no enclosing transaction to hold the lock; the legacy `cloud_command_idempotency` upgrade does exactly that and relies on the schema lock and rerunnable steps on Neki. New control-plane `.sql` files must be idempotent. Postgres deployments keep their transactional behaviour and lock keys.
