# ADR 0054: Existing-schema adoption: `Actor.table(existing, { owner })` and observe-then-enforce

**Status:** accepted (2026-09-30, Dallen; proposed 2026-09-29). It gates M6.1 ([#299](https://github.com/Rika-Labs/durable-actors/issues/299) drafts it) and uses migration `0024_adoption`, which the M6 plan already reserves. It is the first item of [ADR 0014](0014-adoption-observation-and-client-reach.md)'s order. When accepted it amends [contract 06](../contracts/06-storage-ownership.md), [contract 10](../contracts/10-security.md), invariant A4, the [migrations guide](../operations/02-migrations.md), and the [post-foundation sketch](../api/post-foundation-sketches.md).

**Responsibility:** decide how an actor type takes over a table that already exists and is written by other code: how its tenant and actor columns are mapped, how direct legacy writers are measured and then rejected, what `routing_key` means for old rows, and what the runtime refuses at startup.

**Authority:** design decision record.

**Owner role:** database/runtime.

**Change policy:** supersede through a new ADR.

## Context

Foundation tables are greenfield. `Actor.table(source)` in [`tables/owned.ts`](../../packages/durable-actors/src/tables/owned.ts) takes a Drizzle `pgTable` and adds three columns, `routing_key`, `tenant_id`, and `actor_id`, to the Drizzle object. It prefixes every primary key, unique constraint, and index with them, rejects a foreign key, and adds the `durable_tenant` policy. `drizzle-kit` then generates a new table with those columns. Around it:

- **The runtime binds rows to the turn.** `ScopedRows` in [`turn/rows.ts`](../../packages/durable-actors/src/runtime/turn/rows.ts) supplies `routing_key`, `tenant_id`, and `actor_id` from the turn on insert, adds them as predicates to every read, update, and delete, targets upserts at `OWNERSHIP` plus the business primary key, and rejects application-set ownership columns. Application code never writes them.
- **Startup checks the physical table.** `checkTables` dies unless the table's primary key is exactly the three ownership columns followed by the business key. It records one owning actor type per table in `actor_tables` (`0005_tables`), and dies when another type claims it.
- **Writes are only fenced on the framework's paths.** Contract 06 says raw mutation that cannot preserve ownership must be rejected, and invariant A4 says a foreign mutation cannot partially succeed. Both bind statements the runtime builds. Any other connection with `INSERT` or `UPDATE` privilege on the table can write any row. Nothing in the database tells a turn's write from anyone else's.

An existing table, such as `invoices(id, org_id, account_id, …)`, fails all three. It has no `routing_key`, its primary key does not lead with ownership, and it already has an `org_id` and an `account_id` holding the values that a tenant and an actor would have. Its other writers (a web app, a batch job, a second service) keep writing after an actor type starts serving it. Dropping the table into `Actor.table` today would either throw at declaration or fail startup.

`docs/operations/02-migrations.md` already promises "an observe-then-enforce phase," where observe changes no outcome and enforce rejects writes without the trusted turn scope, and that adoption is not claimed complete until direct writers are removed or routed through an approved privileged path. [CR.9](../milestones/README.md) records the wish to read existing tables inside a turn before M6.

Two facts limit what the database can prove. A session setting such as `durable.tenant` can be set by any connection, so it is a scope selector for [row-level security](0051-row-level-security.md), not proof of who is writing. Logical decoding output carries neither the writing role nor `application_name`, so the WAL cannot report legacy writers.

## Decision

### 1. `Actor.table(existing, { owner })` adopts; `Actor.table(source)` is unchanged

```ts
const InvoiceRows = Actor.table(existingInvoices, {
  owner: { tenant: existingInvoices.orgId, actor: existingInvoices.accountId },
})
```

- **`owner` names two existing columns.** `tenant` holds the `TenantId` string and `actor` holds the actor's encoded key. They may have any name, including `tenant_id`. The table is then an _adopted table_. Everywhere else it is an `OwnedTable`: listed in `tables`, read with `rows`, written with the turn's `rows`, and read by `group`. The one-owning-actor-type rule is unchanged, and `actor_tables` records it.
- **The mapped columns are the ownership columns.** The turn supplies both on insert and adds both to every predicate, as it does for `tenant_id` and `actor_id`. Like them, they are absent from `Row` and `Insert` and rejected when the application sets them.
- **The framework adds one column, `routing_key`,** declared in the Drizzle object as a nullable `bigint`, so the application's schema matches the database. `durable adopt observe` adds it with a plain `ADD COLUMN routing_key bigint`, which is cheap and does not rewrite the table, so the application needs no migration of its own for it. Not-null is enforced by a check constraint that `enforce` adds (section 4), not by the column.
- **Nothing else about the table changes.** The primary key, unique constraints, indexes, and foreign keys stay as they are; adoption neither prefixes nor removes them. `Actor.table` still rejects a foreign key on a table declared without `owner`.
- **An insert or upsert whose primary key belongs to another actor fails the turn as a deterministic defect and changes nothing.** The primary key is not led by ownership, so the business key is unique across every actor of the table. An upsert conflicts on the existing key and updates only where ownership matches. Zero affected rows for an input row means the key is another actor's, and the turn dies (A4).
- **An adopted row belongs to an actor whether or not that actor has ever run.** Rows are attached by value: the row whose mapped columns equal `(tenant, actor id)` is that actor's. Adoption creates no `actor_generations` row per legacy row. Actors materialize on their first command, as they do today. A type with a minted id (`policy.createdBy`) cannot adopt a table, because legacy ids were never minted. Startup refuses it.
- **`access: "read"` adopts a table for reading only** (`Actor.table(existing, { owner, access: "read" })`). The table is a `ScopedRead` in turns and queries and has no mutation methods. Legacy code stays its writer, so nothing is observed or enforced, and the framework adds no column and no trigger. Reads predicate on the two mapped columns without `routing_key`, so `group` refuses a read-adopted table, and Neki refuses it until it has a shard-key plan (Q10). This is the smallest step, and the one [CR.9](../milestones/README.md) asks for.

### 2. Which columns can be mapped

The mapped columns must be `text`, `varchar`, or `uuid`, `NOT NULL` before enforcement, with a deterministic collation. A `uuid` column requires the actor's key schema (or the tenant id) to encode canonical lowercase form. Integer, `citext`, and nondeterministic-collation columns are refused at `durable adopt plan`, and `Actor.table` refuses a column whose Drizzle type is not one of these. Ids are opaque canonical strings ([ADR 0010](0010-one-way-effect-native-api.md)). An integer column would let `"042"` and `"42"` name the same rows through two actor ids, so identity would stop being the string.

### 3. Adoption states, recorded in one row per table

Migration `0024_adoption` adds:

- **`actor_adoptions (table_schema, table_name, actor_type, tenant_column, actor_column, mode, writer_role, allowed_roles, revoked, changed_at_ms, changed_by)`,** primary key `(table_schema, table_name)`. `mode` is `observe` or `enforce`. `writer_role` and `allowed_roles` are `NULL` and empty while observing, and `revoked` holds the privileges `enforce` took away, as data, so `release` can give them back. It holds no tenant column, like `actor_tables` and `actor_deployment`, so it carries no `durable_tenant` policy.
- **`actor_adoption_writes (observed_at_ms, table_schema, table_name, operation, session_user_name, application_name, in_turn, allowed, rows)`,** append-only, with an index on `(table_schema, table_name, observed_at_ms)`. It has no tenant column, because a legacy writer's tenant is not known at statement level.
- **Two trigger functions in the runtime's schema:** `actor_adoption_observe()` and `actor_adoption_guard()`. The observe function is `SECURITY DEFINER` with a fixed `search_path`, so a legacy role with no privilege on `actor_adoption_writes` can still have its write recorded.

Neither table has a `durable` view. Their rows name roles and applications across every tenant, and contract 06 requires every view row to carry its tenant. The CLI reads them with its own login.

The states of a writable adopted table are:

1. **Declared.** The table is in an actor type's `tables` with `owner`, but has no `actor_adoptions` row. Startup **refuses** it and names `durable adopt observe`. Adoption is never only in code, because the physical table must gain `routing_key` first. (A `access: "read"` table has no states and no row.)
2. **Observing.** `durable adopt observe <table>` adds `routing_key`, records the row, and installs an `AFTER INSERT OR UPDATE OR DELETE … FOR EACH STATEMENT` trigger with transition tables. Each statement appends one `actor_adoption_writes` row: the operation, `session_user`, `application_name`, and the row count. `in_turn` is true when the transaction carries the `durable.turn` local setting, which the runtime sets in a turn's first statement ([`turn/execute.ts`](../../packages/durable-actors/src/runtime/turn/execute.ts) already sets timeouts there). Observing changes no outcome: legacy writes succeed, and turns may write the table. `in_turn` classifies for the report and is forgeable, so it is not a security boundary.
3. **Enforced.** `durable adopt enforce <table>` (section 4) installs the guard.

### 4. The CLI

Like `durable payloads` and `durable workflows check`, each command takes `--entry <module>` (the actor definitions, so it sees placements and mappings) and `--database-url <url>`. The URL's role must own the table or be able to alter it, and is never the runtime's.

- **`durable adopt plan --entry … --database-url … [--table invoices] [--json]`** changes nothing. It checks each mapping against the catalog (types, nullability, collation), lists incoming and outgoing foreign keys, `ON DELETE CASCADE` and `SET NULL` actions that reach the table, existing triggers, rules, and updatable views, and the table's owner and the roles that can write it. It checks for an index that leads with the mapped columns (`routing_key`, tenant, actor for a writable table; tenant, actor for a read one), because without it every scoped statement scans the table, and prints the `CREATE INDEX CONCURRENTLY` that adds one. It prints the SQL each later step would run.
- **`durable adopt observe invoices`** installs the observing state. **`durable adopt observe invoices --report [--since 7d] [--json]`** reads `actor_adoption_writes` and prints the legacy writers grouped by `(session_user, application_name, operation)` with counts and first and last seen, and separates `in_turn` writes. **`--clear`** deletes the rows it reported.
- **`durable adopt backfill invoices [--batch 1000]`** fills `routing_key` for existing rows, in primary-key batches, each batch its own transaction and resumable after a kill. It uses the runtime's own `routingKey` with the type's recorded placement, so a row's key equals the key of an actor that writes it. It refuses and lists rows whose mapped columns are `NULL` or empty. Rows written after `observe` by legacy code carry no `routing_key`, so the backfill repeats until a pass finds none, and `enforce` refuses while one remains.
- **`durable adopt enforce invoices --writer-role durable_writer [--allow batch_import] [--quiet 7d]`** runs in one transaction with a `lock_timeout` (default 5 s) and refuses unless:
  - `routing_key` is set on every row, and both mapped columns are non-null (it adds the check constraints `NOT VALID`, then validates them);
  - the report shows no legacy write outside `--allow` roles during the last `--quiet` window (default 7 days), and shows that `session_user` never appears both `in_turn` and not;
  - the table's owner is a role that no login is a member of and that is not the writer role, because an owner can disable a trigger and grant privileges back, so an owner that legacy code can act as makes enforcement decorative (`plan` prints the `ALTER TABLE … OWNER TO` for a dedicated `NOLOGIN` role). Being distinct from the writer role also lets [row-level security](0051-row-level-security.md) bind the writer, since Postgres exempts a table's owner from its policies;
  - no login other than the runtime's is a member of `writer_role`, since a member can `SET ROLE` to it;
  - no `ON DELETE CASCADE` or `SET NULL` from another table reaches it. A legacy delete of a parent row would cascade as the owner and be rejected by the guard, so the operator resolves it first.

  Then it revokes `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE` on the table from `PUBLIC` and every other role except `writer_role` and `--allow` roles, and installs the guard: a `BEFORE INSERT OR UPDATE OR DELETE … FOR EACH ROW` trigger and a statement trigger for `TRUNCATE`, both `ENABLE ALWAYS`, taking the writer role, the allowed roles, and the two mapped column names as trigger arguments. It sets `mode` to `enforce`.

- **`durable adopt status`** lists each adopted table, its mode, its unbackfilled row count, and its last legacy write. **`durable adopt release invoices --to observe`** drops the guard and grants back the privileges in `revoked`. No command removes `routing_key` or the catalog row.

### 5. What the guard rejects

The guard function runs for every row change, and:

- **Passes** when `current_user` is `writer_role`, and requires a non-null `routing_key` on the new row. A turn of an actor type with an adopted table takes the writer role in its first statement, next to the timeouts, with `set_config('role', …, true)`. That is the mechanism [ADR 0051](0051-row-level-security.md) uses for its tenant role, and it adds no statement. The runtime's login is a member of the writer role and holds no write privilege of its own.
- **Passes a role in `allowed_roles` and records it** in `actor_adoption_writes` with `allowed = true`. That is the approved privileged path in [the migrations guide](../operations/02-migrations.md). It still requires non-null ownership and `routing_key`. Adoption is complete when this list is empty. `status` prints it, and the docs do not call an adopted table authoritative while it is not.
- **Rejects everything else** with `42501` naming the table and the actor type that owns it. That covers a second pool on the runtime's own login and raw SQL outside a turn, which both run as the login and not as the writer role. It also covers `COPY`, a write through an updatable view, a `SECURITY DEFINER` function owned by another role (its `current_user` is its owner), and `TRUNCATE`.
- **Rejects any change to either mapped column on `UPDATE`,** whoever runs it, `--allow` roles included. A row cannot move to another actor.

With privileges revoked, most rejected writes fail earlier with `permission denied`. The trigger is the net for the table owner and for grants added later.

The limit is `SET ROLE`. Code that holds the runtime's credentials can take the writer role as a turn does. `enforce` checks that nobody else can, and does not claim to stop the runtime's own login (Q9).

### 6. Startup

`checkTables` gets a second branch for adopted tables. It replaces the primary-key prefix check with:

- an `actor_adoptions` row exists, with the type, table, and mapped columns matching the declaration;
- `routing_key` exists and has the declared type;
- in `enforce`, the guard triggers exist with `tgenabled = 'A'` and arguments equal to the recorded ones, no other role has write privileges except `--allow` roles, the writer role exists, this login can take it, and it can read and write every framework and owned table without owning one;
- an index leads with the mapped columns (section 4);
- the actor type's placement equals the placement recorded in `actor_placements`, which already fails startup on a change.

Each refusal names the object and the fix, like [ADR 0051](0051-row-level-security.md) section 3. The check runs when the layer registers the type, so it covers every runner.

### 7. Turn-side changes

`Ownership` (`tables/owned.ts`) gains the column names for tenant and actor, and `rows.ts` uses them wherever it uses the fixed `tenant_id` and `actor_id` today. It also changes the upsert path in section 1. The row statements add no round trip.

The writer role is one runtime option, `adoption: { role }`, beside `rowLevelSecurity`. When both are set they must name the same role, which startup checks, because a turn takes one role. The RLS tenant role then also holds the write privileges and the guard's pass. Otherwise a type with an adopted table in `enforce` adds only the role to the settings statement and the trigger's own work in the database. Because the whole turn runs as that role, it needs `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on every framework table and every owned table, and must not own them, exactly as ADR 0051's role does. `plan` prints the grants, and the startup check in section 6 verifies them. A `durable_tenant` policy on an adopted table is written against the mapped tenant column, cast to text when it is not text (`checkOwnedTable` already looks for the policy by name). It is opt-in, as Q7 says.

## Open questions and recommended defaults

**Q1. Which key column types are mapped?** Default: `text`, `varchar`, and `uuid` (section 2). Integer keys need a canonical text form in the key schema first, so a later ADR can add them.

**Q2. Where does `routing_key` live?** Default: a real nullable column the CLI adds and backfills, checked non-null by a constraint at `enforce`. The invariant that every actor-owned row carries its framework-computed routing key stays whole. Rejected: no column on plain Postgres, computed only when a Neki shard is added, which would leave a later migration of the same size on the largest tables.

**Q3. Foreign keys on adopted tables?** Default: outgoing and incoming foreign keys stay, because refusing them would refuse most brownfield tables. `plan` lists them, and `enforce` refuses only cascades and `SET NULL` reaching the table (section 4). [ADR 0006](0006-scale-rules-placement-and-query-tiers.md)'s multixact warning against foreign keys from high-volume actor tables to shared parents is printed as a warning, not an error.

**Q4. May a privileged path remain?** Default: yes, as `--allow <role>`. Its writes are recorded and listed in `status`, and it must still supply ownership and `routing_key`. Rejected: no exceptions, which would force every batch job to become an actor before adoption can finish.

**Q5. How is observation stored and pruned?** Default: one append-only row per statement, no sampling, never pruned by the runtime, deleted by `--clear`. Rejected: counters keyed by minute, updated with `ON CONFLICT`, because concurrent legacy writers would then queue on one row inside their own transactions, the kind of database-wide serialization point [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) prohibits. The cost of one insert per legacy statement is measured (Evidence).

**Q6. How long must the table be quiet before `enforce`?** Default: seven days, adjustable with `--quiet` (for example `--quiet 1d`), which is explicit in the command. Rejected: `--force`, which would let an operator enforce while known writers still run and turn the report into a suggestion.

**Q7. Does adoption turn on row-level security?** Default: no. A policy would hide the table from every legacy reader that sets no `durable.tenant`. RLS on adopted tables is a separate, opt-in step (`durable adopt rls`) that a later ADR can add on [ADR 0051](0051-row-level-security.md)'s policy.

**Q8. May turns write an adopted table while it is only observed?** Default: yes. Observing changes no outcome (section 3). The actor is not authoritative until `enforce`, and the docs say so.

**Q9. Is one login shared by the app and the runtime supported?** Default: observe only. `enforce` refuses when the report shows one `session_user` both in and out of turns (section 4), because a login that can act as the runtime can take the writer role and do whatever the runtime does (section 5). A token that the runtime sets per turn and a trigger verifies would raise that bar, but it depends on a secret held in the runtime's memory and configuration, and this ADR does not claim it. Revisit if brownfield users cannot separate logins.

**Q10. Neki?** Default: no claim. The backfill and `CREATE`/`ALTER` steps run per shard, and the guard is per shard, but only provider-specific evidence can support it ([AGENTS.md](../../AGENTS.md)).

**Q11. Does read-only adoption ship first?** Default: yes. `access: "read"` (section 1) needs the mapping check, the index check, and no trigger, column, or migration step, so it can land before observe and enforce and unblocks reading existing tables inside a turn. Scheduling it ahead of the rest of M6.1 remains the delivery lead's call, as [the milestone index](../milestones/README.md) says for CR.9.

## Alternatives

- **Greenfield only.** Rejected by ADR 0014: it removes the strongest Postgres wedge.
- **A shadow table plus dual writes or CDC sync.** Rejected: two sources of truth for one fact, and the legacy writer still wins races the actor cannot see.
- **A session-setting or role-only guard.** A setting can be set by any connection on the login. A role check alone does not bind the owner, which is often the application's own login. Hence the owner condition and the always-enabled trigger.
- **Row-level security as the guard.** It confines rows by tenant, not writers, and exempts the table owner. It is orthogonal, and Q7 keeps it separate.
- **Observing from the WAL.** Decoded changes name neither the role nor `application_name`, so the report could not name writers.
- **Rename the table and give legacy code an updatable view.** It would break their DDL, their ORMs' schemas, and their permissions, on the one path this ADR must leave working until enforcement.
- **Maintaining `routing_key` with a generated column.** Bun's xxHash3 is not a SQL function, and a second implementation in SQL would fork every stored key if the two ever differed.

## Consequences

- An application can put an actor in front of a table it already has, keep its readers unchanged, find every writer that bypasses the actor, and then make the database refuse them, with the one-way API intact. Adoption adds no new mutation primitive.
- Observation costs each legacy statement one indexed insert in its own transaction. Enforcement costs each row change a trigger function call, for actor writes too. Both are measured.
- Enforcement needs credential separation and an owner legacy code cannot act as. The runtime says so when it refuses, and the docs state that a superuser can drop the guard and nothing in the database stops that ([contract 10](../contracts/10-security.md)'s trust model is unchanged).
- Business keys stay unique across actors, unlike owned tables. A collision fails loudly, never silently updates another actor's row.
- An enforced table's owner becomes a role that no login is a member of, so its schema changes run through an operator who can take that role, or after `durable adopt release --to observe`. That is the price of a guard the owner cannot remove.
- `Actor.table` gains a second call form, and `Ownership` no longer assumes column names. The rest of `rows.ts` follows from that.

## Evidence

`conformance/adoption.ts` runs on real Postgres, with the cases that need independent connections or roles (rule 33) marked, and on PGlite where they don't. It fails when the mechanism it names is removed:

- `maps existing tenant and actor columns, reads only the actor's rows, and never shows another tenant's or actor's rows for the same business key`;
- `a read-adopted table is readable in a turn and a query, has no mutation methods, and is refused by group`;
- `refuses an unsupported mapping: an integer or citext column, a missing column, one column mapped twice, a minted-id actor type`;
- `refuses startup when an adopted table has no actor_adoptions row`;
- `observing records a second pool's writes by role, application_name, operation and rows, classes the turn's writes in_turn, and changes no outcome` (Postgres);
- `backfill matches routingKey for every placement, resumes after a SIGKILL between batches, and lists rows with NULL mapped columns` (Postgres, real kill);
- `enforce refuses: unbackfilled rows, a legacy write inside the quiet window, a session_user seen both in and out of turns, an owner the legacy role can act as, and an incoming cascade`;
- `enforced: a second pool, raw SQL, COPY, an updatable view, a SECURITY INVOKER function, a cascade, and TRUNCATE are rejected with 42501, and a mixed statement changes no row (A4)` (Postgres);
- `enforced: the table owner's write is rejected by the guard when privileges are granted back` (Postgres);
- `an --allow role's write passes, is recorded as allowed, and still needs routing_key`;
- `an insert or upsert on another actor's primary key fails the turn as a defect and changes nothing`;
- `changing either mapped column of a row is rejected for every role`;
- `startup refuses an enforced table whose trigger is disabled, whose privileges were granted back, or whose mapping changed`;
- `0024_adoption` applies on PGlite and Postgres.

`apps/cli` tests drive `durable adopt plan|observe|backfill|enforce|status|release` against a real database. The Adoption check names these, and invariant A4 gains the adopted-table row. A proposed `adoption` benchmark scenario (M6.md lists none) measures a turn's writes and a legacy writer's statement with observe and with guard on and off, and the results go to [performance](../../BENCHMARKS.md).

## Revisit when

- A brownfield application cannot separate the runtime's login from its legacy writers (Q9).
- Integer keys, or a composite legacy actor key, become the common case (Q1).
- Neki evidence exists for per-shard adoption (Q10).
- Observation's per-statement insert is measurably too costly, which would justify sampling.
