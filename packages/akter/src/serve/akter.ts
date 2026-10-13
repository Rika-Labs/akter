import { Crypto, Duration, Effect, Layer, Option, Predicate, Result, Schema } from "effect"
import type { Scope } from "effect"
import {
  Cookies,
  FetchHttpClient,
  Headers,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import type { HttpClient } from "effect/http"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { ActorError, Unauthorized } from "../contract/errors.ts"
import { Engine } from "../execution/engine.ts"
import type { Bound, Catalog } from "../execution/durable.ts"
import { Jobs } from "../execution/jobs.ts"
import { groupOf, SPAN_PREFIX } from "../rpc/group.ts"
import type { App } from "../runtime/app.ts"
import { Store } from "../store/service.ts"
import { KEY_REFRESH_PATH, requestDigest } from "./assertion/binding.ts"
import type { AuthProvider, AuthRequest } from "./auth.ts"
import { CREDENTIAL_BYTES, oversizedCredential, readsCookies, withinLimits } from "./auth.ts"
import { Handlers } from "./handlers.ts"
import { isSameOrigin } from "./origin.ts"
import { Authorization, SESSION_HEADER, Sessions } from "./session.ts"
import { refusalResponse } from "./wire.ts"

/** How `Akter.serve` listens and whom it admits. */
export interface ServeOptions {
  /** The app to serve: its actors define the `/rpc` group and its layer their handlers. */
  readonly app: App
  /** Who the caller is on every request; `Auth.none` is the explicit public opt-out. */
  readonly auth: AuthProvider<HttpClient.HttpClient>
  /** Default 8080; 0 picks a free port, which the provided `HttpServer`'s address reports. */
  readonly port?: number
  /** Default `0.0.0.0`. */
  readonly hostname?: string
  /** A path prefix for `/rpc`, `/ready` and the key refresh route, such as `/api`. Default none. */
  readonly basePath?: string
  /** Browser origins admitted besides the server's own. */
  readonly origins?: ReadonlyArray<string>
  /** How often a live session reruns `auth` and `access`; default 60 seconds. */
  readonly reauthorizeEvery?: Duration.Input
  /** The largest credential a request may carry, in UTF-8 bytes; default 8 KiB. */
  readonly credentialBytes?: number
}

const refused = (code: (typeof Unauthorized.Type)["code"]) =>
  ActorError.make({ reason: Unauthorized.make({ code }) })

/**
 * Tenants other than `default` are refused until actor ids are scoped by tenant, so two tenants
 * can never reach one actor.
 */
const SERVED_TENANT = "default"

const onBun = "Bun" in globalThis

/**
 * The running platform's HTTP server and `Crypto`. The platform package is imported when the
 * layer builds, so a Node process never loads Bun's package and a Bun process never loads Node's.
 */
const platform = (port: number, hostname: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (onBun) {
        const server = yield* Effect.promise(() => import("@effect/platform-bun/BunHttpServer"))
        const crypto = yield* Effect.promise(() => import("@effect/platform-bun/BunCrypto"))
        return Layer.merge(server.layerServer({ port, hostname }), crypto.layer)
      }
      const http = yield* Effect.promise(() => import("node:http"))
      const server = yield* Effect.promise(() => import("@effect/platform-node/NodeHttpServer"))
      const crypto = yield* Effect.promise(() => import("@effect/platform-node/NodeCrypto"))
      return Layer.merge(
        server.layerServer(http.createServer, { port, host: hostname }),
        crypto.layer,
      )
    }),
  )

/**
 * The engine over the provided store, with every actor of the app bound. One served process owns
 * every shard of its store, so it assigns itself all of them; a cron tick more than an hour late
 * after downtime is skipped.
 */
