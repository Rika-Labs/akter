import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organization } from "@durable-actors/postgres/schema"

/** Projects of an organization. */
export const project = pgTable("project", {
  id: text().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text().notNull(),
  status: text({ enum: ["active", "archived"] })
    .notNull()
    .default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
