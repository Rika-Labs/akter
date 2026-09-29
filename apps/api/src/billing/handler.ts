import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import type { Config } from "../config.ts"
import { processWebhook } from "./service.ts"

/**
 * `POST /api/billing/webhook`: 503 without Polar, 413 above 1 MiB, 400 for an
 * invalid webhook, otherwise 204.
 */
export const webhookRoute = (config: Config) =>
  HttpRouter.add(
    "POST",
    "/api/billing/webhook",
    Effect.gen(function* () {
      if (config.polar === undefined) return HttpServerResponse.empty({ status: 503 })
      const request = yield* HttpServerRequest.HttpServerRequest
      const body = yield* request.text

      if (body.length > 1_048_576) return HttpServerResponse.empty({ status: 413 })

      yield* processWebhook(body, new Headers(request.headers), config.polar)

      return HttpServerResponse.empty({ status: 204 })
    }).pipe(
      Effect.catchTag("InvalidWebhook", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      ),
    ),
  )
