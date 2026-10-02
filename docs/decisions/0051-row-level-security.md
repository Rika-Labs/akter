# ADR 0051: Optional row-level security

**Status:** accepted (2026-09-30). It gates M4.5. Migration `0018_rls` and `conformance/rls.ts` implement it. It amends [ADR 0028](0028-sql-inspection-views.md) §4, §5, and decided question 6: the inspection views keep their owner's rights instead of switching to `security_invoker`.

**Responsibility:** define how a deployment turns on Postgres row-level security (RLS), which statements it binds to one tenant, which it exempts, and how the `durable` inspection views apply it.

**Authority:** decision record. It amends contracts [06](../contracts/06-storage-ownership.md) and [10](../contracts/10-security.md), [inspection views](../operations/inspection-views.md), the [support matrix](../operations/support-matrix.md), the [runbooks](../operations/runbooks.md), the conformance ledger, and [invariants](../verification/invariants.md) S2.

**Owner role:** security and runtime architecture.

**Change policy:** supersede through a new ADR when the policy expression, the setting name, the role model, or the set of bound statements changes.

## Context

Contract 10 makes RLS optional, per table, and defense in depth: the mandatory boundary stays the trusted `tenant_id` predicate on every statement, actor ownership, and generation fencing. These facts from the code shape the design:

- Every framework row but deployment metadata carries `tenant_id`. The tenant-bearing tables are `actor_generations`, `actor_state`, `actor_receipts`, `actor_outbox`, `actor_events`, `actor_dead_letters`, `actor_blobs`, `actor_workflow_executions`, `actor_workflow_step`, `actor_connections`, `actor_subscriptions`, `actor_subscription_tags`, and `actor_subscription_cursors`. Owned tables get `tenant_id` from `Actor.table`.
- A command turn runs in one transaction whose first statement already calls `set_config` for its timeouts. Handler SQL (owned rows and blobs) runs in the same transaction.
- Queries run on the pool, outside a transaction.
- Many framework statements span tenants on purpose: relay and executor claims by bucket, settles, retention sweeps, workflow recovery, subscription fan-out scans, connection sweeps, and registration checks.
- The runtime creates its tables, so it connects as their owner. Postgres exempts a table's owner from its policies unless the table forces RLS, and it always exempts superusers and `BYPASSRLS` roles. PGlite and most development databases run as a superuser.
- A view with owner rights checks its base tables as the view's owner. Postgres checked that when that owner is a superuser, the view ignores RLS for every reader. When the owner is an ordinary role, the view applies that role's policies. A `current_setting` in a policy still reads the reader's session.
- With `security_invoker`, Postgres checks the reader's own privileges on the base tables. A role granted only the `durable` schema then fails with `permission denied` on every view. Contract 10 forbids granting that role any `actor_*` table.

## Decision

### 1. One policy, keyed by `durable.tenant`

Migration `0018_rls` enables RLS on every tenant-bearing framework table and creates one permissive policy on each:

```sql
CREATE POLICY durable_tenant ON actor_state
  USING (tenant_id = current_setting('durable.tenant', true))
  WITH CHECK (tenant_id = current_setting('durable.tenant', true));
```

It does not force RLS and creates no role. The owner and superusers stay exempt, so a deployment that doesn't opt in behaves exactly as before. A role subject to the policy sees no rows at all until its transaction sets `durable.tenant`, and a missing setting reads as NULL, which matches no row.

Owned tables carry the same policy. `Actor.table` adds `pgPolicy("durable_tenant", ...)` to the table's Drizzle config, so drizzle-kit enables RLS and creates the policy in the application's own migration. A later framework migration that adds a tenant-bearing table must add the policy in the same migration. The runtime's startup check (§3) and a conformance case fail when one is missing.

### 2. The runtime opts in with a tenant role

```ts
Actors.layer({ authorize, rowLevelSecurity: { role: "durable_tenant" } })
```

With the option set, every tenant-scoped transaction takes the role and names its tenant:

```sql
SELECT set_config('role', 'durable_tenant', true), set_config('durable.tenant', $tenant, true)
```

Both settings are transaction-local, so they end at `COMMIT` or `ROLLBACK` and never reach the next borrower of a pooled connection.

