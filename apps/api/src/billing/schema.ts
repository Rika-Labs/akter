import { pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { organization } from "@durable-actors/postgres/schema"

export const organizationBilling = pgTable("organization_billing", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  subscriptionId: text("subscription_id").notNull(),
  customerId: text("customer_id").notNull(),
  plan: text({ enum: ["free", "pro"] }).notNull(),
  status: text().notNull(),
  renewalDate: timestamp("renewal_date", { withTimezone: true }),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
})

export const billingWebhook = pgTable("billing_webhook", {
  id: text().primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
})
