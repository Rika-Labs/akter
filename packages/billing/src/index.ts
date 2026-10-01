import { Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { checkoutsCreate, customerSessionsCreate } from "@distilled.cloud/polar"
import { Credentials, fromApiKey } from "@distilled.cloud/polar/Credentials"

/** Billing operation failed; the message is safe to show a user. */
export class BillingError extends Schema.TaggedError<BillingError>()("BillingError", {
  message: Schema.String,
}) {}

/**
 * Creates hosted checkout and customer-portal sessions for an organization;
 * each returns the URL to redirect to.
 */
export class Billing extends Context.Service<
  Billing,
  {
    checkout(organizationId: string): Effect.Effect<{ url: string }, BillingError>
    portal(organizationId: string): Effect.Effect<{ url: string }, BillingError>
  }
>()("@durable-actors/billing/Billing") {}

/** `Billing` for deployments without a provider; every operation fails with `BillingError`. */
export const disabledLayer = Layer.succeed(Billing, {
  checkout: () => Effect.fail(BillingError.make({ message: "Billing is not configured" })),
  portal: () => Effect.fail(BillingError.make({ message: "Billing is not configured" })),
})

/**
 * Polar settings: API `accessToken`, the `productId` sold at checkout, the app
 * `origin` Polar returns to, and whether to use the sandbox API.
 */
export interface PolarConfig {
  readonly accessToken: string
  readonly productId: string
  readonly origin: string
  readonly sandbox: boolean
}

/** `Billing` backed by Polar, with the organization id as the external customer id. */
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
