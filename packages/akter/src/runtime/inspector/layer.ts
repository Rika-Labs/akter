import { Effect, type Option, Schema } from "effect"
import { HttpRouter, type HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
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

const Millis = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

/** Refuses a keyset cursor that names only some of its fields, which would silently restart the list. */
const whole = <Key extends string>(...keys: ReadonlyArray<Key>) =>
  Schema.makeFilter((params: Readonly<Partial<Record<Key, string | number>>>) => {
    const named = keys.filter((key) => params[key] !== undefined).length

    return named === 0 || named === keys.length || `${keys.join(", ")} go together`
  })

const ActorsParams = Schema.Struct({
  limit: Limit,
  type: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.NonEmptyString),
  afterType: Schema.optional(Schema.String),
  afterId: Schema.optional(Schema.String),
}).check(whole("afterType", "afterId"))

const ActorParams = Schema.Struct({ limit: Limit, type: Schema.String, id: Schema.String })

const ActorTypesParams = Schema.Struct({
  limit: Limit,
  type: Schema.optional(Schema.String),
  prefix: Schema.optional(Schema.NonEmptyString),
  after: Schema.optional(Schema.String),
})

const JobTypesParams = Schema.Struct({ limit: Limit, after: Schema.optional(Schema.String) })

const LatestEventsParams = Schema.Struct({
  ...ActorParams.fields,
  after: Schema.optional(Schema.String),
})

const TimelineParams = Schema.Struct({
  ...ActorParams.fields,
  beforeSequence: Schema.optional(Millis),
  beforeKind: Schema.optional(Schema.Literals(["command", "event"])),
}).check(whole("beforeSequence", "beforeKind"))

const ReceiptsParams = Schema.Struct({
  limit: Limit,
  type: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["Success", "Failure"])),
  afterExpiresAtMs: Schema.optional(Millis),
  afterType: Schema.optional(Schema.String),
  afterId: Schema.optional(Schema.String),
  afterCommandId: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter(({ type, id }) => id === undefined || type !== undefined || "id needs type"),
  whole("afterExpiresAtMs", "afterType", "afterId", "afterCommandId"),
)

const DeadLettersParams = Schema.Struct({
  limit: Limit,
  afterDeadAtMs: Schema.optional(Millis),
  afterJobId: Schema.optional(Schema.String),
}).check(whole("afterDeadAtMs", "afterJobId"))

const WorkflowsParams = Schema.Struct({
  limit: Limit,
  status: Schema.optional(
    Schema.Literals(["open", "all", "running", "suspended", "finished", "completed", "failed"]),
  ),
  afterStartedAtMs: Schema.optional(Millis),
  afterExecutionId: Schema.optional(Schema.String),
}).check(whole("afterStartedAtMs", "afterExecutionId"))

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
 * - `GET /overview`: the view catalog, the tenant's row counts and its soonest timer.
 * - `GET /actors?type&prefix&afterType&afterId&limit`: actors, one keyset page
 *   at a time, optionally those whose `type/id` address starts with `prefix`.
 * - `GET /actor?type&id&limit`: one actor's state, receipts with the events
 *   each committed, events, outbox, jobs, dead letters, and workflows with steps.
 * - `GET /actor-types?type&prefix&after&limit`: actor types with their actor
 *   counts, optionally one type or those whose name starts with `prefix`.
 * - `GET /receipts?type&id&outcome&afterExpiresAtMs&afterType&afterId&afterCommandId&limit`:
 *   receipts of one actor, one type or the tenant, the latest expiry first.
 * - `GET /latest-events?type&id&after&limit`: one actor's newest event of each name.
 * - `GET /timeline?type&id&beforeSequence&beforeKind&limit`: one actor's events
 *   and the commands that emitted them, newest first.
 * - `GET /job-types?after&limit`: pending jobs and dead letters by job name.
 * - `GET /outbox`, `/jobs`, `/dead-letters?afterDeadAtMs&afterJobId`,
 *   `/workflows?status=open|all|running|suspended|finished|completed|failed&afterStartedAtMs&afterExecutionId`:
 *   tenant-wide lists; the paged ones answer the `next` cursor to pass back.
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

      yield* route("/actors", ActorsParams, (tenant, { limit, type, prefix, afterType, afterId }) =>
        Effect.asSome(
          Queries.actors({
            tenant,
            limit,
            actorType: type,
            prefix,
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

      yield* route("/jobs", PageParams, (tenant, { limit }) =>
        Effect.asSome(Queries.jobs({ tenant, limit })),
      )

      yield* route(
        "/dead-letters",
        DeadLettersParams,
        (tenant, { limit, afterDeadAtMs, afterJobId }) =>
          Effect.asSome(
            Queries.deadLetters({
              tenant,
              limit,
              after:
                afterDeadAtMs === undefined || afterJobId === undefined
                  ? undefined
                  : { deadAtMs: afterDeadAtMs, jobId: afterJobId },
            }),
          ),
      )

      yield* route(
        "/workflows",
        WorkflowsParams,
        (tenant, { limit, status, afterStartedAtMs, afterExecutionId }) =>
          Effect.asSome(
            Queries.workflows({
              tenant,
              limit,
              status: status ?? "open",
              after:
                afterStartedAtMs === undefined || afterExecutionId === undefined
                  ? undefined
                  : { startedAtMs: afterStartedAtMs, executionId: afterExecutionId },
            }),
          ),
      )

      yield* route("/actor-types", ActorTypesParams, (tenant, { limit, type, prefix, after }) =>
        Effect.asSome(Queries.actorTypes({ tenant, limit, name: type, prefix, after })),
      )

      yield* route("/job-types", JobTypesParams, (tenant, { limit, after }) =>
        Effect.asSome(Queries.jobTypes({ tenant, limit, after })),
      )

      yield* route(
        "/receipts",
        ReceiptsParams,
        (
          tenant,
          { limit, type, id, outcome, afterExpiresAtMs, afterType, afterId, afterCommandId },
        ) =>
          Queries.receipts({
            tenant,
            limit,
            actorType: type,
            actorId: id,
            outcomeTag: outcome,
            after:
              afterExpiresAtMs === undefined ||
              afterType === undefined ||
              afterId === undefined ||
              afterCommandId === undefined
                ? undefined
                : {
                    expiresAtMs: afterExpiresAtMs,
                    actorType: afterType,
                    actorId: afterId,
                    commandId: afterCommandId,
                  },
          }),
      )

      yield* route("/latest-events", LatestEventsParams, (tenant, { limit, type, id, after }) =>
        Queries.latestEvents({ tenant, limit, actorType: type, actorId: id, after }),
      )

      yield* route(
        "/timeline",
        TimelineParams,
        (tenant, { limit, type, id, beforeSequence, beforeKind }) =>
          Queries.timeline({
            tenant,
            limit,
            actorType: type,
            actorId: id,
            before:
              beforeSequence === undefined || beforeKind === undefined
                ? undefined
                : { sequence: beforeSequence, kind: beforeKind },
          }),
      )
    }),
  )

/** The read-only inspector: `serve` mounts its routes. */
export const Inspector = { serve }
