import { Effect } from "effect"
import { eq, lt } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { organization } from "@durable-actors/postgres/schema"
import { billingWebhook, organizationBilling } from "./schema.ts"

/**
 * Records a subscription event once per event id and applies it only when
 * newer than the stored one, so replays and out-of-order deliveries change
 * nothing. Events for unknown organizations are recorded but create no billing
 * row.
 */
export const applySubscription = Effect.fn("Billing.applySubscription")(function* (event: {
  id: string
  organizationId: string
  subscriptionId: string
  customerId: string
  plan: "free" | "pro"
  status: string
  renewalDate: Date | null
  eventAt: Date
}) {
  const db = yield* PgDrizzle.makeWithDefaults()

  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const inserted = yield* tx
          .insert(billingWebhook)
          .values({ id: event.id })
          .onConflictDoNothing()
          .returning({ id: billingWebhook.id })

        if (inserted.length === 0) return

        const existing = yield* tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, event.organizationId))
          .limit(1)
          .for("key share")

        if (existing.length === 0) return

        const values = {
          organizationId: event.organizationId,
          subscriptionId: event.subscriptionId,
          customerId: event.customerId,
          plan: event.plan,
          status: event.status,
          renewalDate: event.renewalDate,
          eventAt: event.eventAt,
        }

        yield* tx
          .insert(organizationBilling)
          .values(values)
          .onConflictDoUpdate({
            target: organizationBilling.organizationId,
            set: values,
            setWhere: lt(organizationBilling.eventAt, event.eventAt),
          })
      }),
    )
    .pipe(Effect.orDie)
})
