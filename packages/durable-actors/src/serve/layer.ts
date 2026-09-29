import {
  Cause,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Match,
  Option,
  Schema,
  SchemaAST,
  Stream,
} from "effect"
import {
  Headers,
  HttpRouter,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import {
  type ServedConnection,
  type ServedDefinition,
  type ServedMember,
  servedDefinitions,
} from "../actor/served.ts"
import { ActorError, NotCreated, RunnerAtCapacity, Unauthorized } from "../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../errors/events.ts"
import { InternalActors, Outcome, Request } from "../handles/actors.ts"
import { ActorRef, Anonymous, User } from "../identity/caller.ts"
import { build, document, memberPath, PROTOCOL_OPERATIONS, schemeName } from "./api.ts"
import {
  type AuthProvider,
  type Authenticated,
  Credential,
  readsCookies,
  withinLimits,
} from "./auth.ts"
import {
  ASSERTION_HEADER,
  KEY_REFRESH_PATH,
  reauthenticationDigest,
  requestDigest,
} from "./assertion/binding.ts"
import { databaseClock } from "./clock.ts"
import { SUBPROTOCOL } from "./frames.ts"
import { feedStream, MAX_FEED_FILTERS, openFeed } from "./feed.ts"
import { MAX_AWAITING_HELLO, socketSession } from "./socket.ts"
import { actorErrorResponse, Defect, invalidInput, PROTOCOL, undecodable } from "./wire.ts"

export interface ServeOptions<R> {
  /** Actor definitions to serve; their layers are provided as usual. */
  readonly actors: ReadonlyArray<{ readonly name: string }>
  /** Authenticates every request this layer answers. Required: `Actor.auth.none` is the explicit public opt-out. */
  readonly auth: AuthProvider<R>
  /** Prefix for every route, such as `"/api"`. */
  readonly basePath?: `/${string}`
  /** Serves the OpenAPI 3.1 document at `path`; off unless given. */
  readonly openapi?: {
    readonly path: `/${string}`
    readonly title?: string
    readonly version?: string
  }
  /** Browser origins allowed besides the server's own. Requests without `Origin` are always served. */
  readonly origins?: ReadonlyArray<string>
  readonly limits?: {
    /** Default 1 MiB. */
    readonly requestBytes?: number
    /** Default 8 KiB. */
    readonly credentialBytes?: number
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/** The path segment an actor's event feed is served at, so no member may take it. */
const FEED_ROUTE = "events"

const RESERVED_MEMBERS: ReadonlySet<string> = new Set([FEED_ROUTE])

const ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
  "durable-protocol",
  "durable-min-version",
  "last-event-id",
  "traceparent",
  "tracestate",
].join(", ")

// Clients mint ids up to a second or a round trip behind the database clock,
// then retry within the window; shorter windows expire ids before delivery.
const MIN_RETRY_WINDOW_MS = 60_000

const EXPOSED_HEADERS = ["x-request-id", "durable-now", "durable-version", "retry-after"].join(", ")

const JSON_TYPE = /^application\/json[ ]*(;.*)?$/i

// A quoted value is the idempotency-key draft's structured-field string.
const QUOTED = /^"(.*)"$/

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const decodeSuccess = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) })),
)

const decodeDeclared = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const utf8 = new TextEncoder()

const bytes = (value: string) => utf8.encode(value).byteLength

const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "0".repeat(32)),
)

const defectResponse = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
  const trace = yield* traceId

  yield* Effect.logError("Actor.serve request failed", cause)

  return HttpServerResponse.jsonUnsafe(Defect.make({ traceId: trace }), { status: 500 })
})

const pathId = Effect.fnUntraced(function* (definition: ServedDefinition) {
  if (definition.key === "singleton") return yield* definition.decodeId("").pipe(Effect.orDie)

  const raw = (yield* HttpRouter.params).id ?? ""

  if (raw === "." || raw === "..") return yield* invalidInput("unservable_id")

  return yield* definition.decodeId(raw).pipe(Effect.mapError((error) => undecodable(error)))
})

/** Same origin: the `Origin` names the request URL's scheme and the `Host` it was sent to. */
export const isSameOrigin = ({
  request,
  origin,
}: {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly origin: string
}) => {
  const host = Headers.get(request.headers, "host")

  if (Option.isNone(host)) return false

  if (!URL.canParse(request.originalUrl)) return false

  try {
    const parsed = new URL(origin)

    return parsed.host === host.value && parsed.protocol === new URL(request.originalUrl).protocol
  } catch {
    return false
  }
}

