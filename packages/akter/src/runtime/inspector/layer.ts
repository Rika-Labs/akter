import { Clock, DateTime, Effect, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse, type HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { ActorError, RunnerAtCapacity, Unauthorized } from "../../errors/actor.ts"
import { Anonymous, User } from "../../identity/caller.ts"
import type * as Inspection from "../../protocol/inspection.ts"
import { InternalActors } from "../actors.ts"
import { StreamMessage } from "../telemetry/live.ts"
import { message } from "../../serve/sessions/sse.ts"
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
  /** The name live reads give this runner, such as its host or task; null in them when unset. */
  readonly runner?: string | undefined
  /** The region live reads say this runner serves; null in them when unset. */
  readonly region?: string | undefined
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

const Window = Schema.optional(Schema.Literals(["1h", "24h", "7d"]))

const LiveTypeParams = Schema.Struct({ type: Schema.optional(Schema.String), window: Window })

/** The most actors one live actors read names. */
const MAX_LIVE_ACTORS = 100

const LiveActorsParams = Schema.Struct({
  type: Schema.String,
  ids: Schema.fromJsonString(
    Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_LIVE_ACTORS)),
  ),
})

const StreamParams = Schema.Struct({
  type: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["Success", "Failure"])),
  after: Schema.optional(Schema.String),
})

const isPrincipal = Schema.is(Schema.Union([User, Anonymous]))

/**
 * How often a command stream with no commands sends a comment. A proxy in
 * front of the inspector, such as the edge or the control plane's client,
 * closes a connection idle for 10 seconds, so this stays well under it.
 */