- **Command turns**, including every relay, timer, effect-route, cron, and subscription delivery, add the two calls to the `set_config` statement that opens the turn. That adds no statement and no round trip. Every later statement of the turn runs as the role, including the handler's owned rows and blobs. On a cold activation, the opening statement also inserts the actor's generation row. Postgres checks that insert as the connecting role, because the role change takes effect only at the next statement.
- **Queries** run in a transaction that opens with the same statement, so state, event replay, and owned-row reads are bound. That costs `BEGIN`, the settings, and `COMMIT` per query, but only with the option on. Without it, queries are unchanged.
- **Every other read that serves a caller** runs the same way, in its own tenant transaction:
  - the existence check before an event feed;
  - feed pages (`readFeed`);
  - workflow polls (`pollWorkflow`);
  - reads that stream and connection handlers make outside a turn: `read.blob`, `read.rows`, `read.events`, and `read.follow` pages.

  A read already inside a bound transaction, such as a query's, joins it instead of opening another.

- **Framework maintenance** keeps the connecting role, which the policies exempt. That covers the relay, executors, settles, retention, workflow recovery and steps, subscription fan-out, connection sessions and sweeps, cron scheduling, and registration checks. These are contract 10's framework maintenance statements. They stay scoped by explicit predicates, not by RLS.

The option names the role rather than fixing one because roles are cluster-wide and deployments can share a cluster.

### 3. The runtime refuses a half-configured database

With `rowLevelSecurity` set, startup fails before serving when any of these is false:

