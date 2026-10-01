import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import {
  alias,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core"
import { Cause, Effect, Exit } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, type Insert, type Row } from "../index.ts"
import type { TurnRows } from "./owned.ts"
import { labels, notes, tablesDdl } from "../testing/conformance/tables.ts"
import { watchDdl, watchRows } from "../testing/conformance/watch.ts"

const migration = (schema: Parameters<typeof generateDrizzleJson>[0]) =>
  Effect.gen(function* () {
    const before = yield* Effect.promise(() => generateDrizzleJson({}))
    const after = yield* Effect.promise(() => generateDrizzleJson(schema))

    return yield* Effect.promise(() => generateMigration(before, after))
  })

describe("owned table declarations", () => {
  it("generates ownership-prefixed keys, uniques, and indexes through drizzle-kit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* migration({ notes, labels })).toEqual(tablesDdl)
      }),
    ))

  it("generates the DDL the watch conformance table is created with", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* migration({ watchRows })).toEqual(watchDdl)
      }),
    ))

  it("prefixes a composite primary key and keeps business types free of ownership", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const lines = Actor.table(
          pgTable(
            "owned_lines",
            { order: text("order").notNull(), line: integer("line").notNull(), sku: text("sku") },
            (table) => [primaryKey({ columns: [table.order, table.line] }), unique().on(table.sku)],
          ),
        )

        expect((yield* migration({ lines })).join("\n").replaceAll(/\s+/g, " ")).toContain(
          `PRIMARY KEY("routing_key","tenant_id","actor_id","order","line"), CONSTRAINT "owned_lines_routing_key_tenant_id_actor_id_sku_unique" UNIQUE("routing_key","tenant_id","actor_id","sku")`,
        )
        expectTypeOf<keyof Row<typeof lines>>().toEqualTypeOf<"order" | "line" | "sku">()
        expectTypeOf<keyof Insert<typeof lines>>().toEqualTypeOf<"order" | "line" | "sku">()
      }),
    ))

  it("keeps NULLS NOT DISTINCT on a column unique and rejects non-btree indexes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const handles = Actor.table(
          pgTable("owned_handles", {
            id: text("id").primaryKey(),
            handle: text("handle").unique("owned_handles_handle", { nulls: "not distinct" }),
          }),
        )

        expect((yield* migration({ handles })).join("\n").replaceAll(/\s+/g, " ")).toContain(
          `CONSTRAINT "owned_handles_handle" UNIQUE NULLS NOT DISTINCT("routing_key","tenant_id","actor_id","handle")`,
        )

        const tags = Actor.table(
          pgTable("owned_hashed", { id: text("id").primaryKey(), tag: text("tag") }, (table) => [
            index("owned_hashed_tag").using("gin", table.tag),
          ]),
        )

        yield* migration({ tags }).pipe(
          Effect.exit,
          Effect.map((exit) =>
            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
              "btree indexes only",
            ),
          ),
        )
      }),
    ))

  it("rejects tables that cannot be owned", () => {
    const reserved = pgTable("owned_reserved", {
      id: text("id").primaryKey(),
      actorId: text("actor_id"),
    })

    const keyless = pgTable("owned_keyless", { id: text("id") })
    const parent = pgTable("owned_parent", { id: text("id").primaryKey() })

    const inline = pgTable("owned_inline", {
      id: text("id").primaryKey(),
      parent: text("parent").references(() => parent.id),
    })

    const declared = pgTable(
      "owned_declared",
      { id: text("id").primaryKey(), parent: text("parent") },
      (table) => [foreignKey({ columns: [table.parent], foreignColumns: [parent.id] })],
    )

    const twice = Actor.table(pgTable("owned_twice", { id: text("id").primaryKey() }))

    expect(() => Actor.table(reserved)).toThrow("reserved for ownership")
    expect(() => Actor.table(keyless)).toThrow("needs a primary key")
    expect(() => Actor.table(inline)).toThrow("cannot declare foreign keys")
    expect(() => Actor.table(declared)).toThrow("cannot declare foreign keys")
    expect(() => Actor.table(alias(parent, "p"))).toThrow("not an alias")
    expect(() => Actor.table(twice)).toThrow("already owned")
  })

  it("gives one actor type a table and types rows by the declared tables", () => {
    const owned = Actor.table(pgTable("owned_single", { id: text("id").primaryKey() }))
    const other = Actor.table(pgTable("owned_other", { id: text("id").primaryKey() }))
    const Ping = Actor.command("Ping")
    const Owner = Actor.make("Owner", { tables: [owned], api: { Ping } })

    expect(() => Actor.make("Owner", { tables: [owned], api: { Ping } })).not.toThrow()
    expect(() => Actor.make("Intruder", { tables: [owned], api: { Ping } })).toThrow(
      "already owned by actor Owner",
    )
    expect(() => Actor.make("Twice", { tables: [other, other], api: { Ping } })).toThrow(
      "listed twice",
    )
    expect(() =>
      Actor.make("Plain", {
        // @ts-expect-error tables takes Actor.table values
        tables: [pgTable("owned_plain", { id: text("id").primaryKey() })],
        api: { Ping },
      }),
    ).toThrow("Actor.table values")

    Owner.toLayer(
      Effect.succeed({
        Ping: Effect.fnUntraced(function* () {
          const turn = yield* Owner.Turn
          yield* turn.rows(owned).insert({ id: "x" })
          // @ts-expect-error ownership columns come from the turn
          yield* turn.rows(owned).insert({ id: "x", actor_id: "other" })
          // @ts-expect-error only declared tables have rows
          yield* turn.rows(other).all()
        }),
      }),
    )

    expectTypeOf<keyof ReturnType<(typeof Owner.Read)["Service"]["rows"]>>().toEqualTypeOf<
      "one" | "all" | "count"
    >()
  })

  it("adopts an existing table by adding only a nullable routing_key, keeping its keys and foreign keys", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const accounts = pgTable("adopted_accounts", { id: text("id").primaryKey() })

        const invoices = pgTable("adopted_invoices", {
          id: text("id").primaryKey(),
          orgId: text("org_id").notNull(),
          accountId: text("account_id").notNull(),
          account: text("account").references(() => accounts.id),
          amount: integer("amount").notNull(),
        })

        const rows = Actor.table(invoices, {
          owner: { tenant: invoices.orgId, actor: invoices.accountId },
        })

        const ddl = (yield* migration({ accounts, rows })).join("\n").replaceAll(/\s+/g, " ")

        expect(ddl).toContain(`"routing_key" bigint`)
        expect(ddl).toContain(`"id" text PRIMARY KEY, "org_id" text NOT NULL`)
        expect(ddl).toContain(`FOREIGN KEY ("account") REFERENCES "adopted_accounts"("id")`)
        expect(ddl).toContain(`"amount" integer NOT NULL, "routing_key" bigint )`)
        expect(ddl).not.toContain("durable_tenant")
        expect(ddl).not.toContain(`"tenant_id"`)

        expectTypeOf<keyof Row<typeof rows>>().toEqualTypeOf<
          "id" | "orgId" | "accountId" | "account" | "amount"
        >()
        expectTypeOf<Insert<typeof rows>["amount"]>().toEqualTypeOf<number>()
        expectTypeOf<Insert<typeof rows>>().not.toHaveProperty("routing_key")
      }),
    ))

  it("gives a read-adopted table no mutation methods and adds no column", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const contacts = pgTable("adopted_contacts", {
          id: text("id").primaryKey(),
          tenant: text("tenant").notNull(),
          owner: text("owner").notNull(),
        })

        const rows = Actor.table(contacts, {
          owner: { tenant: contacts.tenant, actor: contacts.owner },
          access: "read",
        })

        const ddl = (yield* migration({ rows })).join("\n")

        expect(ddl).not.toContain("routing_key")
        expectTypeOf<keyof TurnRows<typeof rows>>().toEqualTypeOf<"one" | "all" | "count">()
      }),
    ))
})
