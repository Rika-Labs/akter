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
import {
  ActorError,
  InvalidInput,
  NotCreated,
  RunnerAtCapacity,
  Unauthorized,
} from "../errors/actor.ts"
import { InternalActors } from "../runtime/actors.ts"
import { Outcome, Request } from "../runtime/request.ts"
import { ContentStore } from "../handles/content.ts"
import { MAX_CONTENT_BYTES } from "../runtime/content/store.ts"
import { ActorRef, Anonymous, CurrentCaller, User } from "../identity/caller.ts"
import { isVersion } from "../identity/version.ts"
import {
  buildServedApi,
  CONTENT_ROUTE,
  openApiDocument,
  memberPath,
  PROTOCOL_OPERATIONS,
  PROTOCOL_PATHS,
  schemeName,
} from "./api.ts"
import { RuntimeControl } from "../runtime/drain.ts"
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
import { handleMcp, type ToolCall, type ToolResult } from "./mcp/endpoint.ts"
import { mcpTools } from "./mcp/tools.ts"
import { cursorErrorBody, feedStream, MAX_FEED_FILTERS, openFeed } from "./sessions/feed.ts"
import { MAX_AWAITING_HELLO, socketSession } from "./sessions/socket.ts"
import { streamResponse } from "./sessions/stream.ts"
import { watchResponse } from "./sessions/watch.ts"
import {
  actorErrorBody,
  actorErrorResponse,
  Defect,
  invalidInput,
  PROTOCOL,
  undecodable,
} from "./wire.ts"

/** Options of `Actor.serve`; `R` is what `auth` needs from the environment. */
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
  /**
   * Serves an MCP endpoint at `path`, derived from the same OpenAPI document:
   * every public command, reducer, and query is a tool, and each call is
   * authenticated and authorized like its HTTP route. Off unless given.
   */
  readonly mcp?: {
    readonly path: `/${string}`
    readonly name?: string
    readonly version?: string
  }
  /** Browser origins allowed besides the server's own. Requests without `Origin` are always served. */
  readonly origins?: ReadonlyArray<string>
  /** Size limits; each falls back to its default. */
  readonly limits?: {
    /** Largest request body in bytes. Default 1 MiB. */
    readonly requestBytes?: number
    /** Largest `authorization`, `cookie` or assertion header, and frame credential, in bytes. Default 8 KiB. */
    readonly credentialBytes?: number
    /**
     * The body limit of `POST /content`, the one route exempt from
     * `requestBytes`. Default and maximum 64 MiB, the content size limit.
     */
    readonly contentBytes?: number
  }
}

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/** The path segment an actor's event feed is served at, so no member may take it. */
const FEED_ROUTE = "events"

const RESERVED_MEMBERS: ReadonlySet<string> = new Set([FEED_ROUTE, CONTENT_ROUTE])

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

/**
 * Clients mint ids up to a second or a round trip behind the database clock,
 * then retry within the window; shorter windows expire ids before delivery.
 */
const MIN_RETRY_WINDOW_MS = 60_000

const EXPOSED_HEADERS = ["x-request-id", "durable-now", "durable-version", "retry-after"].join(", ")

const JSON_TYPE = /^application\/json[ ]*(;.*)?$/i

/** A quoted value is the idempotency-key draft's structured-field string. */
const QUOTED = /^"(.*)"$/

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const decodeSuccess = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.optionalKey(Schema.Json) })),
)

const utf8 = new TextEncoder()

const bytes = (value: string) => utf8.encode(value).byteLength

const traceId = Effect.currentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "0".repeat(32)),
)

/** The opaque body a defect is answered with on every transport, after its cause is logged. */
const defectBody = Effect.fnUntraced(function* (cause: Cause.Cause<unknown>) {
  const trace = yield* traceId

  yield* Effect.logError("Actor.serve request failed", cause)

  return Defect.make({ traceId: trace })
})

