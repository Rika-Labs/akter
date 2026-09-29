import { type Cause, Effect, Match, Option, Schema } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { isSameOrigin } from "../../serve/layer.ts"
import { actorErrorResponse, Defect, invalidInput, undecodable } from "../../serve/wire.ts"
import { DefectLog } from "../telemetry/defects.ts"
import type { AuditEntry } from "./audit.ts"
import type { OperatorAuth } from "./auth.ts"
import { authorizing, type OperatorAction, type OperatorGrant, type Resource } from "./grants.ts"
import { OperatorRuntime, type RepairError } from "./repair.ts"

/** Options for serving the operator routes. */
export interface OperatorsOptions<R> {
  /** Authenticates every operator request to a grant; an `Actor.auth` provider is not accepted. */
  readonly auth: OperatorAuth<R>
  /** Prefix for every route. Default `"/operator"`. */
  readonly basePath?: `/${string}`
}

/** The most rows one list returns. */
export const MAX_ROWS = 1000

const Tenant = Schema.NonEmptyString

const Limit = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_ROWS }),
)

const ActorParams = Schema.Struct({ type: Schema.NonEmptyString, id: Schema.NonEmptyString })

const ReceiptParams = Schema.Struct({
  type: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  commandId: Schema.NonEmptyString,
})

const EffectParams = Schema.Struct({ effectId: Schema.NonEmptyString })

const InspectQuery = Schema.Struct({ tenant: Tenant, limit: Schema.optional(Limit) })

const TenantQuery = Schema.Struct({ tenant: Tenant })

const DefectsQuery = Schema.Struct({
  tenant: Tenant,
  actor: Schema.optional(Schema.NonEmptyString),
  sinceMs: Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
  limit: Schema.optional(Limit),
})

const AuditQuery = Schema.Struct({ tenant: Tenant, limit: Schema.optional(Limit) })

const Reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))

const DiscardBody = Schema.Struct({
  tenant: Tenant,
  actorType: Schema.NonEmptyString,
  actorId: Schema.NonEmptyString,
  reason: Reason,
})

const SkipBody = Schema.Struct({
  tenant: Tenant,
  sourceType: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  subscriberType: Schema.NonEmptyString,
  subscription: Schema.NonEmptyString,
  subscriberId: Schema.NonEmptyString,
  through: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,17}$/)),
  reason: Reason,
})

const RetryBody = Schema.Struct({
  ...DiscardBody.fields,
  providerChecked: Schema.optional(Schema.Boolean),
})

/** The body of a 404: nothing of that name exists in the tenant. */
const NotFound = Schema.TaggedStruct("NotFound", {})

const noStore = (response: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(response, { "cache-control": "no-store" })

const repairResponse = (error: RepairError) =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      OperatorNotFound: () => HttpServerResponse.jsonUnsafe(NotFound.make({}), { status: 404 }),
      ProviderOutcomeUnknown: (refused) => HttpServerResponse.jsonUnsafe(refused, { status: 409 }),
      EffectNotServed: (refused) => HttpServerResponse.jsonUnsafe(refused, { status: 503 }),
    }),
  )

const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "0".repeat(32)),
)

const defectResponse = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
  yield* Effect.logError("Operator request failed", cause)

  return HttpServerResponse.jsonUnsafe(Defect.make({ traceId: yield* traceId }), { status: 500 })
})

/**
 * Serves the operator routes on the application's `HttpRouter`. Every
 * request is authenticated to an operator grant, checked against the one
 * capability its action and resource need, and recorded in the operator
 * audit log: a repair in its own transaction, a read before it is answered,
 * and a refusal by scope as `"denied"`. A browser page on another origin is
 * refused before its credentials are read.
 *
 * - `GET /actors/:type/:id?tenant&limit`: `inspect`; receipt outcomes only under `receipts.read`.
 * - `GET /receipts/:type/:id/:commandId?tenant`: `receipts.read`; never runs the command.
 * - `GET /defects?tenant&actor&sinceMs&limit`: `defects.read`; `tenant` may be `*`.
 * - `POST /dead-letters/:effectId/retry` `{ tenant, actorType, actorId, reason, providerChecked? }`: `dead-letters.retry`.
 * - `POST /dead-letters/:effectId/discard` `{ tenant, actorType, actorId, reason }`: `dead-letters.discard`.
 * - `POST /subscriptions/skip` `{ tenant, sourceType, sourceId, subscriberType, subscription, subscriberId, through, reason }`: `subscriptions.skip`, scoped to the source actor.
 * - `GET /audit?tenant&limit`: `audit.read`; `tenant` may be `*`.
 */