const engineOf = (app: App) =>
  Effect.gen(function* () {
    const store = yield* Store
    const actors = new Map<string, Bound>()
    for (const actor of app.actors)
      actors.set(actor.name, { actor, registered: yield* actor.implementation })
    const catalog: Catalog = { actors, shards: store.meta.shards }
    const engine = yield* Engine.make(catalog, {
      shards: catalog.shards,
      policy: "matching",
      maxBatch: 64,
      checkpointEvery: 64,
      cronSkipIfOlderThan: 3_600_000,
      doubleRun: false,
      observer: undefined,
    })
    Jobs.install(engine)
    yield* engine.assign(Array.from({ length: catalog.shards }, (_, shard) => shard))
    return engine
  })

const ReadyBody = Schema.Struct({
  ready: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
})

/**
 * Serves an app's one RPC group at `{basePath}/rpc`: JSON over WebSocket on `GET` and NDJSON
 * over HTTP on `POST`, plus `GET {basePath}/ready` and, when `auth` holds a key set, the key
 * refresh push. Every route refuses a foreign browser `Origin` first; `/rpc` then runs `auth`
 * before the RPC handler, answering `401`, `403`, `429` or `503` with the error envelope, and
 * binds the caller to the request or, on a socket, to the session for its lifetime. Runs on
 * Bun or Node, whichever runs it, over the provided `Store`.
 *
 * @example
 * ```ts
 * Akter.serve({ app, auth: Auth.none }).pipe(
 *   Layer.provide(Store.fileSystem("./data")),
 *   Layer.launch,
 * )
 * ```
 */
