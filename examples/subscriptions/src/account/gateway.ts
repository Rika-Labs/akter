import { Context, Effect, Layer } from "effect"

export type ChargeResult =
  | { readonly _tag: "Approved"; readonly chargeId: string }
  | { readonly _tag: "Declined"; readonly reason: string }

/**
 * The payment provider. Both calls take an idempotency key: the provider
 * applies a key once and answers every repeat with the first result, so a
 * retried effect or workflow step never charges twice.
 */
export class PaymentGateway extends Context.Service<
  PaymentGateway,
  {
    readonly attach: (request: {
      readonly customer: string
      readonly token: string
      readonly idempotencyKey: string
    }) => Effect.Effect<void>
    readonly charge: (request: {
      readonly customer: string
      readonly amountCents: number
      readonly idempotencyKey: string
    }) => Effect.Effect<ChargeResult>
  }
>()("@durable-actors/subscriptions/account/gateway/PaymentGateway") {}

/** A provider's ledger kept in memory: which card each customer has, and each key's result. */
export interface Ledger {
  readonly cards: Map<string, string>
  readonly results: Map<string, ChargeResult>
  /** Charge calls per idempotency key, including repeats the provider deduplicated. */
  readonly calls: Map<string, number>
}

export const ledger = (): Ledger => ({ cards: new Map(), results: new Map(), calls: new Map() })

/** A stand-in provider: the card token `tok_declined` declines, any other card is approved. */
export const fakeGateway = (book: Ledger) =>
  Layer.succeed(PaymentGateway, {
    attach: ({ customer, token }) => Effect.sync(() => void book.cards.set(customer, token)),
    charge: ({ customer, amountCents, idempotencyKey }) =>
      Effect.sync(() => {
        book.calls.set(idempotencyKey, (book.calls.get(idempotencyKey) ?? 0) + 1)
        const first = book.results.get(idempotencyKey)

        if (first !== undefined) return first
        const card = book.cards.get(customer)

        const result: ChargeResult =
          card === undefined
            ? { _tag: "Declined", reason: "no card" }
            : card === "tok_declined"
              ? { _tag: "Declined", reason: "card declined" }
              : { _tag: "Approved", chargeId: `ch_${book.results.size + 1}_${amountCents}` }

        book.results.set(idempotencyKey, result)

        return result
      }),
  })