const serve = <R = never>(options: OperatorsOptions<R>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const basePath = (options.basePath ?? "/operator").replace(/\/+$/, "")
      const context = yield* Effect.context<R>()
      const runtime = yield* OperatorRuntime
      const defects = yield* DefectLog

      const authenticate = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const origin = Headers.get(request.headers, "origin")

          if (Option.isSome(origin) && !isSameOrigin({ request, origin: origin.value }))
            return yield* invalidInput("origin_not_allowed")

          return yield* options.auth
            .authenticate({
              headers: request.headers,
              cookies: {},
            })
            .pipe(
              Effect.provideContext(context),
              Effect.mapError((reason) => ActorError.make({ reason })),
              Effect.tapError(() => Effect.logWarning("Operator request not authenticated")),
            )
        })

      const authorize = (
        grant: OperatorGrant,
        action: OperatorAction,
        resource: Resource,
        target?: string,
      ) =>
        Effect.gen(function* () {
          const entry: AuditEntry = {
            operator: grant.operator,
            action,
            tenant: resource.tenant,
            actorType: resource.actorType,
            actorId: resource.actorId,
            target,
            capability: authorizing({ grant, action, resource }),
          }

          if (Option.isNone(entry.capability)) {
            yield* runtime.record(entry, "denied")

            return yield* ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })
          }

          return entry
        })

      const route = (
        method: "GET" | "POST",
        path: string,
        handle: (
          request: HttpServerRequest.HttpServerRequest,
          grant: OperatorGrant,
        ) => Effect.Effect<
          HttpServerResponse.HttpServerResponse,
          ActorError | Schema.SchemaError,
          | HttpServerRequest.HttpServerRequest
          | HttpServerRequest.ParsedSearchParams
          | HttpRouter.RouteContext
        >,
      ) =>
        router.add(
          method,
          `${basePath}${path}` as HttpRouter.PathInput,
          (request: HttpServerRequest.HttpServerRequest) =>
            authenticate(request).pipe(
              Effect.flatMap((grant) => handle(request, grant)),
              Effect.catchTag("SchemaError", (error) => Effect.fail(undecodable(error))),
              Effect.catch(actorErrorResponse),
              Effect.catchCause(defectResponse),
              Effect.map(noStore),
            ),
        )

      const query = <A, I extends Readonly<Record<string, string | undefined>>>(
        schema: Schema.Codec<A, I>,
      ) => HttpRouter.schemaParams(schema)

      yield* route("GET", "/actors/:type/:id", (_request, grant) =>
        Effect.gen(function* () {
          const { type, id } = yield* HttpRouter.schemaPathParams(ActorParams)
          const { tenant, limit } = yield* query(InspectQuery)
          const resource = { tenant, actorType: type, actorId: id }
          const entry = yield* authorize(grant, "inspect", resource)

          const outcomes = Option.isSome(authorizing({ grant, action: "receipts.read", resource }))

          yield* runtime.record(entry, { outcomes })

          const page = yield* runtime.inspect({
            ...target(resource),
            limit: limit ?? 20,
            outcomes,
          })

          return Option.match(page, {
            onNone: () => HttpServerResponse.jsonUnsafe(NotFound.make({}), { status: 404 }),
            onSome: (value) => HttpServerResponse.jsonUnsafe(value),
          })
        }),
      )

      yield* route("GET", "/receipts/:type/:id/:commandId", (_request, grant) =>
        Effect.gen(function* () {
          const { type, id, commandId } = yield* HttpRouter.schemaPathParams(ReceiptParams)
          const { tenant } = yield* query(TenantQuery)
          const resource = { tenant, actorType: type, actorId: id, commandId }
          const entry = yield* authorize(grant, "receipts.read", resource, commandId)

          yield* runtime.record(entry, "read")

          const receipt = yield* runtime.receipt({ ...target(resource), commandId })

          return Option.match(receipt, {
            onNone: () => HttpServerResponse.jsonUnsafe(NotFound.make({}), { status: 404 }),
            onSome: (value) => HttpServerResponse.jsonUnsafe(value),
          })
        }),
      )

      yield* route("GET", "/defects", (_request, grant) =>
        Effect.gen(function* () {
          const { tenant, actor, sinceMs, limit } = yield* query(DefectsQuery)
          const entry = yield* authorize(grant, "defects.read", { tenant, actorType: actor })

          yield* runtime.record(entry, "read")

          const listed = yield* defects.list({ actorType: actor, sinceMs })
          const own = tenant === "*" ? listed : listed.filter((defect) => defect.tenant === tenant)

          return HttpServerResponse.jsonUnsafe(own.slice(-(limit ?? MAX_ROWS)))
        }),
      )

      const repair = (
        path: "retry" | "discard",
        run: (
          body: typeof RetryBody.Type,
          effectId: string,
          audit: AuditEntry,
        ) => Effect.Effect<Schema.Json, RepairError>,
      ) =>
        route("POST", `/dead-letters/:effectId/${path}`, (_request, grant) =>
          Effect.gen(function* () {
            const { effectId } = yield* HttpRouter.schemaPathParams(EffectParams)

            const body = yield* HttpServerRequest.schemaBodyJson(RetryBody).pipe(
              Effect.catchTag("HttpServerError", () => Effect.fail(invalidInput("decode"))),
            )

            const resource = {
              tenant: body.tenant,
              actorType: body.actorType,
              actorId: body.actorId,
            }

            const entry = yield* authorize(
              grant,
              path === "retry" ? "dead-letters.retry" : "dead-letters.discard",
              resource,
              effectId,
            )

            return yield* run(body, effectId, { ...entry, reason: body.reason }).pipe(
              Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
              Effect.catch((error) => Effect.succeed(repairResponse(error))),
            )
          }),
        )

      yield* repair("retry", (body, effectId, audit) =>
        runtime.retry({
          target: target(body),
          effectId,
          providerChecked: body.providerChecked === true,
          audit,
        }),
      )

      yield* repair("discard", (body, effectId, audit) =>
        runtime
          .discard({ target: target(body), effectId, audit })
          .pipe(Effect.as({ discarded: effectId })),
      )

      yield* route("POST", "/subscriptions/skip", (_request, grant) =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(SkipBody).pipe(
            Effect.catchTag("HttpServerError", () => Effect.fail(invalidInput("decode"))),
          )

          const entry = yield* authorize(
            grant,
            "subscriptions.skip",
            { tenant: body.tenant, actorType: body.sourceType, actorId: body.sourceId },
            `${body.subscriberType}.${body.subscription}/${body.subscriberId}`,
          )

          return yield* runtime
            .skip({
              target: {
                tenant: body.tenant,
                actorType: body.sourceType,
                actorId: body.sourceId,
              },
              subscriberType: body.subscriberType,
              subscription: body.subscription,
              subscriberId: body.subscriberId,
              through: body.through,
              audit: { ...entry, reason: body.reason },
            })
            .pipe(
              Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
              Effect.catch((error) => Effect.succeed(repairResponse(error))),
            )
        }),
      )

      yield* route("GET", "/audit", (_request, grant) =>
        Effect.gen(function* () {
          const { tenant, limit } = yield* query(AuditQuery)
          const entry = yield* authorize(grant, "audit.read", { tenant })

          yield* runtime.record(entry, "read")

          return HttpServerResponse.jsonUnsafe(
            yield* runtime.audit({ tenant, limit: limit ?? 100 }),
          )
        }),
      )
    }),
  )

const target = (resource: {
  readonly tenant: string
  readonly actorType: string
  readonly actorId: string
}) => ({ tenant: resource.tenant, actorType: resource.actorType, actorId: resource.actorId })

/** Operator route constructors; `serve` mounts the routes. */
export const Operators = { serve }