const serve = (options: ServeOptions) => {
  const base = options.basePath ?? ""
  const rpcPath = `${base}/rpc`
  const origins = new Set(options.origins ?? [])
  const auth = options.auth
  const limit = options.credentialBytes ?? CREDENTIAL_BYTES

  const routes = Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const engine = yield* engineOf(options.app)
    const sessions = yield* Sessions.make({
      auth,
      reauthorizeEvery: options.reauthorizeEvery ?? Duration.seconds(60),
    })
    const group = groupOf(options.app.actors).middleware(Authorization)
    const handlers = yield* group.toHandlers(
      Effect.succeed(Handlers.make(engine, options.app.actors, sessions)),
    )
    const served = <E, R>(
      protocol: Effect.Effect<
        {
          readonly protocol: RpcServer.Protocol["Service"]
          readonly httpEffect: Effect.Effect<
            HttpServerResponse.HttpServerResponse,
            never,
            Scope.Scope | HttpServerRequest.HttpServerRequest
          >
        },
        E,
        R
      >,
      serialization: RpcSerialization.RpcSerialization["Service"],
    ) =>
      Effect.flatMap(
        Effect.provideService(protocol, RpcSerialization.RpcSerialization, serialization),
        (made) =>
          RpcServer.make(group, { spanPrefix: SPAN_PREFIX, disableFatalDefects: true }).pipe(
            Effect.provideService(RpcServer.Protocol, transportHeadersOnly(made.protocol)),
            Effect.provideService(Authorization, Sessions.middleware(sessions)),
            Effect.provideContext(handlers),
            Effect.forkScoped,
            Effect.as(made.httpEffect),
          ),
      )
    const socket = yield* served(
      RpcServer.makeProtocolWithHttpEffectWebsocket,
      RpcSerialization.json,
    )
    const http = yield* served(RpcServer.makeProtocolWithHttpEffect(), RpcSerialization.ndjson)
    let ready = true
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ready = false
      }),
    )

    const authRequest = (request: HttpServerRequest.HttpServerRequest): AuthRequest => ({
      headers: Headers.remove(request.headers, SESSION_HEADER),
      cookies: readsCookies(auth)
        ? Cookies.parseHeader(Option.getOrElse(Headers.get(request.headers, "cookie"), () => ""))
        : {},
    })

    /**
     * Runs `auth` for one `/rpc` request, checks a hosted assertion's binding against what
     * arrived, opens the session and hands the request to the RPC transport. The session id
     * reaches the middleware only through the request's own headers.
     */
    const gate = (
      request: HttpServerRequest.HttpServerRequest,
      transport: typeof socket,
      kind: "socket" | "http",
    ) =>
      Effect.gen(function* () {
        const id = yield* Effect.orDie(crypto.randomUUIDv4())
        const trusted = request.modify({
          headers: Headers.set(request.headers, SESSION_HEADER, id),
        })
        const credentials = authRequest(request)
        if (oversizedCredential({ provider: auth, headers: credentials.headers, limit }))
          return yield* refusalResponse(refused("invalid_credentials"))
        const authenticated = yield* Effect.result(auth.authenticate(credentials))
        if (Result.isFailure(authenticated)) return yield* refusalResponse(authenticated.failure)
        const caller = authenticated.success
        if (!withinLimits(caller)) return yield* refusalResponse(refused("invalid_credentials"))
        if (caller.tenant !== SERVED_TENANT) return yield* refusalResponse(refused("access_denied"))
        if (caller.binding !== undefined) {
          const body =
            kind === "http"
              ? new Uint8Array(yield* Effect.orDie(trusted.arrayBuffer))
              : new Uint8Array(0)
          const digest = yield* requestDigest({
            method: request.method,
            target: request.url,
            idempotencyKey: Option.getOrUndefined(Headers.get(request.headers, "idempotency-key")),
            body,
          })
          if (
            digest !== caller.binding.request ||
            (kind === "socket") !== (caller.binding.session !== undefined)
          )
            return yield* refusalResponse(refused("invalid_credentials"))
        }
        yield* sessions.open({
          id,
          authenticated: caller,
          request: credentials,
          path: new URL(request.url, "http://runner").pathname,
        })
        return yield* Effect.provideService(transport, HttpServerRequest.HttpServerRequest, trusted)
      })

    return HttpServer.serve(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const origin = Headers.get(request.headers, "origin")
        if (
          Option.isSome(origin) &&
          !origins.has(origin.value) &&
          !isSameOrigin({ request, origin: origin.value })
        )
          return yield* refusalResponse(refused("access_denied"))
        const path = new URL(request.url, "http://runner").pathname.replace(/(.)\/$/, "$1")
        if (path === rpcPath && request.method === "GET")
          return yield* gate(request, socket, "socket")
        if (path === rpcPath && request.method === "POST") return yield* gate(request, http, "http")
        if (path === `${base}/ready` && request.method === "GET")
          return HttpServerResponse.jsonUnsafe(
            ready ? ReadyBody.make({ ready }) : ReadyBody.make({ ready, reason: "draining" }),
            { status: ready ? 200 : 503 },
          )
        const refreshKeys = auth.refreshKeys
        if (
          path === `${base}${KEY_REFRESH_PATH}` &&
          request.method === "POST" &&
          refreshKeys !== undefined
        ) {
          const refreshed = yield* Effect.result(refreshKeys(authRequest(request)))
          return Result.isSuccess(refreshed)
            ? HttpServerResponse.empty({ status: 204 })
            : yield* refusalResponse(refused("invalid_credentials"))
        }
        return HttpServerResponse.empty({ status: path === rpcPath ? 405 : 404 })
      }),
    )
  })

  return Layer.unwrap(routes).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(
      Layer.provideMerge(
        options.app.layer,
        platform(options.port ?? 8080, options.hostname ?? "0.0.0.0"),
      ),
    ),
  )
}

/**
 * The transport's protocol with each request's headers reduced to the transport's own: a header
 * a frame repeats after the request's headers cannot replace one the gate set.
 */
const transportHeadersOnly = (
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] => ({
  ...protocol,
  run: (handle) =>
    protocol.run((clientId, message) => {
      if (!Predicate.isTagged(message, "Request")) return handle(clientId, message)
      const seen = new Set<string>()
      const headers: Array<[string, string]> = []
      for (const [name, value] of message.headers) {
        const key = name.toLowerCase()
        if (key === SESSION_HEADER && seen.has(key)) continue
        seen.add(key)
        headers.push([name, value])
      }
      return handle(clientId, { ...message, headers })
    }),
})

/** The served process: `Akter.serve`. */
export const Akter = { serve }