const isPrincipal = Schema.is(Schema.Union([User, Anonymous]))

/** Sockets awaiting `hello`, per runtime, across every `Actor.serve` layer it runs. */
const awaitingHello = new WeakMap<object, { count: number }>()

const offeredProtocols = (request: HttpServerRequest.HttpServerRequest) =>
  Option.match(Headers.get(request.headers, "sec-websocket-protocol"), {
    onNone: () => [],
    onSome: (value) => value.split(",").map((protocol) => protocol.trim()),
  })

// A connection route answers only a WebSocket upgrade that offers our subprotocol first,
// which the server then selects.
const isConnectionUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  Option.exists(
    Headers.get(request.headers, "upgrade"),
    (value) => value.toLowerCase() === "websocket",
  ) && offeredProtocols(request)[0] === SUBPROTOCOL

const resolve = (actor: { readonly name: string }): ServedDefinition => {
  const definition = servedDefinitions.get(actor)

  if (definition === undefined)
    throw new Error(`Actor.serve: ${actor.name} is not an Actor.make definition`)

  if (!NAME.test(definition.name))
    throw new Error(`Actor.serve: actor name ${definition.name} is not [A-Za-z][A-Za-z0-9_]*`)

  for (const member of [...definition.members, ...definition.connections]) {
    if (!NAME.test(member.tag) || RESERVED_MEMBERS.has(member.tag))
      throw new Error(`Actor.serve: ${definition.name}.${member.tag} can't be served`)
  }

  return definition
}

/**
 * Serves `actors`' public commands, reducers, and queries over HTTP by adding
 * routes to the `HttpRouter`, plus `/protocol`, `/command-ids`, and, when
 * configured, the OpenAPI document.
 */
