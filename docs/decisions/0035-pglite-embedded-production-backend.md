# ADR 0035: PGlite as an embedded production backend

**Status:** accepted (2026-09-28, Dallen, with every recommended default; proposed 2026-09-28). M4.14 builds it; it needs no migration.

**Responsibility:** decide when file-backed PGlite is a supported production backend, what the framework enforces for it, and which limits it states.

**Authority:** design decision record.

**Owner role:** runtime / platform verification.

**Change policy:** supersede through a new ADR.

## Context

Today PGlite is for tests and development only:

- The [support matrix](../operations/support-matrix.md) says a PGlite cell is never production support, and production PGlite is gated on M4.14. [Vision 06](../vision/06-developer-experience.md) says PGlite in the quickstart is for development only. [ADR 0041](0041-quickstart-scaffolder.md) generates apps on file-backed PGlite for one process per data directory, and says it is not evidence for locking, independent connections, multi-runner behaviour, or process-kill recovery.
- The conformance ledger runs the shared cases on in-memory PGlite and routes contention cases to Postgres, because PGlite has one connection.

What the code does:

- `Database.pglite(config)` (`runtime/database/pglite.ts`) opens `new PGlite(config)`, waits for it, and closes it after in-flight queries settle. `packages/durable-actors` pins `@electric-sql/pglite` at exactly `0.5.8`.
- PGlite's `NodeFS` mounts `dataDir` through Emscripten's `NODEFS` and takes no lock of its own. Checked on 2026-09-28 with PGlite 0.5.8 under Bun: a file-backed instance writes `postmaster.pid` and `PG_VERSION` (`18`), yet a second `new PGlite({ dataDir })` on the same directory, opened in the same process while the first was still open, started and read the first one's committed rows. Nothing stops two runtimes from writing one `dataDir`. PGlite also exposes a `relaxedDurability` option and `dumpDataDir()`, which returns a tarball of the data directory.
- On PGlite, `Actors.layer` keeps Cluster's runner bookkeeping in memory, because `SqlRunnerStorage` would hold PGlite's only connection. Receipts, state, the outbox, and migrations stay in SQL (`runtime/layer.ts`).
- The framework migrator runs at boot on every backend, and refuses a database whose applied ids have gaps it cannot fill ([migrations](../operations/02-migrations.md)).

Many embedded applications want exactly one process with durable state and no database server: a desktop app, a single-node internal service, a command-line tool, or a device at a site with no operations staff. M4.14 ([M4](../milestones/M4.md)) makes that supported, with stated limits: one process per `dataDir` enforced by a lock, a crash-safe `dataDir`, migrations on existing data, backup by a stopped copy or `pg_dump`, and no contention or multi-runner claims.

## Decision

### 1. What "embedded production" means

File-backed PGlite is a supported production backend for **one process** that embeds `Actors.layer` and optionally `Actor.serve`, with its `dataDir` on a local filesystem. Every correctness contract applies unchanged. The support is narrower than Postgres in the ways §6 lists. In-memory PGlite (no `dataDir`) stays a test backend, because nothing survives the process.

### 2. One process per `dataDir`, enforced

- `Database.pglite({ dataDir })` takes an exclusive, non-blocking `flock` on `<dataDir>/.durable-actors.lock` before it opens PGlite, and holds it until the layer's scope closes. It reaches `flock(2)` through `bun:ffi` on Linux and macOS.
- A second process fails at layer build with the typed startup error `DataDirLocked { dataDir }`. It never opens PGlite, so it can't write a byte.
- The kernel releases the lock when the process dies, SIGKILL included, so a crash leaves no stale lock and a restart needs no manual step.
- The lock is advisory. It protects against a second runtime, not against a user copying files by hand. A `dataDir` on a network filesystem, where `flock` isn't reliable, is unsupported. Windows is unsupported until it has its own lock and evidence (open question 2).

### 3. Crash safety

- **Process crash.** A SIGKILL at any point recovers, on the next start, to the last committed transaction. PGlite's `NODEFS` writes WAL through the operating system's `write`, the page cache survives the death of the process, and Postgres crash recovery replays the WAL. That argument needs the evidence in §7 before support is claimed.
- **Operating-system crash or power loss.** Surviving these needs `fsync` to reach the disk through Emscripten's `NODEFS`. It is not claimed. The support matrix records it as unverified until a test proves it (open question 1).
- `Database.pglite` refuses `relaxedDurability: true` together with a `dataDir`, so no option can weaken a commit.

### 4. Migrations on existing data

The framework migrator runs at boot as on Postgres. Each migration runs in one transaction, so a SIGKILL during a migration leaves the database at the previous id, and the next start retries it. Application tables use drizzle-kit migrations, applied through the same client before `Actors.layer` starts.

A core release that upgrades PGlite to a different embedded Postgres major version cannot open an older `dataDir`, because Postgres refuses a `PG_VERSION` mismatch. Before it opens PGlite, `Database.pglite` reads `<dataDir>/PG_VERSION`. A mismatch fails with the typed startup error `DataDirVersion { found, expected }`, which names the dump-and-reload path, instead of PGlite's raw failure. Release notes flag every such upgrade (open question 4).

### 5. Backup and restore

- **Stopped copy.** This is the primary method: stop the process (which releases the lock), copy `dataDir`, and start again. Restore copies the directory back while the process is stopped. A copy taken while the process runs is not a backup.
- **Logical dump (future).** A `pg_dump` taken inside the running process is not a supported method yet. The only `pgDump` build in the lockfile, `@electric-sql/pglite-tools` 0.2.20, targets PGlite 0.3.15, not the pinned 0.5.8, and no build compatible with 0.5.8 has been verified. When one is, it would run on the single connection and block turns while it runs. Until then, the stopped copy is the only backup method.
- The [restore procedure](../operations/04-backup-restore.md) applies unchanged: the command-expiry check before reopening, and reconciling effects the snapshot may have lost. There is no point-in-time recovery.

