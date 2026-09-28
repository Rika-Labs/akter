import { Actor } from "@durable-actors/core"
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"

export const AccountId = Schema.NonEmptyString.pipe(Schema.brand("AccountId"))

export const Plan = Schema.Literals(["basic", "pro"])

/** Monthly price of each plan, in cents. */
export const prices: Record<typeof Plan.Type, number> = { basic: 900, pro: 2900 }

/** One row per billing period; the framework adds and scopes the ownership columns. */
export const invoices = Actor.table(
  pgTable("billing_invoices", {
    id: text("id").primaryKey(),
    period: integer("period").notNull(),
    amountCents: integer("amount_cents").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  }),
)

/** What drizzle-kit generates for `invoices`; the runtime checks its primary key at startup. */
export const invoicesDdl = `CREATE TABLE IF NOT EXISTS billing_invoices (
  routing_key bigint NOT NULL, tenant_id text NOT NULL, actor_id text NOT NULL,
  id text NOT NULL, period integer NOT NULL, amount_cents integer NOT NULL,
  status text NOT NULL, attempts integer NOT NULL, issued_at timestamp with time zone NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_id, id))`

export class InvoiceIssued extends Actor.Event<InvoiceIssued>()("InvoiceIssued", {
  invoiceId: Schema.String,
  amountCents: Schema.Int,
}) {}

export class InvoicePaid extends Actor.Event<InvoicePaid>()("InvoicePaid", {
  invoiceId: Schema.String,
  attempts: Schema.Int,
}) {}

export class InvoiceFailed extends Actor.Event<InvoiceFailed>()("InvoiceFailed", {
  invoiceId: Schema.String,
  attempts: Schema.Int,
}) {}

/** A new card reached the provider; `version` counts the account's cards. */
export class CardUpdated extends Actor.Event<CardUpdated>()("CardUpdated", {
  version: Schema.Int,
}) {}

/** Attaches a card token to the provider's customer after the turn commits. */
export class AttachCard extends Actor.effect<AttachCard>()("AttachCard", {
  input: { token: Schema.String },
}) {}

export const Status = Schema.Literals(["active", "past_due", "cancelled"])

export const AccountState = Actor.state({
  plan: Plan.pipe(Schema.withDecodingDefault(Effect.succeed("basic" as const))),
  status: Status.pipe(Schema.withDecodingDefault(Effect.succeed("active" as const))),
  period: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  cardVersion: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

/** The provider's answer to one charge, with the card version it was made against. */
export const Approved = Schema.TaggedStruct("Approved", {
  chargeId: Schema.String,
  cardVersion: Schema.Int,
})

export const Declined = Schema.TaggedStruct("Declined", {
  reason: Schema.String,
  cardVersion: Schema.Int,
})

export const ChargeOutcome = Schema.Union([Approved, Declined])

export const ChargeRequest = Schema.Struct({ invoiceId: Schema.String, amountCents: Schema.Int })

/**
 * Collects one invoice: a charge, then up to two retries. Each retry waits
 * three days, or less if the customer adds a newer card first.
 */
export const Collect = Actor.workflow("Collect", {
  input: ChargeRequest.fields,
  output: Schema.Literals(["paid", "failed"]),
  key: ({ invoiceId }) => invoiceId,
})

export const Charge = Collect.step("charge", { input: ChargeRequest, success: ChargeOutcome })

export const FirstRetry = Collect.step("retry-1", { input: ChargeRequest, success: ChargeOutcome })

export const SecondRetry = Collect.step("retry-2", { input: ChargeRequest, success: ChargeOutcome })

export const FirstCard = Collect.wait("card-1", CardUpdated)

export const SecondCard = Collect.wait("card-2", CardUpdated)

export const Settlement = Schema.Struct({
  invoiceId: Schema.String,
  paid: Schema.Boolean,
  attempts: Schema.Int,
})

export const Report = Collect.step("report", { input: Settlement })

export const Subscribe = Actor.command("Subscribe", {
  input: Schema.Struct({ plan: Plan, card: Schema.String }),
})

export const UpdateCard = Actor.command("UpdateCard", { input: Schema.String })

export const Cancel = Actor.command("Cancel")

/**
 * Records the outcome of `Collect`. It is public because a workflow reaches
 * its owner through an ordinary handle; `authorize` admits only the owner's
 * own workflow, as it does for `Collect`.
 */
export const Settle = Actor.command("Settle", { input: Settlement })

export const Summary = Actor.query("Summary", {
  output: Schema.Struct({
    plan: Plan,
    status: Status,
    period: Schema.Int,
    cardVersion: Schema.Int,
  }),
})

export const Invoices = Actor.query("Invoices", {
  output: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      period: Schema.Int,
      amountCents: Schema.Int,
      status: Schema.String,
      attempts: Schema.Int,
    }),
  ),
})

// Internal: only System callers (cron, and the effect route) reach them.
/** Issues the next period's invoice. */
export const Renew = Actor.command("Renew")

/** A card reached the provider; the first one issues the first invoice. */
export const CardAttached = Actor.command("CardAttached")

export const Account = Actor.make("Account", {
  key: AccountId,
  state: AccountState,
  tables: [invoices],
  events: [InvoiceIssued, InvoicePaid, InvoiceFailed, CardUpdated],
  effects: [AttachCard],
  api: { Subscribe, UpdateCard, Cancel, Settle, Summary, Invoices, Collect },
  internal: { Renew, CardAttached },
  policy: {
    createdBy: Subscribe,
    effects: { AttachCard: { onSuccess: CardAttached } },
  },
})
