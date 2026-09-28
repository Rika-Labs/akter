import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

/** The provider refused the charge and applied nothing, so retrying the same key is safe. */
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", {
  reason: Schema.String,
}) {}

export const ChargeRequest = Schema.Struct({ customerId: Schema.String, amount: Schema.Int })

export const ChargeReceipt = Schema.Struct({ chargeId: Schema.String })

const Declined = Schema.Struct({ reason: Schema.String })

/**
 * The payment provider. `idempotencyKey` is the effect id: the provider
 * applies at most one charge per key, however many attempts reach it.
 */
export class Payments extends Context.Service<
  Payments,
  {
    readonly charge: (
      request: typeof ChargeRequest.Type,
      options: { readonly idempotencyKey: string },
    ) => Effect.Effect<typeof ChargeReceipt.Type, PaymentDeclined>
  }
>()("@durable-actors/orders/payments/client/Payments") {
  /**
   * A provider over HTTP: `POST {url}/charges` with an `Idempotency-Key`
   * header. `402` is a decline. Anything else that is not a receipt, and any
   * transport failure, is a defect: the provider may have applied the charge,
   * so the attempt's outcome is unknown and the next attempt reuses the key.
   */
  static readonly http = (url: string) =>
    Layer.effect(
      Payments,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient

        return {
          charge: (request, { idempotencyKey }) =>
            Effect.gen(function* () {
              const response = yield* HttpClientRequest.post(`${url}/charges`).pipe(
                HttpClientRequest.setHeader("idempotency-key", idempotencyKey),
                HttpClientRequest.bodyJsonUnsafe(request),
                client.execute,
              )

              if (response.status === 402)
                return yield* HttpClientResponse.schemaBodyJson(Declined)(response).pipe(
                  Effect.flatMap(({ reason }) => PaymentDeclined.make({ reason })),
                )

              return yield* HttpClientResponse.schemaBodyJson(ChargeReceipt)(response)
            }).pipe(
              Effect.catchTags({
                HttpClientError: Effect.die,
                SchemaError: Effect.die,
              }),
            ),
        }
      }),
    )
}
