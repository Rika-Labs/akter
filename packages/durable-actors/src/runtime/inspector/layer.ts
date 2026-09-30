import { Effect, type Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { Anonymous, User } from "../../identity/caller.ts"
import {
  type AuthProvider,
  CREDENTIAL_BYTES,
  oversizedCredential,
  readsCookies,
  withinLimits,
} from "../../serve/auth.ts"
import { invalidInput, undecodable } from "../../serve/wire.ts"
import { foundOrNotFound, operatorResponse, refuseCrossOrigin } from "./http.ts"
import * as Queries from "./queries.ts"

/** Configuration for `Inspector.serve`. */
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

/**
 * Serves read-only JSON over the `durable` inspection views as routes on the
 * application's `HttpRouter`. A request from another browser origin is
 * refused with `403` before its credentials are read, and a credential over
 * 8 KiB with `413` before its provider runs; each other request is
 * authenticated per request, never cached, since the tenant is the one fact
 * every read trusts. Every read is filtered to the principal's tenant and runs
 * in a read-only transaction.
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

      const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          if (
            oversizedCredential({
              provider: options.auth,
              headers: request.headers,
              limit: CREDENTIAL_BYTES,
            })
          )
            return yield* invalidInput("too_large")

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
              yield* refuseCrossOrigin(request)

              const tenant = yield* authenticate(request)

              const decoded = yield* HttpRouter.schemaParams(params).pipe(
                Effect.mapError(undecodable),
              )

              return foundOrNotFound(
                yield* Queries.readOnly(tenant)(read(tenant, decoded)).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.orDie,
                ),
              )
            }).pipe(operatorResponse("Inspector request failed")),
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

/** The read-only inspector: `serve` mounts its routes. */
export const Inspector = { serve }
