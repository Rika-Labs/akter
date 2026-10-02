import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import type { InferSelectModel } from "drizzle-orm"
import { bigint, boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { Actor, Fleet } from "../index.ts"

const orders = Actor.table(
  pgTable("fleet_decl_orders", {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
    region: text("region"),
    amountCents: integer("amount_cents").notNull(),
    placedAt: timestamp("placed_at", { mode: "date" }).notNull(),
    archived: boolean("archived").notNull(),
    note: text("note"),
    big: bigint("big", { mode: "bigint" }),
  }),
)

describe("fleet view declarations", () => {
  it("derives a tenant-first table with the group columns, aggregates, as_of, and the tenant policy", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const byStatus = Fleet.view("OrdersByStatus", {
          from: orders,
          where: { archived: false },
          groupBy: ["status"],
          select: {
            orders: Fleet.count(),
            total: Fleet.sum("amountCents"),
            mean: Fleet.avg("amountCents"),
            first: Fleet.min("placedAt"),
          },
        })

        const before = yield* Effect.promise(() => generateDrizzleJson({}))
        const after = yield* Effect.promise(() => generateDrizzleJson({ table: byStatus.table }))

        const ddl = (yield* Effect.promise(() => generateMigration(before, after)))
          .join("\n")
          .replaceAll(/\s+/g, " ")

        expect(byStatus.tableName).toBe("fleet_orders_by_status")
        expect(ddl).toContain(`CREATE TABLE "fleet_orders_by_status"`)
        expect(ddl).toContain(`"tenant_id" text,`)
        expect(ddl).toContain(`"status" text,`)
        expect(ddl).toContain(`"orders" bigint NOT NULL`)
        expect(ddl).toContain(`"total" bigint NOT NULL`)
        expect(ddl).toContain(`"mean" double precision NOT NULL`)
        expect(ddl).toContain(`"first" timestamp`)
        expect(ddl).toContain(`"as_of" numeric NOT NULL`)
        expect(ddl).toContain(`PRIMARY KEY("tenant_id","status")`)
        expect(ddl).toContain(`CREATE POLICY "durable_tenant" ON "fleet_orders_by_status"`)
        expect(byStatus.aggregates).toEqual([
          { key: "orders", kind: "count", column: undefined },
          { key: "total", kind: "sum", column: "amount_cents" },
          { key: "mean", kind: "avg", column: "amount_cents" },
          { key: "first", kind: "min", column: "placed_at" },
        ])

        type Derived = InferSelectModel<typeof byStatus.table>

        expectTypeOf<Derived["status"]>().toEqualTypeOf<string>()
        expectTypeOf<Derived["orders"]>().toEqualTypeOf<number>()
        expectTypeOf<Derived["first"]>().toEqualTypeOf<Date | null>()
        expectTypeOf<Derived["as_of"]>().toEqualTypeOf<string>()
      }),
    ))

  it("hashes what decides the rows, so a changed filter or selection changes the hash", () => {
    const make = (archived: boolean, select: "count" | "sum") =>
      Fleet.view("HashProbe", {
        from: orders,
        where: { archived },
        groupBy: ["status"],
        select: { value: select === "count" ? Fleet.count() : Fleet.sum("amountCents") },
      }).definitionHash

    expect(make(false, "count")).toBe(make(false, "count"))
    expect(make(true, "count")).not.toBe(make(false, "count"))
    expect(make(false, "sum")).not.toBe(make(false, "count"))
  })

  it("refuses a nullable or ownership group column, an empty selection, and sums over non-integers", () => {
    const refused = [
      () =>
        Fleet.view("NullGroup", {
          from: orders,
          groupBy: ["region"],
          select: { n: Fleet.count() },
        }),
      () =>
        Fleet.view("OwnerGroup", {
          from: orders,
          groupBy: ["tenant_id" as "status"],
          select: { n: Fleet.count() },
        }),
      () => Fleet.view("Empty", { from: orders, groupBy: ["status"], select: {} }),
      () =>
        Fleet.view("SumText", {
          from: orders,
          groupBy: ["status"],
          select: { n: Fleet.sum("note" as "amountCents") },
        }),
      () =>
        Fleet.view("lowercase", {
          from: orders,
          groupBy: ["status"],
          select: { n: Fleet.count() },
        }),
      () =>
        Fleet.view("Clash", {
          from: orders,
          groupBy: ["status"],
          select: { status: Fleet.count() },
        }),
    ]

    for (const declare of refused) expect(declare).toThrow()
  })

  it("rejects a sum over a text column at the type level", () => {
    const declare = () =>
      Fleet.view("TypedSum", {
        from: orders,
        groupBy: ["status"],
        // @ts-expect-error a sum takes a numeric column
        select: { n: Fleet.sum("note") },
      })

    expect(declare).toThrow()
  })
})
