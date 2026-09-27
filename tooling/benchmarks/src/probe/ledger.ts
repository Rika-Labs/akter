import { Actor } from "@durable-actors/core"
import { index, integer, pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Layer, Option, Schema } from "effect"
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

// What drizzle-kit generates for `entries`; the runtime checks its primary key at startup.
const ENTRIES_DDL = [
  `CREATE TABLE IF NOT EXISTS bench_entries (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, amount integer NOT NULL, memo text NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`,
  `CREATE INDEX IF NOT EXISTS bench_entries_amount
  ON bench_entries (routing_key, tenant_id, actor_id, amount)`,
]

const Entry = Schema.Struct({ id: Schema.String, amount: Schema.Int, memo: Schema.String })

export const Append = Actor.command("Append", { input: Schema.String, output: Schema.Int })

export const Seed = Actor.command("Seed", {
  input: Schema.Struct({ from: Schema.Int, count: Schema.Int }),
})

export const Bump = Actor.command("Bump", { input: Schema.String })

export const Entry1 = Actor.query("Entry", { input: Schema.String, output: Schema.Option(Entry) })

export const Page = Actor.query("Page", { input: Schema.Int, output: Schema.Array(Entry) })

/** Writes and reads its own rows of `entries` through `turn.rows` and `read.rows`. */
export const Ledger = Actor.make("Ledger", {
  key: Schema.NonEmptyString,
  tables: [entries],
  api: { Append, Seed, Bump, Entry: Entry1, Page },
})

const LedgerCommands = Ledger.toLayer(
  Effect.succeed({
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
  }),
)

const LedgerReads = Ledger.toQueryLayer(
  Effect.succeed({
    Entry: Effect.fnUntraced(function* (id: string) {
      return yield* (yield* Ledger.Read).rows(entries).one({ where: { id } })
    }),
    Page: Effect.fnUntraced(function* (limit: number) {
      return yield* (yield* Ledger.Read).rows(entries).all({ orderBy: { amount: "desc" }, limit })
    }),
  }),
)

/** Creates the table as a drizzle-kit migration would, then registers the actor. */
export const LedgerLive = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    for (const statement of ENTRIES_DDL) yield* sql.unsafe(statement)

    return Layer.mergeAll(LedgerCommands, LedgerReads)
  }).pipe(Effect.orDie),
)
