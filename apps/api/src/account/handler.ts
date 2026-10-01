import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Cookies, HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Api, Forbidden } from "@durable-actors/contracts"
import { Auth } from "@durable-actors/accounts"
import type { Config } from "../config.ts"
import * as account from "./service.ts"

const mutation = Effect.fn("Api.mutation")(function* (origin: string) {
  const request = yield* HttpServerRequest.HttpServerRequest

  if (request.headers.origin !== origin)
    return yield* Forbidden.make({ message: "Invalid request origin" })
})

/**
 * Handlers of the `account` group; every state-changing one requires the
 * request `Origin` to equal the configured origin.
 */
export const accountLive = (config: Config) =>
  HttpApiBuilder.group(Api, "account", (handlers) =>
    handlers
      .handle("session", account.session)
      .handle("dashboard", account.dashboard)
      .handle(
        "organization",
        Effect.fn("Api.organization.handler")(function* ({ payload }) {
          yield* mutation(config.origin)
          const request = yield* HttpServerRequest.HttpServerRequest

          const { organization, cookies } = yield* account.createOrganization(
            payload,
            new Headers(request.headers),
          )

          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(
              HttpServerResponse.replaceCookies(
                response,
                Cookies.merge(response.cookies, Cookies.fromSetCookie(cookies)),
              ),
            ),
          )

          return organization
        }),
      )
      .handle("projects", account.projects)
      .handle(
        "createProject",
        Effect.fn("Api.createProject.handler")(function* ({ payload }) {
          yield* mutation(config.origin)

          return yield* account.createProject(payload.name)
        }),
      )
      .handle(
        "checkout",
        Effect.fn("Api.checkout.handler")(function* () {
          yield* mutation(config.origin)

          return yield* account.checkout()
        }),
      )
      .handle(
        "portal",
        Effect.fn("Api.portal.handler")(function* () {
          yield* mutation(config.origin)

          return yield* account.portal()
        }),
      ),
  )

/** Serves the auth library under `/auth/*`. */
export const authRoute = HttpRouter.add(
  "*",
  "/auth/*",
  Effect.gen(function* () {
    return yield* (yield* Auth).fetch
  }),
)
