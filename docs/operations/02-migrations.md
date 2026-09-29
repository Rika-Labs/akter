# Migrations

**Responsibility:** change runtime and application schemas safely.  
**Authority:** operational.  
**Owner role:** operations/database.
**Change policy:** a change requires operator review when a procedure or limit changes.

## Who owns which schema

| Schema                                            | Changed by                                                                                      | Applied                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Framework tables (`actor_*`, the `durable` views) | the framework's numbered migrations (`runtime/database/migrations.ts`)                          | at boot, by every runtime's `Actors.layer`       |
| Application tables                                | drizzle-kit migrations                                                                          | by the application, before `Actors.layer` starts |
| Keyed actor state in `actor_state`                | the ordered chain in `Actor.state(fields, { migrations })`                                      | by the turn that next loads the actor            |
| Stored event and effect payloads                  | a declared chain per [ADR 0032](../decisions/0032-event-and-effect-payload-evolution.md) (M4.7) | on read                                          |

Separately, `packages/postgres` owns the hosted control-plane schema and `bin/migrate.ts`. The planned `durable migrate` command is not implemented; framework migrations run only at boot.

## How framework migrations run

`Actors.layer` runs Effect's `Migrator` against `actor_migrations` before it registers any actor:

- It applies every registered id above the latest applied one, all in **one transaction** that first takes `ACCESS EXCLUSIVE` on `actor_migrations`. Concurrent runners queue on that lock, and the ones that follow find nothing to apply. A process that dies mid-migration leaves the database at the ids it had, and the next boot applies them again.
- `Migrator` skips an id at or below the latest applied one, so before and after running it the framework refuses to start, with a `MigrationError` of kind `BadState` that names the ids, when a registered id below the latest applied one was never applied. The second check catches a concurrent runner with fewer migrations committing a higher id while this one waited for the lock. Ids may leave gaps for slices that land later, but they must land in id order: a database that applied a higher id first cannot take a lower one and must be restored from before that id or recreated.
- A runtime whose newest id is below the database's applies nothing and starts. So a runner of the previous release keeps starting, and serving, after a newer release migrated the database. Every framework migration must therefore leave the schema usable by the previous release's runtime (see the next section).
- After migrating, startup refuses a database whose recorded protocol or retry window differs from the runtime's, or whose recorded placement of an actor type differs from its declaration. Those values bind stored command ids and routing keys, so changing them needs an explicit migration, never a rolling deploy.

Compressed schema-encoded state migrates lazily: a turn applies the actor's declared chain after it acquires the generation fence and before the handler runs, and commits the current shape on handler success. An unhandled declared failure discards the migration's writes with the rest of the business work while its failure receipt commits. Invalid chains fail at `Actor.make`; decode or upcast defects roll back the whole turn and record the cause in the turn span. A state migration never rewrites actors that are not loaded, so an old shape stays readable for as long as any actor holds it.

## Expand and contract

Use expand and contract whenever old and new runners overlap, which is every rolling deploy. A change that removes or renames anything is two releases:

| Phase    | What happens                                                                                                            | Old runners                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Expand   | add the new column, table, index, or accepted shape; nothing is removed, and new columns are nullable or have a default | keep running unchanged               |
| Deploy   | roll out code that writes the new shape and reads both                                                                  | replaced one runner at a time        |
| Backfill | convert existing rows in bounded batches outside turns                                                                  | none left                            |
| Validate | prove no row still needs the old shape, and add the constraint                                                          | none left                            |
| Contract | in a later release, remove the old column, table, or accepted shape                                                     | none; they cannot read the new shape |

Contract only after both horizons have passed:

