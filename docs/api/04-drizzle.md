# Drizzle integration

**Responsibility:** define the relational query experience.  
**Authority:** API design.  
**Owner role:** database/API.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

Actor-owned tables use Drizzle semantics and gain `routing_key`, `tenant_id`, and `actor_id` ownership columns. The framework does not invent a separate query language or re-export drivers, pools, dialect internals, migration CLIs, or unrelated runtime globals.

## Declaring an owned table

<!-- snippet file=room.ts
import { Schema } from "effect"
const RoomId = Schema.String
const Post = Actor.command("Post", { input: Schema.Struct({ body: Schema.String }) })
const Recent = Actor.query("Recent", { output: Schema.Array(Schema.String) })
-->

```ts
import { Actor } from "@durable-actors/core"
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core"

export const messages = Actor.table(
  pgTable(
    "chat_messages",
    {
      id: text("id").primaryKey(),
      author: text("author").notNull(),
      body: text("body").notNull(),
      sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    },
    (table) => [index("chat_messages_sent").on(table.sentAt)],
  ),
)

export const Room = Actor.make("Room", { key: RoomId, tables: [messages], api: { Post, Recent } })
```

`Actor.table(pgTable(...))` takes an ordinary Drizzle table and returns it as an `OwnedTable`. It adds `routing_key bigint`, `tenant_id text`, and `actor_id text` columns and prefixes the table's primary key (column-level or `primaryKey()`), every `unique()`/`.unique()` constraint, and every `index()`/`uniqueIndex()` with `(routing_key, tenant_id, actor_id)`; `NULLS NOT DISTINCT` is kept. Only btree indexes are supported, because other access methods (GIN, GiST, hash, BRIN) cannot lead with the ownership prefix; generating DDL for one fails with an error. Keys and uniqueness are therefore per actor, and every scoped scan leads with `routing_key`. drizzle-kit generates the table, columns, and prefixed keys from the returned value, and also enables row-level security with the `durable_tenant` policy, `tenant_id = current_setting('durable.tenant', true)`. The policy exempts the table owner, so it changes nothing until a runtime opts in with `rowLevelSecurity` ([ADR 0051](../decisions/0051-row-level-security.md)). Application tables are created by drizzle-kit migrations, not by the framework.

`Actor.table` rejects a table that has no primary key, declares a column whose key or SQL name is `routing_key`, `tenant_id`, or `actor_id`, declares a foreign key (inline `.references()` or `foreignKey()`), is an alias, or is already owned. An owned table is listed in exactly one actor type's `tables`; `Actor.make` rejects a table another actor type already lists, and the runtime records the owner in `actor_tables` so a later deployment cannot move a table to a second actor type. At startup each registered table must exist with the primary key `(routing_key, tenant_id, actor_id, <business key>)`; otherwise the layer fails instead of running unscoped. With `rowLevelSecurity` on, it must also have row-level security on with the `durable_tenant` policy, and the tenant role must be able to read and write it.

## Adopting an existing table

A table that already exists, and that a web app or batch job also writes, is adopted instead of declared ([ADR 0054](../decisions/0054-existing-schema-adoption.md)):

<!-- snippet
import { Actor } from "@durable-actors/core"
import { pgTable, text } from "drizzle-orm/pg-core"
const existingInvoices = pgTable("invoices", { id: text("id").primaryKey(), orgId: text("org_id").notNull(), accountId: text("account_id").notNull() })
const existingContacts = pgTable("contacts", { id: text("id").primaryKey(), tenant: text("tenant").notNull(), owner: text("owner").notNull() })
-->

```ts
const InvoiceRows = Actor.table(existingInvoices, {
  owner: { tenant: existingInvoices.orgId, actor: existingInvoices.accountId },
})

const Contacts = Actor.table(existingContacts, {
  owner: { tenant: existingContacts.tenant, actor: existingContacts.owner },
  access: "read",
})
```

`owner.tenant` holds the `TenantId` string and `owner.actor` the actor's encoded key. Both must be `text`, `varchar`, or `uuid` columns of the table, and they must differ. A `uuid` column needs ids in canonical lowercase form; the turn refuses any other id. Integer and `citext` columns are refused: an integer column would let `"042"` and `"42"` name the same rows through two actor ids.

The table stays as it is. Its primary key, unique constraints, indexes, and foreign keys are not prefixed or removed, and no policy is added, so business keys are unique across actors. The framework adds one nullable `routing_key bigint` to the Drizzle object, which `durable adopt observe` also adds to the database, so the next `drizzle-kit generate` emits an `ADD COLUMN routing_key` that the database already has; remove that statement. `Row` and `Insert` follow Drizzle: an adopted table's rows carry its two mapped columns as read-only values, and the turn rejects a write that sets either one. Types cannot tell which property a column object came from, so a column shaped exactly like a mapped column is optional in `Insert`, and the database refuses the row if it is missing.