- the role exists and is neither a superuser nor `BYPASSRLS`;
- this login can take the role, which the check proves by taking it in a transaction;
- every table in the runtime's schema that is named `actor_*` and has a `tenant_id` has RLS on and a `durable_tenant` policy, and the role can select, insert, update, and delete in it, and doesn't own it;
- every view in `durable` belongs to a view-owner role that isn't a superuser or `BYPASSRLS`, doesn't own (and isn't a member of the owner of) any table with RLS on, can select every `actor_*` table, and isn't a role the tenant role is a member of (§4);
- every registered owned table has RLS on, a `durable_tenant` policy, and the same grants, and isn't owned by the role, because Postgres exempts a table's owner from its policies.

Each refusal names the object and the fix.

### 4. The inspection views keep owner rights, owned by a dedicated view-owner role

The views stay definer-rights views. The operator transfers them to a dedicated view-owner role. That role is `NOLOGIN`, isn't the table owner, has no `BYPASSRLS`, holds only `SELECT` on the tables, and isn't granted to the tenant role. The role that runs turns and their handler SQL therefore can't `ALTER` or `DROP` a view. Postgres then evaluates the base tables' policies as that role, keyed by the reader's `durable.tenant`. So a role granted only the `durable` schema (ADR 0028 §5, unchanged):

- reads, through every view, only the tenant its transaction names, and nothing when it names none;
- still gets `permission denied` on every `actor_*` table, because it holds no grant on any of them.

The views are still read-only for every role, as ADR 0028 §3 requires: a join still refuses writes before any row is touched. The inspector (`Inspector.serve`) sets `durable.tenant` to its principal's tenant in its read-only transaction, so with RLS on the database enforces the tenant the inspector already filters by.

This replaces ADR 0028's planned switch to `security_invoker`. That switch would have required granting the view reader the base tables, which contract 10 forbids. A migration that adds or recreates a view leaves it owned by the migrating role, so the operator reruns the ownership step. Until they do, the startup check refuses to run with RLS on.

Without RLS configured, the views are owned by the migrating role and show every tenant, as ADR 0028 describes.

### 5. The operator script

Run once as the table owner after the migrations, and again after any migration that adds a table or view. Then start the runtime with `rowLevelSecurity: { role }`:

```sql
CREATE ROLE durable_tenant NOLOGIN;
GRANT USAGE ON SCHEMA public TO durable_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO durable_tenant;
GRANT durable_tenant TO runtime_login;

CREATE ROLE durable_views NOLOGIN;
GRANT USAGE ON SCHEMA public TO durable_views;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO durable_views;
GRANT durable_views TO CURRENT_USER;               -- ALTER VIEW ... OWNER needs it
GRANT CREATE ON SCHEMA durable TO durable_views;   -- and this
DO $$ DECLARE v record; BEGIN
  FOR v IN SELECT relname FROM pg_class WHERE relnamespace = 'durable'::regnamespace AND relkind = 'v'
  LOOP EXECUTE format('ALTER VIEW durable.%I OWNER TO durable_views', v.relname); END LOOP;
END $$;
REVOKE CREATE ON SCHEMA durable FROM durable_views;
```

Replace `public` with the runtime's schema and `runtime_login` with the runtime's login role. Never grant `durable_views` to `durable_tenant`.

## Decided questions

These are the recommended answers. Dallen decides them when accepting this record.

1. **The migration enables the policies unconditionally, without `FORCE`.** Nothing changes for the exempt owner, and the opt-in is the runtime option plus the operator script. Rejected: creating the policies disabled and enabling them in the opt-in step, which adds a second switch whose state the runtime must also check.
2. **A dedicated view-owner role owns the views** (decided by the coordinator, 2026-09-29). Rejected: the tenant role owning them, which would let a turn's SQL alter or drop the views.
3. **Queries and every other caller-facing read pay a transaction only with RLS on.** Rejected: always wrapping them, which adds two statements to every default-configuration read. Also rejected: leaving feeds, workflow polls, and handler reads outside turns exempt (decided by the coordinator, 2026-09-29), because RLS should back every read that serves a caller.
4. **Framework maintenance stays exempt as the connecting role.** Rejected: running each cross-tenant statement per tenant, which multiplies relay and sweep statements by the tenant count. Also rejected: a policy clause exempting a session setting, which any statement could set.
5. **The inspection views stay owner-rights views** (§4). Rejected: `security_invoker` with column-level grants of the exposed columns to the reader, which lets that reader select `actor_*` tables directly and contradicts contract 10.

## Alternatives considered

- **`FORCE ROW LEVEL SECURITY` on every table** so the owner is bound too. Rejected: the views would still bypass the policies wherever the migrating role is a superuser (PGlite, most development databases), and every cross-tenant maintenance statement would need an escape.
- **A per-view tenant predicate** from a session setting. Rejected in ADR 0028 question 6 as a second, weaker isolation mechanism.
- **Creating the role in the migration.** Rejected for the reason ADR 0028 question 2 gives: the migration user may lack `CREATEROLE`, and migration behavior must not depend on privileges.

## Consequences

- A deployment that opts in gets a database-enforced tenant boundary under turns, queries, handler SQL, caller-facing reads, the inspector, and every SQL tool reading the views. A missing predicate in those paths returns or changes nothing outside the tenant.
- Deployments that don't opt in see no change in statements, round trips, or view results.
- Turns cost nothing extra. Queries, feed pages, workflow polls, and reads outside a turn cost `BEGIN`, one `set_config` statement, and `COMMIT` each, only with the option on. A read inside a bound transaction joins it and costs nothing more.
- The operator runs two roles, not one: the tenant role the runtime takes, and a view-owner role that owns the views. The tenant role can't act as the view owner, so user turns can't alter or drop a view.
- Every future tenant-bearing framework table needs its policy in its migration. Every future view needs the ownership step rerun before a runtime with RLS starts, and the startup check refuses until then.
- Framework maintenance statements stay outside RLS and depend on their explicit predicates, as contract 10 states.
- RLS is not a sandbox and not a backup boundary. Contract 10's trust model is unchanged.

## Evidence

- Conformance ([`conformance/rls.ts`](../../packages/durable-actors/src/testing/conformance/rls.ts)) runs seven cases: six on PGlite and Postgres, and one on Postgres alone because it needs independent connections:
  - three runners on one database serve two tenants' turns, timers, effect routes, owned rows, and reads, each seeing only its own, with actors owned by more than one runner;
  - every table with a `tenant_id` carries the policy;
  - two tenants run turns, timers, effects with routes, queries, and owned rows, and each sees only its own;
  - a transaction as the role naming one tenant reads, updates, and inserts no other tenant's rows in any protected table, and naming none sees nothing;
  - revoking one privilege at a time from the role fails a turn, a query, the existence check, a feed page, a workflow poll, and a stream handler's blob read, which proves each runs as the role;
  - a role granted only `durable` reads its transaction's tenant through every view and is denied every protected table;
  - startup refuses a missing role, a view owned by an exempt role, a view the tenant role can act as, and an owned table the role owns.
- Drizzle-kit output for owned tables in `tables/owned.test.ts`.
- Benchmark `rls`, run against the view-owner script (see [performance](../../BENCHMARKS.md)).

## Revisit when

- A deployment needs RLS on framework maintenance statements.
- Postgres exposes a way to exempt a role for a single statement without `SET ROLE`.
