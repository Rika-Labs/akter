import { Duration, Effect, Exit } from "effect"
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http"

const HEALTH_ROUTE = "/ready"

/**
 * Writes one structured log line per routed request once its response is known: the method, the
 * matched route pattern, the status and the duration in milliseconds. It never records the
 * request URL, a header or an address, because verification and reset tokens travel in the
 * path and the query of Better Auth routes, so a route is its pattern (`/auth/*`,
 * `/api/projects/:id`) and never the URL that matched. A request that matches no route is not
 * logged. The platform's health probe is logged at debug level so it does not drown the rest.
 */
export const RequestLogLive = HttpRouter.middleware((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const { route } = yield* HttpRouter.RouteContext
    const [duration, exit] = yield* Effect.timed(Effect.exit(app))
    const [response] = Exit.isSuccess(exit)
      ? [exit.value]
      : yield* HttpServerError.causeResponse(exit.cause)
    const log = route.path === HEALTH_ROUTE ? Effect.logDebug : Effect.logInfo
    yield* log("http.request").pipe(
      Effect.annotateLogs({
        "http.request.method": request.method,
        "http.route": route.path,
        "http.response.status_code": response.status,
        "http.server.duration_ms": Math.round(Duration.toMillis(duration)),
      }),
    )
    return yield* exit
  }),
).layer
