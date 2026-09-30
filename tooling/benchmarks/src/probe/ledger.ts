import { Actor } from "@durable-actors/core"
import { index, integer, pgTable, text } from "drizzle-orm/pg-core"
import { Deferred, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"

/** An owned table: the framework adds and scopes routing_key, tenant_id, and actor_id. */
export const entries = Actor.table(
  pgTable(
    "bench_entries",
    {
      id: text("id").primaryKey(),
      amount: integer("amount").notNull(),
      memo: text("memo").notNull(),
    },
    (table) => [index("bench_entries_amount").on(table.amount)],
  ),
)

/**
 * What drizzle-kit generates for `entries`; the runtime checks its primary key
 * at startup.
 */
const ENTRIES_DDL = [
  `CREATE TABLE IF NOT EXISTS bench_entries (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, amount integer NOT NULL, memo text NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  `CREATE INDEX IF NOT EXISTS bench_entries_amount
  ON bench_entries (routing_key, tenant_id, actor_id, amount)`,
  `ALTER TABLE bench_entries ENABLE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    CREATE POLICY durable_tenant ON bench_entries AS PERMISSIVE FOR ALL TO public
      USING (tenant_id = current_setting('durable.tenant', true))
      WITH CHECK (tenant_id = current_setting('durable.tenant', true));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
]

const Entry = Schema.Struct({ id: Schema.String, amount: Schema.Int, memo: Schema.String })

/** Inserts one row with the given id and replies with 1. */
export const Append = Actor.command("Append", { payload: Schema.String, success: Schema.Int })

/** Inserts `count` rows `seed-<from + n>` in one statement. */
export const Seed = Actor.command("Seed", {
  payload: Schema.Struct({ from: Schema.Int, count: Schema.Int }),
})

/** Adds one to the amount of the row with this id; does nothing when it is absent. */
export const Bump = Actor.command("Bump", { payload: Schema.String })

/** The row with this id, if any. */
export const Entry1 = Actor.query("Entry", {
  payload: Schema.String,
  success: Schema.Option(Entry),
})

/** Up to `limit` rows, largest amount first. */
export const Page = Actor.query("Page", { payload: Schema.Int, success: Schema.Array(Entry) })

/** Writes and reads its own rows of `entries` through `turn.rows` and `read.rows`. */
export const Ledger = Actor.make("Ledger", {
  key: Schema.NonEmptyString,
  tables: [entries],
  api: { Append, Seed, Bump, Entry: Entry1, Page },
})

const LedgerCommands = Ledger.toLayer({
  Append: Effect.fnUntraced(function* (id: string) {
    const turn = yield* Ledger.Turn
    yield* turn.rows(entries).insert({ id, amount: 1, memo: "append" })

    return 1
  }),
  Seed: Effect.fnUntraced(function* ({ from, count }) {
    yield* (yield* Ledger.Turn).rows(entries).insert(
      Array.from({ length: count }, (_, offset) => ({
        id: `seed-${from + offset}`,
        amount: from + offset,
        memo: "seed",
      })),
    )
  }),
  Bump: Effect.fnUntraced(function* (id: string) {
    const rows = (yield* Ledger.Turn).rows(entries)
    const found = yield* rows.one({ where: { id } })

    if (Option.isSome(found)) yield* rows.update({ amount: found.value.amount + 1 }).where({ id })
  }),
})

const LedgerReads = Ledger.toQueryLayer({
  Entry: Effect.fnUntraced(function* (id: string) {
    return yield* (yield* Ledger.Read).rows(entries).one({ where: { id } })
  }),
  Page: Effect.fnUntraced(function* (limit: number) {
    return yield* (yield* Ledger.Read).rows(entries).all({ orderBy: { amount: "desc" }, limit })
  }),
})

/** Creates the table as a drizzle-kit migration would, then registers the actor. */
export const LedgerLive = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const statement of ENTRIES_DDL) yield* sql.unsafe(statement)

    return Layer.mergeAll(LedgerCommands, LedgerReads)
  }).pipe(Effect.orDie),
)

/** Rows of `ParentedItem`, which live on their root's shard. */
export const parentedItems = Actor.table(
  pgTable("bench_parented_items", { id: text("id").primaryKey(), label: text("label").notNull() }),
)

