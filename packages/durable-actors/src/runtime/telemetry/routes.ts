import { Effect, Schema } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { PrometheusMetrics } from "effect/unstable/observability"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { Anonymous, User } from "../../identity/caller.ts"
import { type AuthProvider, readsCookies, withinLimits } from "../../serve/auth.ts"
import { actorErrorResponse, undecodable } from "../../serve/wire.ts"
import { DefectLog } from "./defects.ts"

export interface TelemetryOptions<R> {
  /**
   * Authenticates `GET /defects`. Its principal's tenant is the only one whose
   * defects it lists, so give it an operator's provider, not the one end
   * users call `Actor.serve` with.
   */
  readonly auth: AuthProvider<R>
  /** Prefix for both routes. Default none: `/metrics` and `/defects`. */
  readonly basePath?: `/${string}`
}

/** The most defects one request returns. */
export const MAX_DEFECTS = 1000

const DefectsParams = Schema.Struct({
  actor: Schema.optional(Schema.NonEmptyString),
  sinceMs: Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_DEFECTS }),
    ),
  ),
})

const isPrincipal = Schema.is(Schema.Union([User, Anonymous]))

/**
 * Serves this runner's telemetry on the application's `HttpRouter`:
 *
 * - `GET /metrics`: every metric in Prometheus text exposition. Metric
 *   attributes carry no tenant or actor id, so the route is unauthenticated,
 *   like any scrape target; keep it on a private listener.
 * - `GET /defects?actor&sinceMs&limit`: the defect turn spans this runner
 *   kept, newest last, for the authenticated principal's tenant only.
 */
const serve = <R = never>(options: TelemetryOptions<R>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const basePath = (options.basePath ?? "").replace(/\/+$/, "")
      const context = yield* Effect.context<R>()
      const defects = yield* DefectLog

      yield* router.add("GET", `${basePath}/metrics` as HttpRouter.PathInput, () =>
        PrometheusMetrics.format().pipe(
          Effect.map((body) =>
            HttpServerResponse.text(body, {
              contentType: "text/plain; version=0.0.4; charset=utf-8",
            }),
          ),
        ),
      )

      const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const authenticated = yield* options.auth
            .authenticate({
              headers: request.headers,
              cookies: readsCookies(options.auth) ? request.cookies : {},
            })
            .pipe(
              Effect.provideContext(context),
              Effect.mapError((reason) => ActorError.make({ reason })),
            )

          if (!isPrincipal(authenticated.caller) || !withinLimits(authenticated))
            return yield* ActorError.make({
              reason: Unauthorized.make({ code: "invalid_credentials" }),
            })

          return authenticated.tenant
        })

      yield* router.add(
        "GET",
        `${basePath}/defects` as HttpRouter.PathInput,
        (request: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const tenant = yield* authenticate(request)

            const params = yield* HttpRouter.schemaParams(DefectsParams).pipe(
              Effect.mapError(undecodable),
            )

            const listed = yield* defects.list({
              actorType: params.actor,
              sinceMs: params.sinceMs,
            })

            const own = listed.filter((defect) => defect.tenant === tenant)

            return HttpServerResponse.jsonUnsafe(own.slice(-(params.limit ?? MAX_DEFECTS)), {
              headers: { "cache-control": "no-store" },
            })
          }).pipe(Effect.catch(actorErrorResponse)),
      )
    }),
  )

export const Telemetry = { serve }
