import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { PrometheusMetrics } from "effect/unstable/observability"

export interface TelemetryOptions {
  /** Prefix for the route. Default none: `/metrics`. */
  readonly basePath?: `/${string}`
}

/**
 * Serves this runner's metrics on the application's `HttpRouter` as
 * `GET /metrics`, in Prometheus text exposition. Metric attributes carry no
 * tenant or actor id, so the route is unauthenticated, like any scrape
 * target; keep it on a private listener. Defect spans are an operator read,
 * served by `Operators.serve`.
 */
const serve = (options: TelemetryOptions = {}) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const basePath = (options.basePath ?? "").replace(/\/+$/, "")

      yield* router.add("GET", `${basePath}/metrics` as HttpRouter.PathInput, () =>
        PrometheusMetrics.format().pipe(
          Effect.map((body) =>
            HttpServerResponse.text(body, {
              contentType: "text/plain; version=0.0.4; charset=utf-8",
            }),
          ),
        ),
      )
    }),
  )

export const Telemetry = { serve }