- **Runners.** No runner of a release that reads the old shape is left, including one that could restart from an old image.
- **Retained records.** Every record that holds the old shape is gone or rewritten: receipts until their ids expire and `keepReceipts` passes, events until `keepEvents` (and subscribers' holds) pass, pending outbox rows, intents, and effects until they settle, open workflow executions until they finish, and dead letters until they are repaired. A receipt must replay its outcome under newer code, and a pending intent must still decode when a newer runner delivers it.

Take a backup before a contract phase and record it as the rollback boundary. There are no down migrations: before a contract, rolling back is a deploy of the previous release, because the expand left its schema intact; after a contract, rolling back is a [restore](04-backup-restore.md) of the backup taken before it.

### Application tables

A rename of `rooms.title` to `rooms.name`, with drizzle-kit:

1. **Expand.** A migration adds `name text` (nullable). Apply it before the new release starts.
2. **Deploy.** The new release writes both columns in its turns and reads `name`, falling back to `title` while `name` is null. Old runners write only `title`, which the fallback still reads.
3. **Backfill.** Once no old runner is left, copy `title` into `name` in batches by primary-key range, each batch its own short transaction, outside any turn: `UPDATE rooms SET name = title WHERE id > $1 AND id <= $2 AND name IS NULL`. A turn holding a room's row waits at most one batch.
4. **Validate.** Check that no row has `name IS NULL`, then add `CHECK (name IS NOT NULL) NOT VALID` and `VALIDATE CONSTRAINT` it, which scans without blocking writes.
5. **Contract.** A later release stops writing `title` and a migration drops it.

Owned tables keep their owner's key columns, so a backfill never changes which actor owns a row ([contract 06](../contracts/06-storage-ownership.md)). Build large indexes with `CREATE INDEX CONCURRENTLY` in a drizzle migration that runs outside a transaction.

### Framework tables

Framework migrations follow the same phases across framework releases:

- A migration adds tables, nullable columns, columns with constant defaults (which Postgres adds without rewriting the table), and indexes. It never drops or renames anything the previous release reads.
- A migration that must rewrite rows does so for rows that exist when it runs, as `0015_effect_control` fills its new effect columns, and the release's runtime must still accept rows the previous release writes afterwards.
- Every migration runs inside the boot transaction, so it cannot use `CREATE INDEX CONCURRENTLY`. An index on a large table holds its table lock for the build, which blocks turns, and its release notes must say so.
- A contract of a framework column waits for the retained-record horizons above, because receipts, outbox rows, events, and workflow records outlive the release that wrote them.

Nothing is released yet, so framework migrations still carry no compatibility code; these rules bind from the first release that runs beside another ([versioning](../api/versioning.md)).

### Two runtime versions behind one database

During a rolling deploy a runner of the old release and one of the new release serve one database, and an actor's shard moves from one to the other as runners restart. What stays true, and is verified on Postgres by `keeps receipt replay, expiry, and pending intents across two runtime versions behind one database during a rolling deploy` in [`conformance/restore.ts`](../../packages/durable-actors/src/testing/conformance/restore.ts):

- A command id admitted under one version replays its receipt under the other, without running either version's handler.
- An expired id is refused by every runner, before and after a sweep prunes its receipt, because expiry is bound to the id and read from the database clock.
- An intent the old version wrote is delivered once by whichever runner claims it.

What stays per-process: actor policies. A new release that lowers `keepReceipts` can prune a receipt that an old runner's in-flight retry still counts on, so lower it in two releases, or while no retries of old ids are in flight ([retention](retention.md)). The retry window, protocol, and placements cannot differ between versions: startup refuses the runner.

## Hosted and brownfield

Hosted Neki migrations must preserve `routing_key` shard placement and the `actor_outbox` relay, and run in every region of a multi-region deployment. Never assume every actor is awake or that rows on different shards share a transaction.

Future brownfield adoption adds an observe-then-enforce phase for actor-owned legacy tables. Observe mode records direct writes and missing ownership context without changing outcomes. Enforce mode rejects writes that do not carry the trusted actor turn scope. The framework must not claim adoption is complete until direct writers have been removed or explicitly routed through an approved privileged path.

## Before rollout

Test the migration through `@durable-actors/core/testing` against PGlite and Postgres, on a copy of production-shaped data, with a runner of the previous release still serving; run the same conformance cases on Neki when hosted support is affected.