An insert or upsert whose primary key belongs to another actor fails the turn as a deterministic defect and changes nothing. An upsert conflicts on the table's own primary key and updates only where the mapped columns match the turn.

`access: "read"` adopts the table for reading only: `turn.rows(table)` and `read.rows(table)` are `ScopedRead`, filtered by the two mapped columns, with no mutation methods, and `group` refuses the table. The framework adds no column, record, or trigger, and the table needs only an index leading with `(tenant, actor)`.

A writable adopted table starts only after `durable adopt observe`, and the runtime refuses it otherwise; see the [migrations guide](../operations/02-migrations.md#adopting-an-existing-schema). While a table is observed the actor is not authoritative, because other code still writes it; `durable adopt enforce` makes the database reject every other writer, and the runtime then runs the turns of that actor type as the `adoption.role` writer role.

## Scoped rows

Inside a command turn, `turn.rows(table)` is scoped to the current tenant and actor and bound to the turn transaction. `turn.rows` accepts only tables in the actor's `tables`, in types and at runtime. `read.rows(table)` in queries is `ScopedRead`: it exposes only `one`, `all`, and `count` and has no mutation methods at runtime either.

<!-- snippet
import { Effect } from "effect"
import { messages, Room } from "./room.ts"
declare const id: string
declare const author: string
declare const body: string
declare const sentAt: Date
-->

```ts
const inATurn = Effect.gen(function* () {
  const turn = yield* Room.Turn
  yield* turn.rows(messages).insert({ id, author, body, sentAt })
  yield* turn.rows(messages).update({ body }).where({ id })
  yield* turn.rows(messages).delete().where({ id })
  yield* turn.rows(messages).upsert({ id, author, body, sentAt })
})

const inAQuery = Effect.gen(function* () {
  const read = yield* Room.Read
  const recent = yield* read.rows(messages).all({ orderBy: { sentAt: "desc" }, limit: 20 })
  const one = yield* read.rows(messages).one({ where: { id } }) // Option<Row>
  const total = yield* read.rows(messages).count({ where: { author } })
})
```

Filters are Drizzle's object filters (`TableFilter`) over business columns: equality by value, the column operators (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`, `ilike`, `notLike`, `notIlike`, `isNull`, `isNotNull`, `arrayContains`, `arrayContained`, `arrayOverlaps`), and `AND`, `OR`, and `NOT`. `orderBy` is `{ column: "asc" | "desc" }`. Rows are returned with business columns only. `update(values)` and `delete()` run only once given `.where(filter)`; `.where({})` affects every row of the actor. `upsert` inserts, or on a conflict of the scoped primary key updates the supplied non-key columns. Insert, update, and filter values are plain data: strings, numbers, bigints, booleans, `null`, `Date`, `Uint8Array`, arrays, and plain objects. The framework copies them before building SQL and rejects functions, class instances, and anything Drizzle would render as SQL, at any depth. A `Date` or `Uint8Array` is compared with `{ eq: value }`, not as a bare filter value, which Drizzle would otherwise read as an empty operator map.

A write error that is not retryable, such as a duplicate key, is a deterministic defect: the turn rolls back without a receipt. Check first with `one`, or use `upsert`.

| Operation                                    | `turn.rows` | `read.rows` | Scope applied                                                        |
| -------------------------------------------- | ----------- | ----------- | -------------------------------------------------------------------- |
| `one({ where?, orderBy? })`                  | yes         | yes         | `routing_key`, `tenant_id`, `actor_id` ANDed with the filter         |
| `all({ where?, orderBy?, limit?, offset? })` | yes         | yes         | same                                                                 |
| `count({ where? })`                          | yes         | yes         | same                                                                 |
| `insert(row \| rows)`                        | yes         | no          | ownership columns supplied from the turn                             |
| `update(values).where(filter)`               | yes         | no          | scoped `WHERE`; ownership columns cannot be set                      |
| `delete().where(filter)`                     | yes         | no          | scoped `WHERE`                                                       |
| `upsert(row \| rows)`                        | yes         | no          | conflict target is the scoped primary key, so it only meets own rows |
| `group((db) => select)`                      | yes         | yes         | `routing_key`, `tenant_id` on the base table and every join's `ON`   |

Rejected, as a defect that rolls back the turn and never runs unscoped or in a second transaction:

- ownership columns in insert values, update values, upsert values, filters, or `orderBy`;
- unknown columns, `RAW` filters, and SQL values (`sql`, columns, subqueries, placeholders) in values or filters;
- `rows(table)` for a table the actor type does not list;
- use of a `rows` or `group` capability after its turn or query ended (including from a fiber forked during it), or from another actor's turn;
- mutation methods on `read.rows`, and anything other than select on `group`.

Every scoped statement filters on `routing_key`, `tenant_id`, and `actor_id` first, so an ordered or ranged read is fast only when an index leads with those three columns and continues with the `orderBy` or range column. The primary key serves reads by business key. For any other ordered read, such as `all({ orderBy: { sentAt: "desc" }, limit: 20 })`, declare an `index()` on that column, as `chat_messages_sent` does above; `Actor.table` prefixes it with the ownership columns. Without one, Postgres reads all of the actor's rows and sorts them on every call. The `owned-rows` benchmark's `read-page-20` case measured that sort at 0.44 ms per call over 1,000 rows, against 0.03 ms with the index, and the difference grows with the actor's row count.

A Drizzle `customType` whose `toDriver` returns a SQL expression instead of a plain value is application code, and it bypasses scoping: the framework checks the plain values a handler passes, but Drizzle calls the encoder later, while rendering the statement, and renders any SQL it returns into the statement as is. Keep `toDriver` returning plain values; an encoder that builds SQL can write or read outside the actor's scope, and the framework cannot detect it.

Raw SQL, Drizzle's relational query API (`db.query`), `returning`, `onConflict` options, `insert ... select`, update/delete joins, foreign keys, cascades, and CTEs are not supported on owned tables yet; supporting one needs evidence in the conformance suite first.

## Placement group reads

`group` is a read-only Drizzle select scoped to the actor's placement group: every actor of the tenant under `placement: "tenant"`, or the actor itself under `placement: "actor"` ([ADR 0006](../decisions/0006-scale-rules-placement-and-query-tiers.md)). It is available on `X.Turn` (reading through the turn transaction) and `X.Read`, and one select is one snapshot.

<!-- snippet
import { Actor } from "@durable-actors/core"
import { eq, inArray } from "drizzle-orm"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"
const notes = Actor.table(pgTable("notes", { id: text("id").primaryKey() }))
const labels = Actor.table(pgTable("labels", { noteId: text("note_id").primaryKey(), label: text("label").notNull() }))
const Library = Actor.make("Library", { key: Schema.String, tables: [notes, labels], api: {} })
declare const ids: ReadonlyArray<string>
-->

```ts
const inAQuery = Effect.gen(function* () {
  const read = yield* Library.Read
  const rows = yield* read.group((db) =>
    db
      .select({ note: notes.id, label: labels.label })
      .from(notes)
      .leftJoin(labels, eq(labels.noteId, notes.id))
      .where(inArray(notes.id, ids))
      .orderBy(notes.id),
  )
})
```

The builder gets only `select` and `selectDistinct`, and its select is only read: the framework rebuilds every expression from values read once (fresh text chunks, parameters holding copied plain data, and the real columns of the query's tables) and runs that on a fresh select of its own, so getters, proxies, or hidden `getSQL` members on the caller's objects never render. The base table and every joined table must be owned tables that some actor type of this runtime lists in `tables` and that passed the startup check (not aliases, and never a table merely wrapped with `Actor.table`); the framework adds `routing_key = <group> AND tenant_id = <tenant>` to the base table's `WHERE` and to each join's `ON`. Only inner and left joins are supported. Expressions in the selection, `where`, `having`, `orderBy`, `groupBy`, and `ON` may use business columns, plain values, and Drizzle's comparison, boolean, pattern, null, and aggregate operators, and each must balance its parentheses, so the framework's parenthesized scope predicate cannot be closed from inside. Ownership columns cannot be selected or filtered (so `db.select()` without fields is rejected); raw SQL text beyond operator words, table references, subqueries, identifiers, SQL-valued parameters, set operators, `WITH`, locking clauses, lateral joins, placeholders, and `DISTINCT ON` are rejected. Fleet-wide reads are the target `Fleet.view` definitions of [ADR 0056](../decisions/0056-fleet-views.md), not implemented yet.

## Transactions and backends

Writes use `drizzle-orm/effect-postgres` (or `drizzle-orm/effect-pglite`) on the framework's own `PgClient`/`PgliteClient`, joining the turn's transaction connection; there is no second pool. Successful business changes commit with the receipt; an unhandled declared failure rolls them back while retaining the terminal failure receipt. A turn that cannot find its transaction connection refuses to write.

Application code supplies business fields and filters, not ownership columns; the framework inserts ownership columns and constrains reads, updates, deletes, and upsert conflict targets from trusted context. These guarantees apply to every supported adapter, not only Drizzle; selecting another integration must not require manual ownership predicates in handlers. Drizzle on Postgres and PGlite is the first and only supported combination; additional query-client and backend adapters need the same automatic scoping, phase restrictions, turn-connection binding, and conformance evidence. See [adapter requirements](../architecture/05-adapters.md).

TypeScript types alone are not authority: runtime scoping, phase checks, and the ownership-prefixed keys enforce it.

There is one database per deployment region. Tenants are rows, isolated by `tenant_id`, composite indexes, and optional RLS. Placement is selected with `placement`, not separate tenant databases. Table schema changes use normal SQL migrations; keyed actor state uses `Actor.migration` upcasts.