const defectResponse = (cause: Cause.Cause<unknown>) =>
  Effect.map(defectBody(cause), (body) => HttpServerResponse.jsonUnsafe(body, { status: 500 }))

/** An actor's id as a request names it: the key schema decodes it exactly once, and no route or tool may name `.` or `..`. */
const decodeId = Effect.fnUntraced(function* (definition: ServedDefinition, raw: string) {
  if (definition.key === "singleton") return yield* definition.decodeId("").pipe(Effect.orDie)

  if (raw === "." || raw === "..") return yield* invalidInput("unservable_id")

  return yield* definition.decodeId(raw).pipe(Effect.mapError((error) => undecodable(error)))
})

const pathId = Effect.fnUntraced(function* (definition: ServedDefinition) {
  return yield* decodeId(definition, (yield* HttpRouter.params).id ?? "")
})

/** One served member's call once its caller is authenticated and its id decoded. */
interface MemberCall {
  readonly definition: ServedDefinition
  readonly member: ServedMember
  readonly id: string
  readonly authenticated: Authenticated
  readonly commandId: string
  readonly body: Schema.Json | undefined
  readonly minVersion?: Effect.Effect<string | undefined, ActorError>
}

/** A settled call as every transport answers it: a status and the JSON body, absent for a void output. */
type OutcomeBody =
  | { readonly ok: true; readonly status: number; readonly body: Schema.Json | undefined }
  | { readonly ok: false; readonly status: number; readonly body: Schema.Json }

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

/** A connection route answers only a WebSocket upgrade that offers our subprotocol first, which the server then selects. */
/** A server-sent event response that proxies must neither cache nor buffer. */
const eventStream = <E>(body: Stream.Stream<Uint8Array, E>) =>
  HttpServerResponse.stream(body, {
    contentType: "text/event-stream",
    headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
  })

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

  for (const member of [...definition.members, ...definition.connections, ...definition.streams]) {
    if (!NAME.test(member.tag) || RESERVED_MEMBERS.has(member.tag))
      throw new Error(`Actor.serve: ${definition.name}.${member.tag} can't be served`)
  }

  return definition
}

