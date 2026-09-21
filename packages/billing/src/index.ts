import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { checkoutsCreate, customerSessionsCreate } from "@distilled.cloud/polar"
import { Credentials, fromApiKey } from "@distilled.cloud/polar/Credentials"

export class BillingError extends Schema.TaggedError<BillingError>()("BillingError", {
  message: Schema.String,
}) {}

export class Billing extends Context.Service<
  Billing,
  {
    checkout(organizationId: string): Effect.Effect<{ url: string }, BillingError>
    portal(organizationId: string): Effect.Effect<{ url: string }, BillingError>
  }
>()("@durable-actors/billing/Billing") {}

export const disabledLayer = Layer.succeed(Billing, {
  checkout: () => Effect.fail(BillingError.make({ message: "Billing is not configured" })),
  portal: () => Effect.fail(BillingError.make({ message: "Billing is not configured" })),
})

export interface PolarConfig {
  readonly accessToken: string
  readonly productId: string
  readonly origin: string
  readonly sandbox: boolean
}

export const polarLayer = (config: PolarConfig) => {
  const provider = Layer.merge(
    fromApiKey({
      apiKey: config.accessToken,
      apiBaseUrl: config.sandbox ? "https://sandbox-api.polar.sh" : "https://api.polar.sh",
    }),
    FetchHttpClient.layer,
  )

  return Layer.effect(
    Billing,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient>()

      return {
        checkout: Effect.fn("Billing.checkout")(function* (organizationId: string) {
          const checkout = yield* checkoutsCreate({
            products: [config.productId],
            external_customer_id: organizationId,
            metadata: { organizationId },
            customer_metadata: { organizationId },
            success_url: `${config.origin}/dashboard?checkout=success`,
            return_url: `${config.origin}/dashboard`,
          }).pipe(
            Effect.provideContext(context),
            Effect.mapError(() => BillingError.make({ message: "Checkout could not be created" })),
          )

          return { url: checkout.url }
        }),
        portal: Effect.fn("Billing.portal")(function* (organizationId: string) {
          const session = yield* customerSessionsCreate({
            body: {
              external_customer_id: organizationId,
              return_url: `${config.origin}/dashboard`,
            },
          }).pipe(
            Effect.provideContext(context),
            Effect.mapError(() =>
              BillingError.make({ message: "Customer portal could not be created" }),
            ),
          )

          return { url: session.customer_portal_url }
        }),
      }
    }),
  ).pipe(Layer.provide(provider))
}
