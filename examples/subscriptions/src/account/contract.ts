import { Actor } from "@durable-actors/core"
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"
import { accountAccess } from "./access.ts"

/** An account's key: a non-empty string. */
export const AccountId = Schema.NonEmptyString.pipe(Schema.brand("AccountId"))

/** Subscription plans. */
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

/** An invoice was issued for the period, in cents. */
export class InvoiceIssued extends Actor.Event<InvoiceIssued>()("InvoiceIssued", {
  invoiceId: Schema.String,
  amountCents: Schema.Int,
}) {}

/** An invoice was paid after `attempts` charges. */
export class InvoicePaid extends Actor.Event<InvoicePaid>()("InvoicePaid", {
  invoiceId: Schema.String,
  attempts: Schema.Int,
}) {}

/** An invoice stayed unpaid after `attempts` charges. */
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

/** An account's billing status. */
export const Status = Schema.Literals(["active", "past_due", "cancelled"])

/** Account state: plan, status, billing period and the count of cards on file. */
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

/** The provider declined the charge. */
export const Declined = Schema.TaggedStruct("Declined", {
  reason: Schema.String,
  cardVersion: Schema.Int,
})

/** The provider's answer to a charge. */
export const ChargeOutcome = Schema.Union([Approved, Declined])

/** A charge for an invoice, in cents. */
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

/** Workflow step: the first charge. */
export const Charge = Collect.step("charge", { input: ChargeRequest, success: ChargeOutcome })

/** Workflow step: the first retry. */
export const FirstRetry = Collect.step("retry-1", { input: ChargeRequest, success: ChargeOutcome })

/** Workflow step: the second retry. */
export const SecondRetry = Collect.step("retry-2", { input: ChargeRequest, success: ChargeOutcome })

/** Waits for a card newer than the one that was declined, before the first retry. */
export const FirstCard = Collect.wait("card-1", CardUpdated)

/** Waits for a newer card before the second retry. */
export const SecondCard = Collect.wait("card-2", CardUpdated)

/** How a collection ended: whether the invoice was paid and after how many attempts. */
export const Settlement = Schema.Struct({
  invoiceId: Schema.String,
  paid: Schema.Boolean,
  attempts: Schema.Int,
})

/** Workflow step that reports the settlement to the account. */
export const Report = Collect.step("report", { input: Settlement })

/** Creates the account on a plan with its first card. */
export const Subscribe = Actor.command("Subscribe", {
  input: Schema.Struct({ plan: Plan, card: Schema.String }),
})

/** Attaches a new card token, which a waiting collection picks up. */
export const UpdateCard = Actor.command("UpdateCard", { input: Schema.String })

/** Cancels the account; its cron schedule keeps ticking but issues nothing. */
export const Cancel = Actor.command("Cancel")

/**
 * Records the outcome of `Collect`. It is public because a workflow reaches
 * its owner through an ordinary handle; the account's `access` refuses it to every
 * external caller, as it does `Collect`.
 */
export const Settle = Actor.command("Settle", { input: Settlement })

/** The account's plan, status, period and card version. */
export const Summary = Actor.query("Summary", {
  output: Schema.Struct({
    plan: Plan,
    status: Status,
    period: Schema.Int,
    cardVersion: Schema.Int,
  }),
})

/** The account's invoices, oldest period first. */
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

/** Issues the next period's invoice; cron sends it at midnight UTC on the 1st of each month. */
export const Renew = Actor.command("Renew")

/** A card reached the provider; the first one issues the first invoice. */
export const CardAttached = Actor.command("CardAttached")

/**
 * A subscription account that bills itself. `Renew` and `CardAttached` are
 * internal: only System callers (cron and the effect route) reach them.
 */
export const Account = Actor.make("Account", {
  key: AccountId,
  state: AccountState,
  tables: [invoices],
  events: [InvoiceIssued, InvoicePaid, InvoiceFailed, CardUpdated],
  effects: [AttachCard],
  api: { Subscribe, UpdateCard, Cancel, Settle, Summary, Invoices, Collect },
  internal: { Renew, CardAttached },
  access: accountAccess,
  policy: {
    createdBy: Subscribe,
    cron: { "0 0 1 * *": Renew },
    effects: { AttachCard: { onSuccess: CardAttached } },
  },
})
