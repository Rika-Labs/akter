import type { Step } from "@durable-actors/core"
import { DateTime, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/unstable/sql"
import {
  Account,
  AccountId,
  AttachCard,
  CardUpdated,
  Charge,
  ChargeOutcome,
  ChargeRequest,
  FirstCard,
  FirstRetry,
  InvoiceFailed,
  InvoiceIssued,
  InvoicePaid,
  invoices,
  invoicesDdl,
  prices,
  Report,
  SecondCard,
  SecondRetry,
} from "./contract.ts"
import { PaymentGateway } from "./gateway.ts"

/** Each retry waits this long for a newer card before charging again. */
const RETRY_AFTER = "3 days"

export const AccountCommands = Account.toLayer(
  Effect.gen(function* () {
    const gateway = yield* PaymentGateway

    return {
      Subscribe: Effect.fnUntraced(function* ({ plan, card }) {
        const turn = yield* Account.Turn
        yield* turn.state.set({ plan, status: "active" })
        yield* turn.perform(AttachCard.make({ token: card }))
      }),

      UpdateCard: Effect.fnUntraced(function* (token: string) {
        yield* (yield* Account.Turn).perform(AttachCard.make({ token }))
      }),

      Cancel: Effect.fnUntraced(function* () {
        yield* (yield* Account.Turn).state.set({ status: "cancelled" })
      }),

      // The cron tick. A cancelled account keeps its schedule, so the tick checks state.
      Renew: Effect.fnUntraced(function* () {
        const turn = yield* Account.Turn

        if (turn.state.status === "cancelled") return Option.none()

        const period = turn.state.period + 1
        const invoiceId = `${turn.id}-${period}`
        const amountCents = prices[turn.state.plan]

        yield* turn.rows(invoices).insert({
          id: invoiceId,
          period,
          amountCents,
          status: "open",
          attempts: 0,
          issuedAt: DateTime.toDate(yield* DateTime.now),
        })
        yield* turn.emit(InvoiceIssued.make({ invoiceId, amountCents }))
        yield* turn.state.set({ period })

        // Starts with the turn's commit; the invoice id keys the execution.
        return Option.some(
          yield* (yield* Account.intents(turn.id)).Collect({ invoiceId, amountCents }),
        )
      }),

      CardAttached: Effect.fnUntraced(function* () {
        const turn = yield* Account.Turn
        const version = turn.state.cardVersion + 1
        yield* turn.state.set({ cardVersion: version })
        yield* turn.emit(CardUpdated.make({ version }))
      }),

      Settle: Effect.fnUntraced(function* ({ invoiceId, paid, attempts }) {
        const turn = yield* Account.Turn

        yield* turn
          .rows(invoices)
          .update({ status: paid ? "paid" : "failed", attempts })
          .where({ id: invoiceId })
        yield* turn.emit(
          paid
            ? InvoicePaid.make({ invoiceId, attempts })
            : InvoiceFailed.make({ invoiceId, attempts }),
        )

        if (turn.state.status !== "cancelled")
          yield* turn.state.set({ status: paid ? "active" : "past_due" })
      }),

      // Runs outside any turn. Steps record their results, so a resumed run
      // replays them instead of charging again.
      Collect: Effect.fnUntraced(function* (request) {
        const wf = yield* Account.Workflow

        const charge = (
          step: Step<string, typeof ChargeRequest, typeof ChargeOutcome, readonly []>,
        ) =>
          step.run(request, ({ amountCents }) =>
            Effect.gen(function* () {
              const account = yield* Account.get(AccountId.make(wf.id))
              const { cardVersion } = yield* account.Summary().pipe(Effect.orDie)

              // One key per step: a step rerun after a crash repeats the same charge.
              const result = yield* gateway.charge({
                customer: wf.id,
                amountCents,
                idempotencyKey: `${wf.executionId}:${step.name}`,
              })

              return { ...result, cardVersion }
            }),
          )

        let outcome = yield* charge(Charge)
        let attempts = 1

        for (const [card, retry] of [
          [FirstCard, FirstRetry],
          [SecondCard, SecondRetry],
        ] as const) {
          if (outcome._tag === "Approved") break
          const declined = outcome.cardVersion

          // A card newer than the declined one ends the wait early.
          yield* card({ where: ({ version }) => version > declined, timeout: RETRY_AFTER })
          outcome = yield* charge(retry)
          attempts += 1
        }

        const paid = outcome._tag === "Approved"

        yield* Report.run({ invoiceId: request.invoiceId, paid, attempts }, (settlement) =>
          Effect.gen(function* () {
            const account = yield* Account.get(AccountId.make(wf.id))
            yield* account.Settle(settlement).pipe(Effect.orDie)
          }),
        )

        return paid ? "paid" : "failed"
      }),
    }
  }),
)

export const AccountReads = Account.toQueryLayer(
  Effect.succeed({
    Summary: Effect.fnUntraced(function* () {
      const { plan, status, period, cardVersion } = (yield* Account.Read).state

      return { plan, status, period, cardVersion }
    }),
    Invoices: Effect.fnUntraced(function* () {
      const rows = yield* (yield* Account.Read).rows(invoices).all({ orderBy: { period: "asc" } })

      return rows.map(({ id, period, amountCents, status, attempts }) => ({
        id,
        period,
        amountCents,
        status,
        attempts,
      }))
    }),
  }),
)

/** May run in another process: it gets no database, only the provider. */
export const AccountEffects = Account.toEffectLayer(
  Effect.gen(function* () {
    const gateway = yield* PaymentGateway

    return {
      AttachCard: Effect.fnUntraced(function* ({ token }) {
        const exec = yield* Account.Executor
        yield* gateway.attach({ customer: exec.ref.id, token, idempotencyKey: exec.effectId })
      }),
    }
  }),
)

/** Creates the table as a drizzle-kit migration would, then registers the account. */
export const AccountLive = Layer.unwrap(
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(invoicesDdl)

    return Layer.mergeAll(AccountCommands, AccountReads, AccountEffects)
  }).pipe(Effect.orDie),
)