const STREAM_KEEPALIVE_MS = 4_000

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
 *
 * Inside a runtime it also serves the schedules and this runner's own memory,
 * each live answer naming the runner, its region, when it began recording and
 * how many other runners the cluster lists:
 *
 * - `GET /schedules`: each declared cron entry with its pending ticks and last committed tick.
 * - `GET /live/overview`: recent rates, resident activations and the deepest mailbox, by type.
 * - `GET /live/activity?type&window`, `/live/latency?type&window`: one type's, or every type's,
 *   committed turns over `1h`, `24h` (default) or `7d`.
 * - `GET /live/actors?type&ids`: whether each named actor is resident, its
 *   mailbox, sockets and feeds; `ids` is a JSON array of at most 100.
 * - `GET /live/connections`: open sockets and SSE responses, by type.
 * - `GET /commands/stream?type&outcome&after`: SSE of each command this runner
 *   commits for the tenant, `id` its position, resuming after `after` while the
 *   runner still holds it and sending `gap` when it does not, until the
 *   credential expires.
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

          return { tenant: authenticated.tenant, expiresAt: authenticated.expiresAt }
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

              const { tenant } = yield* authenticate(request)

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

      /**
       * The live reads, the schedules and the command stream, which need the
       * runtime itself; mounted only where the inspector runs inside one.
       */
      const mountLive = Effect.fnUntraced(function* (actors: InternalActors["Service"]) {
        const recorder = yield* actors.live.enable

        const scope = Effect.gen(function* () {
          const peers = yield* actors.live.peers

          return {
            runner: options.runner ?? null,
            region: options.region ?? null,
            startedAtMs: recorder.startedAtMs,
            peers: peers ?? null,
          } satisfies Inspection.LiveScope
        })

        /** A read of this runner's memory alone, answered as JSON with the scope it covers. */
        const live = <A, I extends Readonly<Record<string, string | undefined>>>(
          path: string,
          params: Schema.Codec<A, I>,
          read: (
            tenant: string,
            params: A,
            nowMs: number,
            scope: Inspection.LiveScope,
          ) => Effect.Effect<unknown>,
        ) =>
          router.add(
            "GET",
            `${basePath}${path}` as HttpRouter.PathInput,
            (request: HttpServerRequest.HttpServerRequest) =>
              Effect.gen(function* () {
                yield* refuseCrossOrigin(request)

                const { tenant } = yield* authenticate(request)

                const decoded = yield* HttpRouter.schemaParams(params).pipe(
                  Effect.mapError(undecodable),
                )

                return HttpServerResponse.jsonUnsafe(
                  yield* read(tenant, decoded, yield* Clock.currentTimeMillis, yield* scope),
                )
              }).pipe(operatorResponse("Inspector request failed")),
          )

        yield* live("/live/overview", Schema.Struct({}), (tenant, _params, nowMs, covered) =>
          Effect.sync(() => {
            const resident = actors.live.resident(tenant)
            const types = new Set([
              ...recorder.actorTypes(tenant),
              ...resident.map((r) => r.actorType),
            ])
            const deepest = (activations: typeof resident) =>
              activations.reduce<(typeof resident)[number] | undefined>(
                (found, activation) =>
                  activation.mailbox > 0 &&
                  (found === undefined || activation.mailbox > found.mailbox)
                    ? activation
                    : found,
                undefined,
              )
            const rates = (actorType: string | undefined) => {
              const found = recorder.rates(tenant, actorType, nowMs)

              return {
                perSecond: found?.perSecond ?? null,
                p50Ms: found?.p50Ms ?? null,
                p99Ms: found?.p99Ms ?? null,
              }
            }
            const max = deepest(resident)

            return {
              scope: covered,
              total: {
                ...rates(undefined),
                awake: resident.length,
                maxMailbox:
                  max === undefined
                    ? null
                    : { depth: max.mailbox, actorType: max.actorType, actorId: max.actorId },
              },
              actorTypes: [...types].sort().map((actorType) => {
                const ofType = resident.filter((activation) => activation.actorType === actorType)
                const typeMax = deepest(ofType)

                return {
                  actorType,
                  ...rates(actorType),
                  awake: ofType.length,
                  maxMailbox:
                    typeMax === undefined
                      ? null
                      : { depth: typeMax.mailbox, actorId: typeMax.actorId },
                }
              }),
            } satisfies Inspection.LiveOverview
          }),
        )

        yield* live("/live/activity", LiveTypeParams, (tenant, { type, window }, nowMs, covered) =>
          Effect.sync(() => {
            const found = recorder.activity(tenant, type, window ?? "24h", nowMs)

            return {
              scope: covered,
              activity:
                found === undefined
                  ? null
                  : { sinceMs: found.since, points: found.points, commands: found.commands },
            } satisfies Inspection.LiveActivity
          }),
        )

        yield* live("/live/latency", LiveTypeParams, (tenant, { type, window }, nowMs, covered) =>
          Effect.sync(() => {
            const found = recorder.latency(tenant, type, window ?? "24h", nowMs)

            return {
              scope: covered,
              latency:
                found === undefined
                  ? null
                  : {
                      sinceMs: found.since,
                      count: found.count,
                      buckets: found.buckets,
                      p50Ms: found.p50Ms,
                      p95Ms: found.p95Ms,
                      p99Ms: found.p99Ms,
                    },
            } satisfies Inspection.LiveLatency
          }),
        )

        yield* live("/live/actors", LiveActorsParams, (tenant, { type, ids }, _nowMs, covered) =>
          Effect.sync(() => {
            const resident = actors.live
              .resident(tenant)
              .filter((activation) => activation.actorType === type)
            const open = actors.live
              .connections(tenant)
              .filter((connection) => connection.actorType === type)

            return {
              scope: covered,
              actors: ids.map((actorId) => {
                const activation = resident.find((found) => found.actorId === actorId)
                const mine = open.filter((connection) => connection.actorId === actorId)
                const feeds = new Map<string, number>()

                for (const connection of mine)
                  if (connection.kind === "feed")
                    for (const event of connection.events)
                      feeds.set(event, (feeds.get(event) ?? 0) + 1)

                return {
                  actorId,
                  awake: activation !== undefined,
                  mailbox: activation?.mailbox ?? null,
                  sockets: mine.filter((connection) => connection.kind === "socket").length,
                  feeds: [...feeds]
                    .sort(([left], [right]) => (left < right ? -1 : 1))
                    .map(([event, subscribers]) => ({ event, subscribers })),
                }
              }),
            } satisfies Inspection.LiveActors
          }),
        )

        yield* live("/live/connections", Schema.Struct({}), (tenant, _params, _nowMs, covered) =>
          Effect.sync(() => {
            const open = actors.live.connections(tenant)
            const counts = (connections: typeof open) => ({
              sockets: connections.filter((connection) => connection.kind === "socket").length,
              feeds: connections.filter((connection) => connection.kind === "feed").length,
              streams: connections.filter((connection) => connection.kind === "stream").length,
              watches: connections.filter((connection) => connection.kind === "watch").length,
            })

            return {
              scope: covered,
              ...counts(open),
              byActorType: [...new Set(open.map((connection) => connection.actorType))]
                .sort()
                .map((actorType) => ({
                  actorType,
                  ...counts(open.filter((connection) => connection.actorType === actorType)),
                })),
            } satisfies Inspection.LiveConnections
          }),
        )

        yield* route("/schedules", Schema.Struct({}), (tenant) =>
          Effect.asSome(Queries.schedules({ tenant, declared: actors.live.schedules() })),
        )

        yield* router.add(
          "GET",
          `${basePath}/commands/stream` as HttpRouter.PathInput,
          (request: HttpServerRequest.HttpServerRequest) =>
            Effect.gen(function* () {
              yield* refuseCrossOrigin(request)

              const { tenant, expiresAt } = yield* authenticate(request)

              const { type, outcome, after } = yield* HttpRouter.schemaParams(StreamParams).pipe(
                Effect.mapError(undecodable),
              )

              const nowMs = yield* Clock.currentTimeMillis

              if (recorder.full(tenant))
                return yield* ActorError.make({ reason: RunnerAtCapacity.make({}) })

              const opened = recorder.subscribe(
                tenant,
                {
                  actorType: type,
                  failed: outcome === undefined ? undefined : outcome === "Failure",
                },
                after,
              )

              const until =
                expiresAt === undefined
                  ? Effect.never
                  : Effect.sleep(Math.max(0, DateTime.toEpochMillis(expiresAt) - nowMs))

              const messages = opened.pipe(
                Stream.mapEffect(
                  StreamMessage.$match({
                    gap: () => message({ event: "gap", data: null }),
                    command: ({ entry }) =>
                      message({
                        event: "command",
                        id: entry.id,
                        data: {
                          id: entry.id,
                          commandId: entry.commandId,
                          atMs: entry.atMs,
                          durationMs: entry.durationMs,
                          actorType: entry.actorType,
                          actorId: entry.actorId,
                          command: entry.command,
                          callerKey: Queries.decodeText(entry.callerKey),
                          outcomeTag: entry.failed ? "Failure" : "Success",
                          errorTag: entry.errorTag,
                          payloadPreview: entry.payloadPreview,
                        } satisfies Inspection.StreamCommand,
                      }),
                  }),
                ),
                Stream.interruptWhen(until),
                Stream.concat(Stream.fromEffect(message({ event: "end", data: null }))),
              )

              return HttpServerResponse.stream(
                Stream.concat(Stream.succeed(": open\n\n"), messages).pipe(
                  Stream.merge(
                    Stream.tick(STREAM_KEEPALIVE_MS).pipe(
                      Stream.drop(1),
                      Stream.map(() => ": keepalive\n\n"),
                    ),
                    { haltStrategy: "left" },
                  ),
                  Stream.encodeText,
                ),
                {
                  contentType: "text/event-stream",
                  headers: { "x-accel-buffering": "no" },
                },
              )
            }).pipe(operatorResponse("Inspector request failed")),
        )
      })

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

      const runtime = yield* Effect.serviceOption(InternalActors)

      if (Option.isSome(runtime)) yield* mountLive(runtime.value)
    }),
  )

/** The read-only inspector: `serve` mounts its routes. */
export const Inspector = { serve }
