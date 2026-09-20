# 02 — Drizzle, shared SQL and automatic ownership

**Status:** accepted developer experience; execution adapter, ownership protocol and Neki parity are unproven.

[Index](../../README.md) · [Decisions](../../DECISIONS.md) · [Commands](../03-commands-messaging/README.md) · [Transfer](../10-ownership-transfer/README.md) · [Live SQL](../11-live-sql/README.md)

## Goal

Use familiar relational tables and Drizzle expressions. Many actors share a logical table, owning distinct groups of rows. Persisted business data is observable by authorized SQL readers by default; writes belong to actors.

```diagram
┌──────────────────────┐            ┌────────────────────────┐
│ Chat A command       │──writes───▶│ messages: A-owned rows │
└──────────────────────┘            ├────────────────────────┤
┌──────────────────────┐            │ messages: B-owned rows │
│ Chat B command       │──writes───▶│                        │
└──────────────────────┘            └────────────┬───────────┘
                                                │ read-only
                                   ┌────────────▼───────────┐
                                   │ Authorized dashboards  │
                                   │ SQL / BI / live queries│
                                   └────────────────────────┘
```

This is not Rivet's one-SQLite-database-per-actor model. Neki may physically shard the shared logical tables.

## Proposed schema and queries

The ordinary PostgreSQL table below shows a candidate explicit ownership layout. The framework fills these columns from trusted context and excludes them from ordinary writable inputs. Exact column naming/generation and shard-key representation remain open; one-time table registration is not per-query ownership opt-in.

```ts
import { pgTable, text, timestamp, primaryKey } from "durable-actors/drizzle/pg-core"

export const messages = pgTable("messages", {
  tenantId: text("tenant_id").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id").notNull(),
  id: text("id").notNull(),
  authorId: text("author_id").notNull(),
  body: text("body").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({
  columns: [t.tenantId, t.actorType, t.actorId, t.id],
})])
```

```ts
// Actor command. Ownership is stamped; no .owned() or manual owner filter.
const ctx = yield* Context
const [message] = yield* ctx.database.insert(messages).values({
  id: input.id,
  authorId: ctx.caller.userId,
  body: input.body,
  sentAt: ctx.now,
}).returning()
```

```ts
// Application query context. Imports count/eq from durable-actors/drizzle.
const ctx = yield* Context
const rows = yield* ctx.database.select({
  roomId: messages.actorId,
  total: count(),
}).from(messages)
  .where(eq(messages.tenantId, ctx.tenant.id))
  .groupBy(messages.actorId)
  .limit(100)
```

The visible tenant predicate expresses the query; real authorization cannot rely on application authors remembering it. Shared readers use restricted credentials/policies, not the turn writer.

## Drizzle integration contract

- Re-export public query operators, expressions, aggregates, utility types, and PostgreSQL schema builders through dedicated subpaths.
- Keep upstream query syntax, inference, nullability, join multiplicity, and database value conversions visible.
- Builders remain lazy. Yielding executes them as Effects with typed failures and interruption/cleanup semantics.
- Adapter captures the actual transaction identity and connection. Same URL or independently constructed client is not sufficient.
- Do not expose independent commit/connection creation on turn contexts. Whole-turn retries are runtime decisions, not an automatic retry around an arbitrary individual UPDATE.
- Runtime schema derivation is optional boundary machinery, not proof that a raw SQL string matches an annotated TypeScript result.
- Support ordinary Drizzle tooling. Migration generation, runtime connection configuration, and administrative SQL are separate capabilities.
- Compatible direct Drizzle imports remain possible. Package-export restrictions are API hygiene, not authorization.

Framework-managed ownership injection means the context builder's insert/update types differ from unrestricted Drizzle for protected columns. Test inference and behavior for returning, aliases, relational queries, joins, upserts, and custom types; do not claim full upstream compatibility until covered.

## Automatic safety versus explicit errors

Desired: a Chat A command cannot change Chat B's messages, even from JavaScript or raw SQL through a supported execution path. Types reject read-only mutations and protected ownership updates. Runtime checks determine actual row ownership.

The unresolved [ownership contract](../../DECISIONS.md#ownership-errors-versus-implicit-scoping) includes broad predicates, invisible rows, upserts and cascades. An RLS-filtered zero-row UPDATE is not an explicit `OwnershipViolation`. A precheck can race or leak existence; a cross-shard lookup can violate Neki turn locality. Reject unsupported forms before mutation rather than invent silent safety.

Candidate protection includes generated row policies, non-owner execution roles, immutable ownership keys, and a framework-controlled mutation path. RLS session context is a cooperative guardrail for trusted server code, not an isolation boundary for hostile code that can change session settings. Raw SQL escape hatches must not silently bypass stronger guarantees advertised by the builder.

## Constraints and observation

- Actor-owned primary/unique keys must be compatible with shard-local enforcement. A global application identifier may require a separate allocator/protocol.
- Related rows in multiple tables are allowed within one actor's transaction domain.
- Cross-actor foreign-key cascades can bypass logical authority; reject or explicitly redesign them.
- Read-only SQL can still exhaust database capacity; enforce time, rows, concurrent queries and scan budgets.
- Postgres read committed is statement-scoped; multi-query snapshot semantics require an appropriate read transaction.
- Neki cross-shard observations are not a global snapshot. Public-by-default data is still tenant-authorized, not internet-public.
- Secrets are not ordinary public business state. Store references to credentials, not provider tokens in actor rows.

## Validation gates

1. Compile fixtures proving read-only mutation and ownership-column updates fail; separately prove JavaScript cannot bypass execution checks.
2. Create two actors with asymmetric rows; test own/foreign/missing IDs, broad predicates, mixed-owner batches, upserts, joins, triggers, cascades and raw SQL.
3. Race ownership change with attempted mutation; no check-then-write escape or partial writes.
4. Omit tenant filters from a query; backend enforcement still prevents cross-tenant disclosure.
5. Run with non-owner Postgres roles and through the real Neki router, including pooling, prepared statements, missing context and rollback.
6. Throw after a Drizzle write but before receipt/event commit; everything rolls back on one connection.
7. Audit dependency resolution so re-exports and direct imports use a supported Drizzle version; compare adapter results to direct Drizzle for supported queries.