/** Rows of `SpreadItem`, which live on each item's own shard. */
export const spreadItems = Actor.table(
  pgTable("bench_spread_items", { id: text("id").primaryKey(), label: text("label").notNull() }),
)

/**
 * What drizzle-kit generates for the item tables, row-level security policy
 * included.
 */
const ITEMS_DDL = ["bench_parented_items", "bench_spread_items"].flatMap((table) => [
  `CREATE TABLE IF NOT EXISTS ${table} (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, label text NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  `DO $$ BEGIN
    CREATE POLICY durable_tenant ON ${table} AS PERMISSIVE FOR ALL TO public
      USING (tenant_id = current_setting('durable.tenant', true))
      WITH CHECK (tenant_id = current_setting('durable.tenant', true));
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
])

/** Stages a `Mark` intent for the item, on the root's shard when `parented`, on the item's own shard otherwise. */
export const Notify = Actor.command("Notify", {
  payload: Schema.Struct({ item: Schema.String, parented: Schema.Boolean, label: Schema.String }),
})

/** Number of parented item rows visible from the root's shard group. */
export const FamilyLabels = Actor.query("FamilyLabels", { success: Schema.Int })

/** An actor-placed root whose items are placed either on it or on their own shards. */
export const FamilyRoot = Actor.make("FamilyRoot", {
  key: Schema.NonEmptyString,
  placement: "actor",
  api: { Notify, FamilyLabels },
})

/** Upserts the item's `mark` row with the label and completes the pending mark for it. */
export const Mark = Actor.command("Mark", { payload: Schema.String })

/** Number of rows in the item's table. */
export const ItemLabels = Actor.query("ItemLabels", { success: Schema.Int })

/** Item placed on its `FamilyRoot`'s shard. */
export const ParentedItem = Actor.make("ParentedItem", {
  key: Schema.NonEmptyString,
  placement: { parent: FamilyRoot },
  tables: [parentedItems],
  api: { Mark },
})

/** Item placed on a shard of its own. */
export const SpreadItem = Actor.make("SpreadItem", {
  key: Schema.NonEmptyString,
  placement: "actor",
  tables: [spreadItems],
  api: { Mark, ItemLabels },
})

/** Pending item marks by label, completed by the item's turn. */
export const marks = new Map<string, Deferred.Deferred<void>>()

const marked = (label: string) =>
  Effect.suspend(() => {
    const pending = marks.get(label)

    return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined)
  }).pipe(Effect.asVoid)

/** A spread item's id: the root's id and the item's, as an application would key it. */
export const spreadId = ({ root, item }: { readonly root: string; readonly item: string }) =>
  `${root}/${item}`

/** Creates the item tables as a drizzle-kit migration would, then registers the family. */
export const FamilyLive = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const statement of ITEMS_DDL) yield* sql.unsafe(statement)

    return Layer.mergeAll(
      FamilyRoot.toLayer({
        Notify: Effect.fnUntraced(function* ({ item, parented, label }) {
          const turn = yield* FamilyRoot.Turn

          yield* parented
            ? (yield* ParentedItem.intents(ParentedItem.idOf(turn.id, item))).Mark(label)
            : (yield* SpreadItem.intents(spreadId({ root: turn.id, item }))).Mark(label)
        }),
      }),
      FamilyRoot.toQueryLayer({
        FamilyLabels: Effect.fnUntraced(function* () {
          const rows = yield* (yield* FamilyRoot.Read).group((db) =>
            db.select({ label: parentedItems.label }).from(parentedItems),
          )

          return rows.length
        }),
      }),
      ParentedItem.toLayer({
        Mark: Effect.fnUntraced(function* (label: string) {
          const turn = yield* ParentedItem.Turn
          yield* turn.rows(parentedItems).upsert({ id: "mark", label })
          yield* marked(label)
        }),
      }),
      SpreadItem.toLayer({
        Mark: Effect.fnUntraced(function* (label: string) {
          const turn = yield* SpreadItem.Turn
          yield* turn.rows(spreadItems).upsert({ id: "mark", label })
          yield* marked(label)
        }),
      }),
      SpreadItem.toQueryLayer({
        ItemLabels: Effect.fnUntraced(function* () {
          return yield* (yield* SpreadItem.Read).rows(spreadItems).count()
        }),
      }),
    )
  }).pipe(Effect.orDie),
)