export const serve = <R = never>(options: ServeOptions<R>) =>
  HttpRouter.use(
    Effect.fnUntraced(function* (router) {
      const basePath = (options.basePath ?? "").replace(/\/+$/, "")
      const definitions = options.actors.map(resolve)
      const names = new Set<string>()

      for (const definition of definitions) {
        if (names.has(definition.name))
          return yield* Effect.die(new Error(`Actor.serve: ${definition.name} is listed twice`))
        names.add(definition.name)

        const collision = [...definition.members, ...definition.connections].find((member) =>
          PROTOCOL_OPERATIONS.has(`${definition.name}.${member.tag}`),
        )

        if (collision !== undefined)
          return yield* Effect.die(
            new Error(
              `Actor.serve: ${definition.name}.${collision.tag} collides with a protocol operation id`,
            ),
          )
      }

      const openapiPath = options.openapi?.path

      if (
        openapiPath !== undefined &&
        (openapiPath === "/protocol" ||
          openapiPath === "/command-ids" ||
          openapiPath === KEY_REFRESH_PATH ||
          openapiPath === "/actors" ||
          openapiPath.startsWith("/actors/"))
      )
        return yield* Effect.die(
          new Error(`Actor.serve: openapi.path ${openapiPath} collides with a protocol route`),
        )

      // The document names one security scheme per kind, so a second credential of a kind would vanish from it.
      const schemes = options.auth.credentials.map(schemeName)

      if (new Set(schemes).size !== schemes.length)
        return yield* Effect.die(
          new Error(
            `Actor.serve: the auth provider declares more than one credential documented as the same OpenAPI scheme (${schemes.join(", ")})`,
          ),
        )

      const actors = yield* InternalActors

      if (actors.retryWindowMs < MIN_RETRY_WINDOW_MS)
        return yield* Effect.die(
          new Error(
            `Actor.serve: retryWindowMs is ${actors.retryWindowMs}; served clients need at least 60 seconds`,
          ),
        )

      for (const definition of definitions) {
        const registered = actors.registered(definition.name)

        const missing =
          definition.members.some((member) =>
            member.kind === "query" ? !registered.queries : !registered.commands,
          ) ||
          (definition.connections.length > 0 && !registered.commands)

        if (missing)
          return yield* Effect.die(
            new Error(`Actor.serve: provide ${definition.name}'s command and query layers`),
          )
      }

      const clock = yield* databaseClock
      const context = yield* Effect.context<R>()
      const scope = yield* Effect.scope
      const origins = new Set(options.origins ?? [])
      const requestBytes = options.limits?.requestBytes ?? 1024 * 1024
      const credentialBytes = options.limits?.credentialBytes ?? 8 * 1024
      const withCookies = readsCookies(options.auth)
      const withAssertion = options.auth.credentials.some(Credential.$is("Assertion"))
      const api = build({ definitions, basePath })

      const withProtocol = (
        request: HttpServerRequest.HttpServerRequest,
        response: HttpServerResponse.HttpServerResponse,
      ) => {
        const origin = Headers.get(request.headers, "origin")

        const stamped = HttpServerResponse.setHeaders(response, {
          "durable-protocol": String(PROTOCOL),
          "durable-now": String(clock.now()),
        })

        return Option.isSome(origin) && origins.has(origin.value)
          ? HttpServerResponse.setHeaders(stamped, {
              "access-control-allow-origin": origin.value,
              "access-control-expose-headers": EXPOSED_HEADERS,
              vary: "Origin",
            })
          : stamped
      }

      // Every route: origin before authentication, then the protocol version.
      const guard = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const origin = Headers.get(request.headers, "origin")

          if (
            Option.isSome(origin) &&
            !origins.has(origin.value) &&
            !isSameOrigin({ request, origin: origin.value })
          )
            return yield* invalidInput("origin_not_allowed")

          const protocol = Headers.get(request.headers, "durable-protocol")

          if (Option.isSome(protocol) && protocol.value.trim() !== String(PROTOCOL))
            return yield* invalidInput("unsupported_protocol")
        })

      const respond =
        (
          handler: (
            request: HttpServerRequest.HttpServerRequest,
          ) => Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            ActorError,
            HttpRouter.RouteContext
          >,
          headers?: (request: HttpServerRequest.HttpServerRequest) => Record<string, string>,
        ) =>
        (request: HttpServerRequest.HttpServerRequest) =>
          guard(request).pipe(
            Effect.andThen(handler(request)),
            Effect.catch((error) => actorErrorResponse(error)),
            Effect.catchCause(defectResponse),
            Effect.map((response) =>
              withProtocol(
                request,
                headers === undefined
                  ? response
                  : HttpServerResponse.setHeaders(response, headers(request)),
              ),
            ),
          )

      // `credential` is a WebSocket frame's, read instead of the request's `authorization`.
      const authenticate = (request: HttpServerRequest.HttpServerRequest, credential?: string) =>
        Effect.gen(function* () {
          const authorization = Headers.get(request.headers, "authorization")
          const cookie = Headers.get(request.headers, "cookie")
          const assertion = Headers.get(request.headers, ASSERTION_HEADER)

          if (
            (credential !== undefined && bytes(credential) > credentialBytes) ||
            (Option.isSome(authorization) && bytes(authorization.value) > credentialBytes) ||
            (withCookies && Option.isSome(cookie) && bytes(cookie.value) > credentialBytes) ||
            (withAssertion && Option.isSome(assertion) && bytes(assertion.value) > credentialBytes)
          )
            return yield* invalidInput("too_large")

          const cookies = withCookies ? request.cookies : {}

          const authenticated: Authenticated = yield* options.auth
            .authenticate(
              credential === undefined
                ? { headers: request.headers, cookies }
                : { headers: request.headers, cookies, credential },
            )
            .pipe(
              Effect.provideContext(context),
              Effect.mapError((reason) => ActorError.make({ reason })),
            )

          if (!isPrincipal(authenticated.caller))
            return yield* Effect.die(
              new Error("Actor.serve: an auth provider returned a System caller"),
            )

          if (!withinLimits(authenticated)) {
            yield* Effect.logWarning("Actor.serve: auth provider result exceeds principal limits")

            return yield* ActorError.make({
              reason: Unauthorized.make({ code: "invalid_credentials" }),
            })
          }

          return authenticated
        })

      // The body's bytes, bounded; empty when there is none.
      const readBytes = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.gen(function* () {
          const length = Headers.get(request.headers, "content-length")

          if (Option.isSome(length) && Number(length.value) > requestBytes)
            return yield* invalidInput("too_large")

          if (Option.isSome(length) && Number(length.value) === 0) return new Uint8Array(0)

          // A request without framing headers may carry no body stream at all.
          const unframed =
            Option.isNone(length) && !Headers.has(request.headers, "transfer-encoding")

          let received = 0

          const chunks = yield* request.stream.pipe(
            Stream.catch(() =>
              unframed && received === 0 ? Stream.empty : Stream.fail(invalidInput("decode")),
            ),
            Stream.runFoldEffect(
              () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
              (acc, chunk) => {
                const size = acc.size + chunk.byteLength

                if (size > requestBytes) return Effect.fail(invalidInput("too_large"))
                received = size
                acc.chunks.push(chunk)

                return Effect.succeed({ size, chunks: acc.chunks })
              },
            ),
          )

          const body = new Uint8Array(chunks.size)
          let offset = 0

          for (const chunk of chunks.chunks) {
            body.set(chunk, offset)
            offset += chunk.byteLength
          }

          return body
        })

      const decodeJsonBody = (request: HttpServerRequest.HttpServerRequest, body: Uint8Array) =>
        Effect.gen(function* () {
          if (body.byteLength === 0) return undefined

          if (!Headers.has(request.headers, "content-type"))
            return yield* invalidInput("unsupported_media_type")

          const text = yield* Effect.try({
            try: () => strictUtf8.decode(body),
            catch: () => invalidInput("decode"),
          })

          return yield* decodeBody(text).pipe(Effect.mapError((error) => undecodable(error)))
        })

      const refuseBinding = ActorError.make({
        reason: Unauthorized.make({ code: "invalid_credentials" }),
      })

      // A bound credential admits only the request it was issued for, checked before any turn.
      const checkBinding = (
        authenticated: Authenticated,
        request: HttpServerRequest.HttpServerRequest,
        body: Uint8Array,
      ) =>
        authenticated.binding === undefined
          ? Effect.void
          : requestDigest({
              method: request.method,
              target: request.url,
              idempotencyKey: Option.getOrUndefined(
                Headers.get(request.headers, "idempotency-key"),
              ),
              body,
            }).pipe(
              Effect.flatMap((digest) =>
                digest === authenticated.binding?.request
                  ? Effect.void
                  : Effect.fail(refuseBinding),
              ),
            )

      // A renewal binds the session's upgrade path and its own session id.
      const checkRenewal = (
        authenticated: Authenticated,
        request: HttpServerRequest.HttpServerRequest,
      ) => {
        const binding = authenticated.binding

        if (binding === undefined) return Effect.void

        if (binding.session === undefined) return Effect.fail(refuseBinding)

        return reauthenticationDigest({ path: request.url, session: binding.session }).pipe(
          Effect.flatMap((digest) =>
            digest === binding.request ? Effect.void : Effect.fail(refuseBinding),
          ),
        )
      }

      const empty = new Uint8Array(0)

      const commandId = (request: HttpServerRequest.HttpServerRequest) => {
        const header = Headers.get(request.headers, "idempotency-key")

        if (Option.isNone(header)) return undefined

        const value = header.value.trim()

        return QUOTED.exec(value)?.[1] ?? value
      }

      const success = Effect.fnUntraced(function* (member: ServedMember, value: string) {
        if (SchemaAST.isVoid(member.output.ast)) return HttpServerResponse.empty({ status: 204 })
        const decoded = yield* decodeSuccess(value).pipe(Effect.orDie)

        return HttpServerResponse.jsonUnsafe(decoded.value ?? null, { status: 200 })
      })

      const outcomeResponse = (member: ServedMember, outcome: Outcome) =>
        Match.value(outcome).pipe(
          Match.tagsExhaustive({
            Success: (success_) => success(member, success_.value),
            Failure: (failure) =>
              Effect.gen(function* () {
                const status = yield* member.failureStatus(failure.value)
                const body = yield* decodeDeclared(failure.value)

                return HttpServerResponse.jsonUnsafe(body, { status })
              }).pipe(Effect.orDie),
            Defect: (defect) => Effect.failCause(Cause.die(defect.cause)),
            // Only subscription deliveries, which never come from HTTP, are acknowledged.
            Acknowledged: (acknowledged) =>
              Effect.die(new Error(`Unexpected ${acknowledged.reason} acknowledgement`)),
          }),
        )

      const memberHandler = (definition: ServedDefinition, member: ServedMember) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)

          const authenticated = yield* authenticate(request)
          const isQuery = member.kind === "query"
          const key = isQuery ? "" : commandId(request)

          if (key === undefined) return yield* invalidInput("missing_command_id")

          const type = Headers.get(request.headers, "content-type")

          if (Option.isSome(type) && !JSON_TYPE.test(type.value))
            return yield* invalidInput("unsupported_media_type")

          const bytes = yield* readBytes(request)

          yield* checkBinding(authenticated, request, bytes)
          const body = yield* decodeJsonBody(request, bytes)

          const payload = yield* member
            .payload(body)
            .pipe(Effect.mapError((error) => undecodable(error)))

          const call = Request.make({
            ref: ActorRef.make({ tenant: authenticated.tenant, actor: definition.name, id }),
            caller: authenticated.caller,
            command: member.tag,
            commandId: key,
            payload,
          })

          if (isQuery) return yield* outcomeResponse(member, yield* actors.query(call))

          // Accepted work continues if the client disconnects: the turn runs
          // in the layer's scope, and only the wait is interrupted.
          const fiber = yield* actors.execute(call).pipe(Effect.exit, Effect.forkIn(scope))
          const exit = yield* Fiber.join(fiber)

          if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)

          return yield* outcomeResponse(member, exit.value)
        })

      const awaiting = awaitingHello.get(actors) ?? { count: 0 }
      awaitingHello.set(actors, awaiting)

      // A connection is a WebSocket upgrade; nothing is authorized or woken before its `hello`.
      const connectionHandler = (definition: ServedDefinition, connection: ServedConnection) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)

          if (!isConnectionUpgrade(request)) return yield* invalidInput("unsupported_protocol")

          // A non-browser client, or a cookie provider, may authenticate the upgrade itself.
          const upgrade =
            Headers.has(request.headers, "authorization") ||
            (withCookies && Headers.has(request.headers, "cookie")) ||
            (withAssertion && Headers.has(request.headers, ASSERTION_HEADER))
              ? yield* authenticate(request).pipe(
                  Effect.tap((authenticated) => checkBinding(authenticated, request, empty)),
                )
              : undefined

          if (awaiting.count >= MAX_AWAITING_HELLO)
            return yield* ActorError.make({ reason: RunnerAtCapacity.make({}) })
          awaiting.count += 1
          let waiting = true

          const greeted = Effect.sync(() => {
            if (!waiting) return
            waiting = false
            awaiting.count -= 1
          })

          yield* request.upgrade.pipe(
            Effect.flatMap((socket) =>
              socketSession({
                socket,
                connection,
                holder: actors.holder,
                ref: (tenant) => ActorRef.make({ tenant, actor: definition.name, id }),
                upgrade,
                authenticate: (credential) =>
                  authenticate(request, credential).pipe(
                    Effect.tap((authenticated) => checkBinding(authenticated, request, empty)),
                  ),
                reauthenticate: (credential) =>
                  authenticate(request, credential).pipe(
                    Effect.tap((authenticated) => checkRenewal(authenticated, request)),
                  ),
                greeted,
              }),
            ),
            Effect.ensuring(greeted),
            Effect.scoped,
            Effect.orDie,
          )

          return HttpServerResponse.empty()
        })

      const encodeCursorError = Schema.encodeEffect(Schema.Union([UnknownCursor, RetentionGap]))

      // An event feed: authorized per event tag, answered with its cursor's errors before any
      // stream starts, and never creating the actor it follows.
      const feedHandler = (definition: ServedDefinition) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const query = new URL(request.url, "http://feed").searchParams
          const tags = [...new Set(query.getAll("event"))]

          if (tags.length > MAX_FEED_FILTERS) return yield* invalidInput("too_many_filters")

          // No wildcard: every tag a caller reads is one `authorize` sees.
          if (tags.length === 0 || tags.some((tag) => !definition.feeds.includes(tag)))
            return yield* invalidInput("unknown_event")

          // A browser's own reconnect resumes where it stopped.
          const after = Option.getOrUndefined(
            Option.orElse(Headers.get(request.headers, "last-event-id"), () =>
              Option.fromNullishOr(query.get("after")),
            ),
          )

          const authenticated = yield* authenticate(request)

          yield* checkBinding(authenticated, request, empty)
          const ref = ActorRef.make({ tenant: authenticated.tenant, actor: definition.name, id })

          if (!(yield* actors.exists(ref)))
            return yield* ActorError.make({ reason: NotCreated.make({}) })

          const options = {
            actors,
            ref,
            tags,
            caller: authenticated.caller,
            expiresAt:
              authenticated.expiresAt === undefined
                ? undefined
                : DateTime.toEpochMillis(authenticated.expiresAt),
          }

          const held = yield* openFeed(options)

          const checked = yield* actors.readFeed(ref, tags, after, 1).pipe(
            Effect.as(undefined),
            Effect.catchTags({
              UnknownCursor: (error) => Effect.succeed({ error, status: 404 }),
              RetentionGap: (error) => Effect.succeed({ error, status: 410 }),
            }),
            Effect.tapError(() => held.close),
          )

          if (checked !== undefined) {
            yield* held.close
            const body = yield* encodeCursorError(checked.error).pipe(Effect.orDie)

            return HttpServerResponse.jsonUnsafe(body, { status: checked.status })
          }

          return HttpServerResponse.stream(feedStream({ options, first: held, after }), {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
          })
        })

      const requestId =
        (member: ServedMember) =>
        (request: HttpServerRequest.HttpServerRequest): Record<string, string> => {
          if (member.kind === "query") return {}

          const key = commandId(request)

          return key === undefined ? {} : { "x-request-id": key }
        }

      for (const definition of definitions)
        for (const member of definition.members)
          yield* router.add(
            "POST",
            `${basePath}${memberPath({ definition, member })}` as HttpRouter.PathInput,
            respond(memberHandler(definition, member), requestId(member)),
          )

      for (const definition of definitions)
        if (definition.feeds.length > 0)
          yield* router.add(
            "GET",
            `${basePath}${memberPath({ definition, member: { tag: FEED_ROUTE } })}` as HttpRouter.PathInput,
            respond(feedHandler(definition)),
          )

      for (const definition of definitions)
        for (const connection of definition.connections)
          yield* router.add(
            "GET",
            `${basePath}${memberPath({ definition, member: connection })}` as HttpRouter.PathInput,
            respond(connectionHandler(definition, connection)),
          )

      yield* router.add(
        "GET",
        `${basePath}/protocol` as HttpRouter.PathInput,
        respond(() =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              protocol: PROTOCOL,
              retryWindowMs: actors.retryWindowMs,
              now: clock.now(),
            }),
          ),
        ),
      )

      yield* router.add(
        "POST",
        `${basePath}/command-ids` as HttpRouter.PathInput,
        respond((request) =>
          Effect.gen(function* () {
            const authenticated = yield* authenticate(request)

            if (authenticated.binding !== undefined)
              yield* checkBinding(authenticated, request, yield* readBytes(request))

            return HttpServerResponse.jsonUnsafe({ commandId: yield* actors.mintCommandId })
          }),
        ),
      )

      // The edge's push after it revokes a signing key: reread the key set now.
      const refreshKeys = options.auth.refreshKeys

      if (refreshKeys !== undefined)
        yield* router.add(
          "POST",
          `${basePath}${KEY_REFRESH_PATH}` as HttpRouter.PathInput,
          respond((request) =>
            refreshKeys({ headers: request.headers, cookies: {} }).pipe(
              Effect.provideContext(context),
              Effect.mapError((reason) => ActorError.make({ reason })),
              Effect.as(HttpServerResponse.empty({ status: 204 })),
            ),
          ),
        )

      const preflight = HttpServerResponse.empty({
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": ALLOWED_HEADERS,
          "access-control-max-age": "600",
        },
      })

      const fallback = respond((request) =>
        request.method === "OPTIONS" ? Effect.succeed(preflight) : invalidInput("unknown_route"),
      )

      yield* router.add("*", `${basePath}/actors/*` as HttpRouter.PathInput, fallback)
      yield* router.add("OPTIONS", `${basePath}/*` as HttpRouter.PathInput, fallback)

      if (options.openapi !== undefined) {
        const spec = document({
          api,
          auth: options.auth,
          title: options.openapi.title ?? "durable-actors",
          version: options.openapi.version ?? "1",
        })

        yield* router.add(
          "GET",
          `${basePath}${options.openapi.path}` as HttpRouter.PathInput,
          respond(() => Effect.succeed(HttpServerResponse.jsonUnsafe(spec))),
        )
      }
    }),
  )
