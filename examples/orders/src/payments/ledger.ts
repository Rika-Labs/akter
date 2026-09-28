import { Effect, Layer, Option, Schema } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { type ChargeReceipt, ChargeRequest, PaymentDeclined, Payments } from "./client.ts"

/** The largest charge the fake provider accepts, in cents; larger ones are declined. */
export const CHARGE_LIMIT = 1_000_000

const declined = Schema.is(PaymentDeclined)

export interface AppliedCharge {
  readonly chargeId: string
  readonly customerId: string
  readonly amount: number
}

/**
 * A fake payment provider's books. It records every call, applies at most one
 * charge per idempotency key, and answers a repeated key with the first
 * charge's receipt, as real providers do.
 */
export const fakeLedger = () => {
  /** Applied charges by idempotency key. */
  const charges = new Map<string, AppliedCharge>()
  /** Calls by idempotency key, including repeats and declines. */
  const calls = new Map<string, number>()

  const charge = (
    request: typeof ChargeRequest.Type,
    idempotencyKey: string,
  ): typeof ChargeReceipt.Type | PaymentDeclined => {
    calls.set(idempotencyKey, (calls.get(idempotencyKey) ?? 0) + 1)
    const applied = charges.get(idempotencyKey)

    if (applied !== undefined) return { chargeId: applied.chargeId }

    if (request.amount > CHARGE_LIMIT) return PaymentDeclined.make({ reason: "over_limit" })

    const chargeId = `ch_${charges.size + 1}`
    charges.set(idempotencyKey, { chargeId, ...request })

    return { chargeId }
  }

  /** `Payments` answered from this ledger in the same process. */
  const layer = Layer.succeed(Payments, {
    charge: (request, { idempotencyKey }) =>
      Effect.suspend(() => {
        const result = charge(request, idempotencyKey)

        return declined(result) ? Effect.fail(result) : Effect.succeed(result)
      }),
  })

  /** The provider's HTTP API, as `Payments.http` calls it: `POST /charges` with `Idempotency-Key`. */
  const routes = HttpRouter.add(
    "POST",
    "/charges",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const key = Headers.get(request.headers, "idempotency-key")
      const body = yield* HttpServerRequest.schemaBodyJson(ChargeRequest).pipe(Effect.option)

      if (Option.isNone(key) || Option.isNone(body))
        return HttpServerResponse.empty({ status: 400 })

      const result = charge(body.value, key.value)

      return declined(result)
        ? HttpServerResponse.jsonUnsafe({ reason: result.reason }, { status: 402 })
        : HttpServerResponse.jsonUnsafe(result, { status: 201 })
    }),
  )

  return { charges, calls, charge, layer, routes }
}

export type Ledger = ReturnType<typeof fakeLedger>