/**
 * Serves `actors`' public commands, reducers, queries, streams, connections,
 * event feeds, and content over HTTP by adding routes to the `HttpRouter`,
 * plus `/protocol`, `/command-ids`, `/ready`, and, when configured, the
 * OpenAPI document. Building the layer dies when an actor is listed twice, a
 * member collides with a protocol route, the runtime's retry window is under
 * 60 seconds, an actor's layers are not provided, `limits.contentBytes` is out
 * of range, or the auth provider declares two credentials of one OpenAPI
 * scheme (the document names one scheme per kind, so the second would vanish).
 *
 * Guarantees and ordering:
 * - Every route checks the origin before authenticating, then the protocol
 *   version.
 * - A credential bound to a request admits only that request, checked before
 *   any turn; a renewal binds the session's upgrade path and its own session id.
 * - A malformed `durable-min-version` is refused, because ignoring it would
 *   silently drop the caller's read-your-writes guarantee.
 * - A command accepted for execution continues if the client disconnects: the
 *   turn runs in the layer's scope and only the caller's wait is interrupted.
 * - A request with neither `content-length` nor `transfer-encoding` may carry
 *   no body stream at all, and is read as empty.
 * - A connection is a WebSocket upgrade; nothing is authorized or woken before
 *   its `hello`. A non-browser client, or a cookie provider, may authenticate
 *   the upgrade request itself.
 * - An event feed authorizes every tag the caller reads (there is no
 *   wildcard), answers cursor errors before any stream starts, and never
 *   creates the actor it follows. A browser's reconnect resumes from
 *   `Last-Event-ID`.
 * - A content upload streams into the store hashed as it arrives; past the
 *   limit its transaction rolls back and nothing is stored. Under a credential
 *   bound to its request it is read whole first, up to the same limit, so the
 *   binding is checked before anything is stored. A sweep between
 *   resolving a download's name and reading its bytes ends the body before any
 *   byte, short of its declared length.
 * - `/ready` carries no credentials and is never cached, because a stale
 *   answer would route traffic to a draining runner.
 * - With a provider that has `refreshKeys`, the edge's push after it revokes a
 *   signing key rereads the key set at once.
 *
 * @example
 * ```ts
 * const Api = Actor.serve({ actors: [Counter], auth: Actor.auth.none, basePath: "/api" })
 * ```
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

        const collision = [
          ...definition.members,
          ...definition.connections,
          ...definition.streams,
        ].find((member) => PROTOCOL_OPERATIONS.has(`${definition.name}.${member.tag}`))

        if (collision !== undefined)
          return yield* Effect.die(
            new Error(
              `Actor.serve: ${definition.name}.${collision.tag} collides with a protocol operation id`,
            ),
          )
      }

      const documentPaths = [
        { option: "openapi", path: options.openapi?.path },
        { option: "mcp", path: options.mcp?.path },
      ]

      for (const { option, path } of documentPaths)
        if (
          path !== undefined &&
          (PROTOCOL_PATHS.has(path) ||
            path === KEY_REFRESH_PATH ||
            path === "/actors" ||
            path.startsWith("/actors/"))
        )
          return yield* Effect.die(
            new Error(`Actor.serve: ${option}.path ${path} collides with a protocol route`),
          )

      if (options.mcp !== undefined && options.mcp.path === options.openapi?.path)
        return yield* Effect.die(
          new Error(`Actor.serve: mcp.path and openapi.path are both ${options.mcp.path}`),
        )

      const schemes = options.auth.credentials.map(schemeName)

      if (new Set(schemes).size !== schemes.length)
        return yield* Effect.die(
          new Error(
            `Actor.serve: the auth provider declares more than one credential documented as the same OpenAPI scheme (${schemes.join(", ")})`,
          ),
        )

      const actors = yield* InternalActors
      const control = yield* RuntimeControl

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
          (definition.connections.length + definition.streams.length > 0 && !registered.commands)

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
      const contentBytes = options.limits?.contentBytes ?? MAX_CONTENT_BYTES

      if (
        !Number.isSafeInteger(contentBytes) ||
        contentBytes < 0 ||
        contentBytes > MAX_CONTENT_BYTES
      )
        return yield* Effect.die(
          new Error(
            `Actor.serve: limits.contentBytes must be a whole number of bytes up to ${MAX_CONTENT_BYTES}`,
          ),
        )

      const contentStore = yield* Effect.serviceOption(ContentStore)
      const withCookies = readsCookies(options.auth)
      const withAssertion = options.auth.credentials.some(Credential.$is("Assertion"))
      const api = buildServedApi({ definitions, basePath, content: Option.isSome(contentStore) })

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

      /**
       * Answers one route. A handler passes the authenticated caller in each
       * request it makes, and runs with `Anonymous` as the ambient caller, so
       * a path that forgot to pass it is refused like a visitor without
       * credentials instead of running as the process's trusted `System`.
       */
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
            Effect.provideService(CurrentCaller, Anonymous.make({})),
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

      const readBytes = (request: HttpServerRequest.HttpServerRequest, limit = requestBytes) =>
        Effect.gen(function* () {
          const length = Headers.get(request.headers, "content-length")

          if (Option.isSome(length) && Number(length.value) > limit)
            return yield* invalidInput("too_large")

          if (Option.isSome(length) && Number(length.value) === 0) return new Uint8Array(0)

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

                if (size > limit) return Effect.fail(invalidInput("too_large"))
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

          return yield* decodeJson(text).pipe(Effect.mapError((error) => undecodable(error)))
        })

      const refuseBinding = ActorError.make({
        reason: Unauthorized.make({ code: "invalid_credentials" }),
      })

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

      /** Checks a route that ignores its body against the credential's binding, reading the body only when bound. */
      const checkUnreadBody = (
        authenticated: Authenticated,
        request: HttpServerRequest.HttpServerRequest,
      ) =>
        authenticated.binding === undefined
          ? Effect.void
          : readBytes(request).pipe(
              Effect.flatMap((body) => checkBinding(authenticated, request, body)),
            )

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

      /** Reads a request body a JSON content type or none allows, checked against the credential's binding. */
      const readBound = (
        request: HttpServerRequest.HttpServerRequest,
        authenticated: Authenticated,
      ) =>
        Effect.gen(function* () {
          const type = Headers.get(request.headers, "content-type")

          if (Option.isSome(type) && !JSON_TYPE.test(type.value))
            return yield* invalidInput("unsupported_media_type")

          const body = yield* readBytes(request)

          yield* checkBinding(authenticated, request, body)

          return body
        })

      const refOf = (definition: ServedDefinition, id: string, authenticated: Authenticated) =>
        ActorRef.make({ tenant: authenticated.tenant, actor: definition.name, id })

      const commandId = (request: HttpServerRequest.HttpServerRequest) => {
        const header = Headers.get(request.headers, "idempotency-key")

        if (Option.isNone(header)) return undefined

        const value = header.value.trim()

        return QUOTED.exec(value)?.[1] ?? value
      }

      const minVersion = (request: HttpServerRequest.HttpServerRequest) => {
        const token = Option.getOrUndefined(Headers.get(request.headers, "durable-min-version"))

        if (token === undefined || isVersion(token)) return Effect.succeed(token)

        return Effect.fail(
          ActorError.make({
            reason: InvalidInput.make({
              code: "decode",
              issues: [
                {
                  path: "durable-min-version",
                  message: "Expected a non-negative decimal integer without leading zeros",
                },
              ],
            }),
          }),
        )
      }

      const outcomeBody = (member: ServedMember, outcome: Outcome) =>
        Match.value(outcome).pipe(
          Match.tagsExhaustive({
            Success: (success): Effect.Effect<OutcomeBody> =>
              Effect.gen(function* () {
                if (SchemaAST.isVoid(member.output.ast))
                  return { ok: true, status: 204, body: undefined } as const

                const decoded = yield* decodeSuccess(success.value)

                return { ok: true, status: 200, body: decoded.value ?? null } as const
              }).pipe(Effect.orDie),
            Failure: (failure): Effect.Effect<OutcomeBody> =>
              Effect.gen(function* () {
                const status = yield* member.failureStatus(failure.value)

                return { ok: false, status, body: yield* decodeJson(failure.value) } as const
              }).pipe(Effect.orDie),
            Defect: (defect) => Effect.failCause(Cause.die(defect.cause)),
            Acknowledged: (acknowledged) =>
              Effect.die(new Error(`Unexpected ${acknowledged.reason} acknowledgement`)),
          }),
        )

      const outcomeResponse = (member: ServedMember, outcome: Outcome) =>
        Effect.map(outcomeBody(member, outcome), ({ status, body }) =>
          body === undefined
            ? HttpServerResponse.empty({ status })
            : HttpServerResponse.jsonUnsafe(body, { status }),
        )

      const runMember = Effect.fnUntraced(function* (input: MemberCall) {
        const { definition, member, authenticated } = input

        const payload = yield* member
          .payload(input.body)
          .pipe(Effect.mapError((error) => undecodable(error)))

        const call = Request.make({
          ref: refOf(definition, input.id, authenticated),
          caller: authenticated.caller,
          command: member.tag,
          commandId: input.commandId,
          payload,
        })

        if (member.kind === "query")
          return {
            outcome: yield* actors.query(
              call,
              input.minVersion === undefined ? undefined : yield* input.minVersion,
            ),
            version: undefined,
          }

        const fiber = yield* actors.execute(call).pipe(Effect.exit, Effect.forkIn(scope))
        const exit = yield* Fiber.join(fiber)

        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)

        return exit.value
      })

      const memberHandler = (definition: ServedDefinition, member: ServedMember) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)

          const authenticated = yield* authenticate(request)
          const key = member.kind === "query" ? "" : commandId(request)

          if (key === undefined) return yield* invalidInput("missing_command_id")

          const bytes = yield* readBound(request, authenticated)

          const { outcome, version } = yield* runMember({
            definition,
            member,
            id,
            authenticated,
            commandId: key,
            body: yield* decodeJsonBody(request, bytes),
            minVersion: minVersion(request),
          })

          const response = yield* outcomeResponse(member, outcome)

          return version === undefined
            ? response
            : HttpServerResponse.setHeader(response, "durable-version", version)
        })

      const callTool =
        (authenticated: Authenticated) =>
        (call: ToolCall): Effect.Effect<ToolResult> => {
          const route = call.tool.route

          return Effect.gen(function* () {
            if (route === undefined)
              return { ok: true, value: { commandId: yield* actors.mintCommandId } } as const

            const { definition, member } = route

            const { outcome } = yield* runMember({
              definition,
              member,
              id: yield* decodeId(definition, call.id ?? ""),
              authenticated,
              commandId: call.commandId ?? "",
              body: call.input,
            })

            const settled = yield* outcomeBody(member, outcome)

            return settled.ok
              ? ({ ok: true, value: settled.body } as const)
              : ({ ok: false, body: settled.body } as const)
          }).pipe(
            Effect.catch((error) =>
              Effect.map(actorErrorBody(error), (body) => ({ ok: false, body }) as const),
            ),
            Effect.catchCause((cause) =>
              Effect.map(defectBody(cause), (body) => ({ ok: false, body }) as const),
            ),
          )
        }

      const streamHandler = (definition: ServedDefinition, member: ServedMember) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const authenticated = yield* authenticate(request)
          const bytes = yield* readBound(request, authenticated)
          const body = yield* decodeJsonBody(request, bytes)

          const payload = yield* member
            .payload(body)
            .pipe(Effect.mapError((error) => undecodable(error)))

          const elements = actors.subscribe(
            Request.make({
              ref: refOf(definition, id, authenticated),
              caller: authenticated.caller,
              command: member.tag,
              commandId: "",
              payload,
            }),
          )

          return elements.pipe(streamResponse, eventStream)
        })

      const watchHandler = (definition: ServedDefinition, member: ServedMember) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const authenticated = yield* authenticate(request)

          if (!member.watch) return yield* invalidInput("not_watchable")

          const bytes = yield* readBound(request, authenticated)
          const body = yield* decodeJsonBody(request, bytes)

          const payload = yield* member
            .payload(body)
            .pipe(Effect.mapError((error) => undecodable(error)))

          const results = yield* actors.watch(
            Request.make({
              ref: refOf(definition, id, authenticated),
              caller: authenticated.caller,
              command: member.tag,
              commandId: "",
              payload,
            }),
            {
              minVersion: yield* minVersion(request),
              expiresAt:
                authenticated.expiresAt === undefined
                  ? undefined
                  : DateTime.toEpochMillis(authenticated.expiresAt),
            },
          )

          return results.pipe(watchResponse, eventStream)
        })

      const awaiting = awaitingHello.get(actors) ?? { count: 0 }
      awaitingHello.set(actors, awaiting)

      const connectionHandler = (definition: ServedDefinition, connection: ServedConnection) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)

          if (!isConnectionUpgrade(request)) return yield* invalidInput("unsupported_protocol")

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

      const feedHandler = (definition: ServedDefinition) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const query = new URL(request.url, "http://feed").searchParams
          const tags = [...new Set(query.getAll("event"))]

          if (tags.length > MAX_FEED_FILTERS) return yield* invalidInput("too_many_filters")

          if (tags.length === 0 || tags.some((tag) => !definition.feeds.includes(tag)))
            return yield* invalidInput("unknown_event")

          const after = Option.getOrUndefined(
            Option.orElse(Headers.get(request.headers, "last-event-id"), () =>
              Option.fromNullishOr(query.get("after")),
            ),
          )

          const authenticated = yield* authenticate(request)

          yield* checkBinding(authenticated, request, empty)
          const ref = refOf(definition, id, authenticated)

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
            const body = yield* cursorErrorBody(checked.error)

            return HttpServerResponse.jsonUnsafe(body, { status: checked.status })
          }

          return eventStream(feedStream({ options, first: held, after }))
        })

      const uploadHandler = (store: ContentStore["Service"]) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const authenticated = yield* authenticate(request)

          if (authenticated.binding !== undefined) {
            const bytes = yield* readBytes(request, contentBytes)

            yield* checkBinding(authenticated, request, bytes)

            return yield* store.upload(authenticated.tenant, Stream.make(bytes), contentBytes).pipe(
              Effect.catchTag("ContentTooLarge", () => invalidInput("too_large")),
              Effect.map((ref) => HttpServerResponse.jsonUnsafe(ref, { status: 200 })),
            )
          }

          const length = Headers.get(request.headers, "content-length")

          if (Option.isSome(length) && Number(length.value) > contentBytes)
            return yield* invalidInput("too_large")

          const empty =
            (Option.isSome(length) && Number(length.value) === 0) ||
            (Option.isNone(length) && !Headers.has(request.headers, "transfer-encoding"))

          const body = empty
            ? Stream.empty
            : request.stream.pipe(Stream.mapError(() => invalidInput("decode")))

          const ref = yield* store
            .upload(authenticated.tenant, body, contentBytes)
            .pipe(Effect.catchTag("ContentTooLarge", () => invalidInput("too_large")))

          return HttpServerResponse.jsonUnsafe(ref, { status: 200 })
        })

      const contentParams = Effect.fnUntraced(function* (definition: ServedDefinition) {
        const { blob = "", name = "" } = yield* HttpRouter.params

        if (!definition.contents.includes(blob) || name === "")
          return yield* invalidInput("unknown_content")

        return { blob, name }
      })

      const downloadHandler = (store: ContentStore["Service"], definition: ServedDefinition) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const { blob, name } = yield* contentParams(definition)
          const authenticated = yield* authenticate(request)

          yield* checkUnreadBody(authenticated, request)

          const ref = refOf(definition, id, authenticated)
          const found = yield* store.download(ref, authenticated.caller, blob, name)

          if (Option.isNone(found)) return yield* invalidInput("unknown_content")

          return HttpServerResponse.stream(found.value.bytes, {
            contentType: "application/octet-stream",
            contentLength: found.value.size,
          })
        })

      const grantHandler = (store: ContentStore["Service"], definition: ServedDefinition) =>
        Effect.fnUntraced(function* (request: HttpServerRequest.HttpServerRequest) {
          const id = yield* pathId(definition)
          const { blob, name } = yield* contentParams(definition)
          const authenticated = yield* authenticate(request)

          yield* checkUnreadBody(authenticated, request)

          const ref = refOf(definition, id, authenticated)
          const granted = yield* store.grant(ref, authenticated.caller, blob, name)

          if (Option.isNone(granted)) return yield* invalidInput("unknown_content")

          return HttpServerResponse.jsonUnsafe(granted.value, { status: 200 })
        })

      const requestId =
        (member: ServedMember) =>
        (request: HttpServerRequest.HttpServerRequest): Record<string, string> => {
          if (member.kind === "query") return {}

          const key = commandId(request)

          return key === undefined ? {} : { "x-request-id": key }
        }

      const route = (
        method: Parameters<typeof router.add>[0],
        path: string,
        handler: Parameters<typeof respond>[0],
        headers?: Parameters<typeof respond>[1],
      ) =>
        router.add(method, `${basePath}${path}` as HttpRouter.PathInput, respond(handler, headers))

      for (const definition of definitions) {
        for (const member of definition.members)
          yield* route(
            "POST",
            memberPath({ definition, member }),
            memberHandler(definition, member),
            requestId(member),
          )

        for (const member of definition.streams)
          yield* route(
            "POST",
            memberPath({ definition, member }),
            streamHandler(definition, member),
          )

        for (const member of definition.members)
          if (member.kind === "query")
            yield* route(
              "POST",
              `${memberPath({ definition, member })}/watch`,
              watchHandler(definition, member),
            )

        if (definition.feeds.length > 0)
          yield* route(
            "GET",
            memberPath({ definition, member: { tag: FEED_ROUTE } }),
            feedHandler(definition),
          )

        for (const connection of definition.connections)
          yield* route(
            "GET",
            memberPath({ definition, member: connection }),
            connectionHandler(definition, connection),
          )
      }

      if (Option.isSome(contentStore)) {
        const store = contentStore.value

        yield* route("POST", "/content", uploadHandler(store))

        for (const definition of definitions)
          if (definition.contents.length > 0) {
            const entry = `${memberPath({ definition, member: { tag: CONTENT_ROUTE } })}/:blob/:name`

            yield* route("GET", entry, downloadHandler(store, definition))
            yield* route("POST", `${entry}/grant`, grantHandler(store, definition))
          }
      }

      yield* route("GET", "/protocol", () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({
            protocol: PROTOCOL,
            retryWindowMs: actors.retryWindowMs,
            now: clock.now(),
          }),
        ),
      )

      yield* route("GET", "/ready", () =>
        Effect.map(control.readiness, (readiness) =>
          HttpServerResponse.jsonUnsafe(readiness, {
            status: readiness.ready ? 200 : 503,
            headers: { "cache-control": "no-store" },
          }),
        ),
      )

      yield* route("POST", "/command-ids", (request) =>
        Effect.gen(function* () {
          const authenticated = yield* authenticate(request)

          yield* checkUnreadBody(authenticated, request)

          return HttpServerResponse.jsonUnsafe({ commandId: yield* actors.mintCommandId })
        }),
      )

      const refreshKeys = options.auth.refreshKeys

      if (refreshKeys !== undefined)
        yield* route("POST", KEY_REFRESH_PATH, (request) =>
          refreshKeys({ headers: request.headers, cookies: {} }).pipe(
            Effect.provideContext(context),
            Effect.mapError((reason) => ActorError.make({ reason })),
            Effect.as(HttpServerResponse.empty({ status: 204 })),
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

      const fallback = (request: HttpServerRequest.HttpServerRequest) =>
        request.method === "OPTIONS" ? Effect.succeed(preflight) : invalidInput("unknown_route")

      yield* route("*", "/actors/*", fallback)
      yield* route("OPTIONS", "/*", fallback)

      if (options.openapi !== undefined || options.mcp !== undefined) {
        const spec = openApiDocument({
          api,
          auth: options.auth,
          title: options.openapi?.title ?? "durable-actors",
          version: options.openapi?.version ?? "1",
        })

        if (options.openapi !== undefined)
          yield* route("GET", options.openapi.path, () =>
            Effect.succeed(HttpServerResponse.jsonUnsafe(spec)),
          )

        if (options.mcp !== undefined) {
          const endpoint = {
            tools: yield* mcpTools({ document: spec, basePath, definitions }),
            info: {
              name: options.mcp.name ?? "durable-actors",
              version: options.mcp.version ?? "1",
            },
          }

          yield* route("POST", options.mcp.path, (request) =>
            Effect.gen(function* () {
              const authenticated = yield* authenticate(request)
              const body = yield* readBound(request, authenticated)

              return yield* handleMcp(
                { ...endpoint, call: callTool(authenticated) },
                { headers: request.headers, body },
              )
            }),
          )

          const postOnly = () =>
            Effect.succeed(HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } }))

          yield* route("GET", options.mcp.path, postOnly)
          yield* route("DELETE", options.mcp.path, postOnly)
        }
      }
    }),
  )
