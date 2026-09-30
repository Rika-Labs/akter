import { Effect, Match, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ActorError, Unauthorized } from "../../errors/actor.ts"
import { invalidInput, undecodable } from "../../serve/wire.ts"
import {
  foundOrNotFound,
  notFoundResponse,
  operatorResponse,
  refuseCrossOrigin,
} from "../inspector/http.ts"
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
const MAX_ROWS = 1000

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

const PageQuery = Schema.Struct({ tenant: Tenant, limit: Schema.optional(Limit) })

const TenantQuery = Schema.Struct({ tenant: Tenant })

const DefectsQuery = Schema.Struct({
  tenant: Tenant,
  actor: Schema.optional(Schema.NonEmptyString),
  sinceMs: Schema.optional(Schema.FiniteFromString.check(Schema.isInt())),
  limit: Schema.optional(Limit),
})

/** Rows that failed this many deliveries in a row count as lagging. */
const LAGGING_ATTEMPTS = 8

const LaggingQuery = Schema.Struct({
  tenant: Tenant,
  minAttempts: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  limit: Schema.optional(Limit),
})

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

/** Answers a repair's result as JSON and each refusal with its own status. */
const repairResponse = <A>(repair: Effect.Effect<A, RepairError>) =>
  repair.pipe(
    Effect.map((result) => HttpServerResponse.jsonUnsafe(result)),
    Effect.catch((error) =>
      Effect.succeed(
        Match.value(error).pipe(
          Match.tagsExhaustive({
            OperatorNotFound: notFoundResponse,
            ProviderOutcomeUnknown: (refused) =>
              HttpServerResponse.jsonUnsafe(refused, { status: 409 }),
            EffectNotServed: (refused) => HttpServerResponse.jsonUnsafe(refused, { status: 503 }),
          }),
        ),
      ),
    ),
  )

/** Decodes a JSON request body; a body that is not JSON is refused as `decode`. */
const decodeBody = <A, RD>(schema: Schema.ConstraintDecoder<A, RD>) =>
  HttpServerRequest.schemaBodyJson(schema).pipe(
    Effect.catchTag("HttpServerError", () => Effect.fail(invalidInput("decode"))),
  )

