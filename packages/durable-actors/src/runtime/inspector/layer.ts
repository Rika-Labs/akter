import { type Cause, Effect, Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { Anonymous, User } from "../../identity/caller.ts"
import { type AuthProvider, withinLimits } from "../../serve/auth.ts"
import { actorErrorResponse, Defect, undecodable } from "../../serve/wire.ts"
import * as Queries from "./queries.ts"

export interface InspectorOptions<R> {
  /**
   * Authenticates every inspector request. The inspector reads only the
   * authenticated principal's tenant, and every actor of it, so give it an
   * operator's provider, not the one end users call `Actor.serve` with.
   */
  readonly auth: AuthProvider<R>
  /** Prefix for every route. Default `"/inspector"`. */
  readonly basePath?: `/${string}`
}

const DEFAULT_LIMIT = 50

const Limit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Queries.MAX_LIMIT }),
).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_LIMIT)))

const PageParams = Schema.Struct({ limit: Limit })

const ActorsParams = Schema.Struct({
  limit: Limit,
  type: Schema.optional(Schema.String),
  afterType: Schema.optional(Schema.String),
  afterId: Schema.optional(Schema.String),
})

const ActorParams = Schema.Struct({ limit: Limit, type: Schema.String, id: Schema.String })

const WorkflowsParams = Schema.Struct({
  limit: Limit,
  status: Schema.optional(Schema.Literals(["open", "all"])),
})

const isPrincipal = Schema.is(Schema.Union([User, Anonymous]))

/** The body of a 404: the tenant has no such actor. */
const NotFound = Schema.TaggedStruct("NotFound", {})

const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "0".repeat(32)),
)

const defectResponse = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
  const trace = yield* traceId

  yield* Effect.logError("Inspector request failed", cause)

  return HttpServerResponse.jsonUnsafe(Defect.make({ traceId: trace }), { status: 500 })
})

/**
 * Serves read-only JSON over the `durable` inspection views as routes on the
 * application's `HttpRouter`. Each request is authenticated, and every read
 * is filtered to the principal's tenant and runs in a read-only transaction.
 *
 * - `GET /overview`: the view catalog and the tenant's row counts.
 * - `GET /actors?type&afterType&afterId&limit`: actors, one keyset page at a time.
 * - `GET /actor?type&id&limit`: one actor's state, receipts with the events
 *   each committed, events, outbox, effects, dead letters, and workflows with steps.
 * - `GET /outbox`, `/effects`, `/dead-letters`, `/workflows?status=open|all`: tenant-wide lists.
 */
const serve = <R = never>(options: InspectorOptions<R>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const basePath = (options.basePath ?? "/inspector").replace(/\/+$/, "")
      const context = yield* Effect.context<R>()
      const sql = yield* SqlClient.SqlClient

      // Per request, never cached: the tenant is the one fact every read below trusts.
      const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const authenticated = yield* options.auth
            .authenticate({
              headers: request.headers,
              cookies: options.auth.cookies ? request.cookies : {},
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

      const route = <A, I extends Readonly<Record<string, string | undefined>>, E>(
        path: string,
        params: Schema.Codec<A, I>,
        read: (
          tenant: string,
          params: A,
        ) => Effect.Effect<Option.Option<unknown>, E, SqlClient.SqlClient>,
      ) =>
        router.add(
          "GET",
          `${basePath}${path}` as HttpRouter.PathInput,
          (request: HttpServerRequest.HttpServerRequest) =>
            Effect.gen(function* () {
              const tenant = yield* authenticate(request)

              const decoded = yield* HttpRouter.schemaParams(params).pipe(
                Effect.mapError(undecodable),
              )

              const body = yield* Queries.readOnly(read(tenant, decoded)).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.orDie,
              )

              return Option.match(body, {
                onNone: () => HttpServerResponse.jsonUnsafe(NotFound.make({}), { status: 404 }),
                onSome: (value) => HttpServerResponse.jsonUnsafe(value),
              })
            }).pipe(
              Effect.catch(actorErrorResponse),
              Effect.catchCause(defectResponse),
              Effect.map((response) =>
                HttpServerResponse.setHeaders(response, { "cache-control": "no-store" }),
              ),
            ),
        )

      yield* route("/overview", Schema.Struct({}), (tenant) =>
        Effect.asSome(Queries.overview({ tenant })),
      )

      yield* route("/actors", ActorsParams, (tenant, { limit, type, afterType, afterId }) =>
        Effect.asSome(
          Queries.actors({
            tenant,
            limit,
            actorType: type,
            after:
              afterType === undefined || afterId === undefined
                ? undefined
                : { actorType: afterType, actorId: afterId },
          }),
        ),
      )

      yield* route("/actor", ActorParams, (tenant, { limit, type, id }) =>
        Queries.actor({ tenant, limit, actorType: type, actorId: id }),
      )

      yield* route("/outbox", PageParams, (tenant, { limit }) =>
        Effect.asSome(Queries.outbox({ tenant, limit })),
      )

      yield* route("/effects", PageParams, (tenant, { limit }) =>
        Effect.asSome(Queries.effects({ tenant, limit })),
      )

      yield* route("/dead-letters", PageParams, (tenant, { limit }) =>
        Effect.asSome(Queries.deadLetters({ tenant, limit })),
      )

      yield* route("/workflows", WorkflowsParams, (tenant, { limit, status }) =>
        Effect.asSome(Queries.workflows({ tenant, limit, status: status ?? "open" })),
      )
    }),
  )

export const Inspector = { serve }