### 6. Stated limits

| Limit                                                 | Why                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| One process and one runner per `dataDir`              | enforced by §2; runner bookkeeping lives in memory                                  |
| One turn or query on the database at a time           | one connection; throughput is one turn after another, and a long query blocks turns |
| No replicas, read-your-writes, failover, or Neki      | nothing to replicate to                                                             |
| Process-crash durability only                         | §3                                                                                  |
| Local filesystem only; Linux and macOS                | `flock` semantics                                                                   |
| Size up to what the benchmark measured                | the WASM heap bounds working memory; nothing larger is claimed                      |
| No contention, lock-timeout, or multi-runner evidence | the proofs for those stay on Postgres                                               |

## Alternatives rejected

- **A PID file with a liveness check.** A SIGKILL leaves the file behind, PIDs get reused, and two processes starting together can both decide the file is stale.
- **Binding a Unix socket as the lock.** Stale sockets need cleanup that races the same way.
- **Trusting PGlite's `postmaster.pid`.** PGlite 0.5.8 writes it but doesn't honour it (see Context).
- **Claiming power-loss durability by analogy with Postgres.** The I/O path goes through Emscripten, and the claim needs its own evidence.
- **Online `dumpDataDir()` as the backup.** It's a physical tarball tied to one PGlite build, and restoring it across PGlite versions isn't supported.

## Consequences

- Quickstart apps can go to production on PGlite within these limits, and switch to Postgres with `DATABASE_URL` when they outgrow them.
- The PGlite version becomes part of a data compatibility promise. A PGlite upgrade across a Postgres major is a breaking release for embedded users.
- One more platform-specific piece (`flock` through `bun:ffi`) enters the runtime.

## Amendments on acceptance

These landed with the acceptance, as labelled targets until the slice builds them.

**Vision and earlier ADRs.** [Vision 06](../vision/06-developer-experience.md): "PGlite there is for development only" becomes "for development, and for one-process production within the limits of ADR 0035". ADR 0041's "Promise" bullet is superseded in the same way, and its revisit condition fires.

**Contracts.** [09 recovery](../contracts/09-recovery.md) gains process-crash recovery on file-backed PGlite, and the refusal of a second process.

**API.** [Server API](../api/01-server-api.md): `Database.pglite({ dataDir })` takes the lock, and fails with `DataDirLocked` or `DataDirVersion`; it refuses `relaxedDurability` with a `dataDir`.

**Operations.**

- [Support matrix](../operations/support-matrix.md): a new row, "Embedded production (file-backed, one process)", and a replacement for the paragraph saying a PGlite cell is never production support.
- [Deployment](../operations/01-deployment.md): the embedded PGlite shape and its limits.
- [Backup and restore](../operations/04-backup-restore.md): a PGlite section.
- [Runbooks](../operations/runbooks.md): `DataDirLocked`, `DataDirVersion`, and restart after a crash.

**Verification.**

- Conformance: a **PGlite embedded production** gate row, and `conformance/crash/pglite-production.ts` with the cases below. The existing "PGlite in tests" rows are unchanged.
- [Performance](../verification/03-performance.md): turn and wake latency on file-backed PGlite, and the largest measured `dataDir`.

## Migration

None. The lock is a file outside the database, and the checks read `PG_VERSION` before PGlite opens.

## Decided questions

Dallen accepted every recommended default on 2026-09-28.

1. **Power-loss durability.** Decided: not claimed in M4.14; record it as unverified. Rejected alternative: add a test with a failing block device (for example `dm-flakey` in a VM) and claim it if the test passes.
2. **Platforms.** Decided: Linux and macOS, with `flock` through `bun:ffi`. Rejected alternative: add Windows with `LockFileEx`, which needs its own CI runner.
3. **Online backup.** Decided: support only the stopped copy until a `pgDump` build compatible with the pinned PGlite is verified. Rejected alternative: find or build that `pgDump` now, and document that it blocks turns while it runs.
4. **Upgrades across a Postgres major.** Decided: refuse with `DataDirVersion`, and document dump-and-reload using the previous core version. Rejected alternative: ship a `durable pglite upgrade` command that runs both PGlite versions.
5. **Serving from the same process.** Decided: allowed, because it's still one process. Rejected alternative: embedded-only, with no `Actor.serve` on PGlite.

## Evidence required

In `conformance/crash/pglite-production.ts`, with a child process on a file-backed `dataDir`, like `crash/client.test.ts`:

- `recovers the last committed turn after SIGKILL at beforeCommit and afterCommit, and replays its receipt`
- `recovers committed outbox rows and effects after SIGKILL and delivers each once`
- `refuses a second process with DataDirLocked while the first runs, and admits a new process after the first is SIGKILLed`
- `restores a stopped copy and refuses expired command ids after restore`
- `fails with DataDirVersion on a dataDir from another Postgres major`
- `refuses relaxedDurability with a dataDir`

Benchmark: turn and wake latency, and throughput, on file-backed PGlite at several `dataDir` sizes, recorded with the machine and filesystem.

## Revisit when

- PGlite gains a directory lock, multiple connections, or a documented `fsync` guarantee.
- Users need Windows or network filesystems.
- A PGlite upgrade across a Postgres major ships.