/**
 * Serves the operator routes on the application's `HttpRouter`. Every
 * request is authenticated to an operator grant, checked against the one
 * capability its action and resource need, and recorded in the operator
 * audit log: a repair in its own transaction, a read before it is answered,
 * and a refusal by scope as `"denied"`. A browser page on another origin is
 * refused before its credentials are read.
 *
 * - `GET /actors/:type/:id?tenant&limit`: `inspect`; receipt outcomes only under `receipts.read`.
 * - `GET /actors/:type/:id/export?tenant`: `export`; the actor's seed, read-only. Answers 409 `ExportRefused` when a stored value does not decode or the actor holds too much pending work.
 * - `GET /receipts/:type/:id/:commandId?tenant`: `receipts.read`; never runs the command.
 * - `GET /defects?tenant&actor&sinceMs&limit`: `defects.read`; `tenant` may be `*`.
 * - `POST /dead-letters/:effectId/retry` `{ tenant, actorType, actorId, reason, providerChecked? }`: `dead-letters.retry`.
 * - `POST /dead-letters/:effectId/discard` `{ tenant, actorType, actorId, reason }`: `dead-letters.discard`.
 * - `POST /subscriptions/skip` `{ tenant, sourceType, sourceId, subscriberType, subscription, subscriberId, through, reason }`: `subscriptions.skip`, scoped to the source actor.
 * - `GET /subscriptions/lagging?tenant&minAttempts&limit`: `inspect`, tenant-wide; failing subscription rows with their lag and last error.
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
          yield* refuseCrossOrigin(request)

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

      /** Authorizes a read and records it in the audit log before it is answered. */
      const authorizeRead = (
        grant: OperatorGrant,
        action: OperatorAction,
        resource: Resource,
        target?: string,
      ) =>
        authorize(grant, action, resource, target).pipe(
          Effect.flatMap((entry) => runtime.record(entry, "read")),
        )

      const route = (
        method: "GET" | "POST",
        path: string,
        handle: (
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
              Effect.flatMap(handle),
              Effect.catchTag("SchemaError", (error) => Effect.fail(undecodable(error))),
              operatorResponse("Operator request failed"),
            ),
        )

      yield* route("GET", "/actors/:type/:id", (grant) =>
        Effect.gen(function* () {
          const { type, id } = yield* HttpRouter.schemaPathParams(ActorParams)
          const { tenant, limit } = yield* HttpRouter.schemaParams(PageQuery)
          const resource = { tenant, actorType: type, actorId: id }
          const entry = yield* authorize(grant, "inspect", resource)

          const outcomes = Option.isSome(authorizing({ grant, action: "receipts.read", resource }))

          yield* runtime.record(entry, { outcomes })

          return foundOrNotFound(
            yield* runtime.inspect({ ...resource, limit: limit ?? 20, outcomes }),
          )
        }),
      )

      yield* route("GET", "/actors/:type/:id/export", (grant) =>
        Effect.gen(function* () {
          const { type, id } = yield* HttpRouter.schemaPathParams(ActorParams)
          const { tenant } = yield* HttpRouter.schemaParams(TenantQuery)
          const resource = { tenant, actorType: type, actorId: id }

          yield* authorizeRead(grant, "export", resource)

          return yield* runtime.exportSeed(resource).pipe(
            Effect.map(foundOrNotFound),
            Effect.catchTag("ExportRefused", (refused) =>
              Effect.succeed(HttpServerResponse.jsonUnsafe(refused, { status: 409 })),
            ),
          )
        }),
      )

      yield* route("GET", "/receipts/:type/:id/:commandId", (grant) =>
        Effect.gen(function* () {
          const { type, id, commandId } = yield* HttpRouter.schemaPathParams(ReceiptParams)
          const { tenant } = yield* HttpRouter.schemaParams(TenantQuery)
          const resource = { tenant, actorType: type, actorId: id, commandId }

          yield* authorizeRead(grant, "receipts.read", resource, commandId)

          return foundOrNotFound(yield* runtime.receipt(resource))
        }),
      )

      yield* route("GET", "/defects", (grant) =>
        Effect.gen(function* () {
          const { tenant, actor, sinceMs, limit } = yield* HttpRouter.schemaParams(DefectsQuery)

          yield* authorizeRead(grant, "defects.read", { tenant, actorType: actor })

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
        route("POST", `/dead-letters/:effectId/${path}`, (grant) =>
          Effect.gen(function* () {
            const { effectId } = yield* HttpRouter.schemaPathParams(EffectParams)
            const body = yield* decodeBody(RetryBody)

            const entry = yield* authorize(
              grant,
              path === "retry" ? "dead-letters.retry" : "dead-letters.discard",
              target(body),
              effectId,
            )

            return yield* repairResponse(run(body, effectId, { ...entry, reason: body.reason }))
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

      yield* route("POST", "/subscriptions/skip", (grant) =>
        Effect.gen(function* () {
          const body = yield* decodeBody(SkipBody)
          const source = { tenant: body.tenant, actorType: body.sourceType, actorId: body.sourceId }

          const entry = yield* authorize(
            grant,
            "subscriptions.skip",
            source,
            `${body.subscriberType}.${body.subscription}/${body.subscriberId}`,
          )

          return yield* repairResponse(
            runtime.skip({
              target: source,
              subscriberType: body.subscriberType,
              subscription: body.subscription,
              subscriberId: body.subscriberId,
              through: body.through,
              audit: { ...entry, reason: body.reason },
            }),
          )
        }),
      )

      yield* route("GET", "/subscriptions/lagging", (grant) =>
        Effect.gen(function* () {
          const { tenant, minAttempts, limit } = yield* HttpRouter.schemaParams(LaggingQuery)

          yield* authorizeRead(grant, "inspect", { tenant })

          return HttpServerResponse.jsonUnsafe(
            yield* runtime.lagging({
              tenant,
              minAttempts: minAttempts ?? LAGGING_ATTEMPTS,
              limit: limit ?? 100,
            }),
          )
        }),
      )

      yield* route("GET", "/audit", (grant) =>
        Effect.gen(function* () {
          const { tenant, limit } = yield* HttpRouter.schemaParams(PageQuery)

          yield* authorizeRead(grant, "audit.read", { tenant })

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
