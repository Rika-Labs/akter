import { BunCrypto } from "@effect/platform-bun"
import { ASSERTION_TYPE, type BoundRequest, requestDigest, User } from "@durable-actors/core"
import { Actors, Auth } from "@durable-actors/core/runtime"
import {
  type Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Encoding,
  Layer,
  type PlatformError,
  Schema,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
} from "effect/unstable/http"
import { connect, type Http2Failure, listen } from "../http2.ts"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { ReducerProbe } from "../probe/reducers.ts"
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

type Failure = HttpClientError.HttpClientError | PlatformError.PlatformError | Http2Failure

type CallError = Failure | Cause.UnknownError

interface Caller {
  readonly command: (id: string, amount: number) => Effect.Effect<unknown, CallError>
  readonly query: (id: string) => Effect.Effect<unknown, CallError>
}

type RequestHeaders = Readonly<Record<string, string>>

/** One request over the server's protocol; fails on a status outside 2xx. */
type Send = (
  method: "GET" | "POST",
  path: string,
  headers: RequestHeaders,
  body?: string,
) => Effect.Effect<string, Failure>

/** Raw requests with a command id minted from the `/protocol` offset, over either protocol. */
interface Endpoint {
  readonly command: (id: string, amount: number) => Effect.Effect<string, Failure>
  readonly weigh: (id: string, blob: string) => Effect.Effect<string, Failure>
  readonly query: (id: string) => Effect.Effect<string, Failure>
}

interface Served extends Endpoint {
  /** The same calls through `@durable-actors/core/client`, which mints ids, decodes replies, and tracks tokens. */
  readonly client: Caller
  /** The Promise client over a connection that loses every hundredth command response after the server sent it. */
  readonly lossy: Caller
  /** A reducer through the Promise client; `visible` gets the nanoseconds until `state.current` showed it. */
  readonly reduce: (
    id: string,
    visible: Array<bigint>,
  ) => Effect.Effect<unknown, Cause.UnknownError>
}

interface Credentials {
  readonly name: string
  readonly provider: typeof Auth.none
  readonly authorization?: string
  /** Per-request headers, for a credential bound to the request it authenticates. */
  readonly sign?: (request: BoundRequest) => Effect.Effect<RequestHeaders>
}

const none: Credentials = { name: "none", provider: Auth.none }

const ISSUER = "https://issuer.bench"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const segment = (value: Schema.Json) =>
  encodeJson(value).pipe(Effect.orDie, Effect.map(Encoding.encodeBase64Url))

/** `Auth.jwt` with a static ES256 key, and a token it accepts for the whole run. */
const jwtAuth = Effect.gen(function* () {
  const keys = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )

  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", keys.publicKey))
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

  const signed = `${yield* segment({ alg: "ES256", kid: "k1", typ: "JWT" })}.${yield* segment({
    iss: ISSUER,
    aud: "bench",
    sub: "bench-user",
    org: "bench",
    exp: now + 3600,
  })}`

  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(signed),
    ),
  )

  return {
    name: "jwt-es256",
    provider: Auth.jwt({
      issuer: ISSUER,
      audience: "bench",
      algorithms: ["ES256"],
      jwks: {
        keys: [{ kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "", kid: "k1" }],
      },
      tenant: () => "bench",
    }),
    authorization: `Bearer ${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`,
  } satisfies Credentials
})

/**
 * `Auth.assertion` with a static Ed25519 key, and an edge-like signer
 * that binds a fresh assertion to every request, as the hosted edge does.
 */
const assertionAuth = Effect.gen(function* () {
  const keys = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  )

  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", keys.publicKey))
  const header = yield* segment({ alg: "EdDSA", typ: ASSERTION_TYPE, kid: "edge-1" })
  const utf8 = new TextEncoder()

  return {
    name: "assertion-ed25519",
    provider: Auth.assertion({
      issuer: ISSUER,
      audience: "bench",
      region: "bench-1",
      keys: { keys: [{ kid: "edge-1", kty: "OKP", crv: "Ed25519", x: exported.x ?? "" }] },
    }),
    sign: (request) =>
      Effect.gen(function* () {
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

        const signed = `${header}.${yield* segment({
          iss: ISSUER,
          aud: "bench",
          region: "bench-1",
          iat: now,
          exp: now + 10,
          tenant: "bench",
          caller: User.make({ subject: "bench-user" }),
          req: yield* requestDigest(request),
        })}`

        const signature = yield* Effect.promise(() =>
          crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, utf8.encode(signed)),
        )

        return {
          "durable-assertion": `${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`,
        }
      }),
  } satisfies Credentials
})

/**
 * A 512-byte subject whose encoded caller is as close to the 1 KiB cap as
 * whole characters allow: control characters cost six bytes once escaped.
 */
const largestSubject = (() => {
  const escaped = Math.floor(
    (1024 - (JSON.stringify(User.make({ subject: "s" })).length - 1) - 512) / 5,
  )

  return "\u0001".repeat(escaped) + "s".repeat(512 - escaped)
})()

const largest: Credentials = {
  name: "largest-principal",
  provider: Auth.make(() =>
    Effect.succeed({ caller: User.make({ subject: largestSubject }), tenant: "default" }),
  ),
}

const callerBytes = new TextEncoder().encode(
  JSON.stringify(User.make({ subject: largestSubject })),
).byteLength

const BLOB = "x".repeat(64 * 1024)

const baseFetch = globalThis.fetch.bind(globalThis)

/** Loses every hundredth command response after the server committed and answered it. */
const losing = () => {
  let commands = 0

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    const drop = url.endsWith("/Add") && ++commands % 100 === 0

    return baseFetch(input, init).then((response) =>
      drop
        ? response.text().then(() => Promise.reject(new TypeError("connection reset")))
        : response,
    )
  }
}

/** The probe's `Actors.serve` layer as a web handler, disposed with the scope. */
const handler = Effect.fnUntraced(function* (auth: Credentials) {
  const services = yield* Effect.context<ActorServices>()

  const app = Actors.serve({ actors: [Probe, ReducerProbe], auth: auth.provider }).pipe(
    Layer.provide(Layer.succeedContext(services)),
  )

  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))

  return (request: Request) => web.handler(request)
})

const decodeProtocol = Schema.decodeEffect(Schema.fromJsonString(ProtocolInfo))

/** Commands, 64 KiB payloads, and queries through `send`, as a thin client that keeps a clock offset sends them. */
const endpoint = Effect.fnUntraced(function* (auth: Credentials, send: Send) {
  const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

  const protocol = yield* send("GET", "/protocol", {}).pipe(
    Effect.flatMap(decodeProtocol),
    Effect.orDie,
  )

  const offset = protocol.now - (yield* Clock.currentTimeMillis)

  const mint = Effect.gen(function* () {
    const issued = (yield* Clock.currentTimeMillis) + offset - 1000

    return `v1.${issued}.${issued + protocol.retryWindowMs}.${yield* crypto.randomUUIDv4}`
  })

  const headers: RequestHeaders =
    auth.authorization === undefined
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", authorization: auth.authorization }

  const utf8 = new TextEncoder()

  const signed = (path: string, key: string | undefined, body: string) =>
    auth.sign === undefined
      ? Effect.succeed(headers)
      : auth
          .sign({ method: "POST", target: path, idempotencyKey: key, body: utf8.encode(body) })
          .pipe(Effect.map((bound) => ({ ...headers, ...bound })))

  const query = (path: string, body: string) =>
    signed(path, undefined, body).pipe(Effect.flatMap((all) => send("POST", path, all, body)))

  const command = (path: string, body: string) =>
    mint.pipe(
      Effect.flatMap((key) =>
        signed(path, key, body).pipe(
          Effect.flatMap((all) => send("POST", path, { ...all, "idempotency-key": key }, body)),
        ),
      ),
    )

  return {
    command: (id, amount) => command(`/actors/Probe/${id}/Add`, String(amount)),
    weigh: (id, blob) => command(`/actors/Probe/${id}/Weigh`, JSON.stringify(blob)),
    query: (id) => query(`/actors/Probe/${id}/Peek`, "null"),
  } satisfies Endpoint
})

/** Serves the probe from a listening Bun server over HTTP/1.1; every request crosses loopback through `fetch`. */
const serve = Effect.fnUntraced(function* (auth: Credentials = none) {
  const handle = yield* handler(auth)

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
  )

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  const url = `http://127.0.0.1:${server.port}`

  const send: Send = (method, path, headers, body) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.make(method)(`${url}${path}`, { headers })

      const response = yield* client.execute(
        body === undefined
          ? request
          : HttpClientRequest.bodyText(request, body, headers["content-type"]),
      )

      return yield* response.text
    })

  const probes = Probe.client({ baseUrl: url })
  const lossy = Probe.client({ baseUrl: url, fetch: losing() })
  const reducers = ReducerProbe.client({ baseUrl: url })

  return {
    ...(yield* endpoint(auth, send)),
    client: {
      command: (id, amount) => Effect.tryPromise(() => probes.get(id).Add(amount)),
      query: (id) => Effect.tryPromise(() => probes.get(id).Peek()),
    },
    lossy: {
      command: (id, amount) => Effect.tryPromise(() => lossy.get(id).Add(amount)),
      query: (id) => Effect.tryPromise(() => lossy.get(id).Peek()),
    },
    reduce: (id, visible) =>
      Effect.gen(function* () {
        const handle = reducers.get(id)
        const before = handle.state.current?.count
        const started = yield* Clock.currentTimeNanos
        const reply = handle.Add(1)
        const shown = handle.state.current?.count
        const elapsed = (yield* Clock.currentTimeNanos) - started

        if (before !== undefined) {
          if (shown !== before + 1)
            return yield* Effect.die(new Error("Optimistic state not shown"))

          visible.push(elapsed)
        }

        return yield* Effect.tryPromise(() => reply)
      }),
  } satisfies Served
})

/** Serves the same layer over cleartext HTTP/2; every caller's request is a stream on one shared connection. */
const serveHttp2 = Effect.fnUntraced(function* (auth: Credentials = none) {
  const url = yield* listen(yield* handler(auth))

  return yield* endpoint(auth, yield* connect(url))
})

/**
 * Commands and queries through `Actors.serve`; compare with hot-actor and
 * query-latency for the embedded cost.
 *
 * Each lost response is retried with its id; a second turn would count twice.
 */
export const http: Scenario = {
  name: "http",
  description:
    "Actors.serve over loopback HTTP/1.1 keep-alive and cleartext HTTP/2: sequential commands and queries on one actor and 64 concurrent command callers over 1k actors, through raw fetch, the @durable-actors/core/client Promise SDK (also with 1% response loss), and raw requests on one multiplexed HTTP/2 connection, then sequential commands with an ES256 JWT, an Ed25519 edge assertion signed per request, the largest allowed principal, and a 64 KiB payload over both protocols.",
  run: (context) =>
    Effect.gen(function* () {
      const results: Array<CaseResult> = []

      const callers = [
        { prefix: "", via: "fetch", protocol: "http/1.1", open: () => serve() },
        {
          prefix: "client-",
          via: "client",
          protocol: "http/1.1",
          open: () => Effect.map(serve(), (served): Caller => served.client),
        },
        { prefix: "h2-", via: "node:http2", protocol: "h2c", open: () => serveHttp2() },
      ] as const

      for (const { prefix, via, protocol, open } of callers) {
        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const caller = yield* open()
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => caller.command("hot", 1),
                })

                return yield* measure({
                  name: `${prefix}command-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via, protocol },
                  instruments,
                  workers: 1,
                  operations: context.quick ? 300 : 3000,
                  operation: () => caller.command("hot", 1),
                  listStatements: true,
                })
              }),
            ),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const caller = yield* open()
                yield* caller.command("read", 1).pipe(Effect.orDie)
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => caller.query("read"),
                })

                return yield* measure({
                  name: `${prefix}query-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via, protocol },
                  instruments,
                  workers: 1,
                  operations: context.quick ? 300 : 3000,
                  operation: () => caller.query("read"),
                  listStatements: true,
                })
              }),
            ),
          ),
        )

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const caller = yield* open()
                const actors = 1000
                yield* load({
                  workers: 32,
                  operations: actors,
                  operation: (actor) => caller.command(`hot-${actor}`, 1),
                })

                return yield* measure({
                  name: `${prefix}command-concurrent-64`,
                  parameters: { actors, workers: 64, auth: "none", via, protocol },
                  instruments,
                  workers: 64,
                  durationMs: context.quick ? 2000 : 10_000,
                  operation: (index) => caller.command(`hot-${index % actors}`, 1),
                })
              }),
            ),
          ),
        )
      }

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              const warmup = 100
              const operations = context.quick ? 300 : 3000
              yield* load({
                workers: 1,
                operations: warmup,
                operation: () => served.lossy.command("lossy", 1),
              })

              const result = yield* measure({
                name: "client-command-sequential-1pct-loss",
                parameters: {
                  actors: 1,
                  workers: 1,
                  auth: "none",
                  via: "client",
                  protocol: "http/1.1",
                  loss: "1%",
                },
                instruments,
                workers: 1,
                operations,
                operation: () => served.lossy.command("lossy", 1),
              })

              const count = yield* served.client.query("lossy").pipe(Effect.orDie)

              return {
                ...result,
                extra: { ...result.extra, duplicateTurns: Number(count) - warmup - operations },
              }
            }),
          ),
        ),
      )

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              const warmup: Array<bigint> = []
              yield* load({
                workers: 1,
                operations: 100,
                operation: () => served.reduce("reduced", warmup),
              })

              const visible: Array<bigint> = []

              const result = yield* measure({
                name: "client-reducer-sequential",
                parameters: {
                  actors: 1,
                  workers: 1,
                  auth: "none",
                  via: "client",
                  protocol: "http/1.1",
                },
                instruments,
                workers: 1,
                operations: context.quick ? 300 : 3000,
                operation: () => served.reduce("reduced", visible),
              })

              const sorted = visible.map((ns) => Number(ns) / 1e6).sort((a, b) => a - b)

              const at = (q: number) =>
                sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!

              return {
                ...result,
                extra: {
                  ...result.extra,
                  optimisticVisibleP50Ms: Math.round(at(0.5) * 1000) / 1000,
                  optimisticVisibleP99Ms: Math.round(at(0.99) * 1000) / 1000,
                },
              }
            }),
          ),
        ),
      )

      const sequential = (
        name: string,
        auth: Credentials,
        extra: Readonly<Record<string, number | string>>,
        operation: (served: Endpoint) => Effect.Effect<string, Failure>,
      ) =>
        Effect.gen(function* () {
          for (const [prefix, via, protocol, open] of [
            ["", "fetch", "http/1.1", serve],
            ["h2-", "node:http2", "h2c", serveHttp2],
          ] as const)
            results.push(
              yield* context.withRuntime({}, (instruments) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const served = yield* open(auth)
                    yield* load({ workers: 1, operations: 50, operation: () => operation(served) })

                    return yield* measure({
                      name: `${prefix}${name}`,
                      parameters: { actors: 1, workers: 1, auth: auth.name, via, protocol },
                      instruments,
                      workers: 1,
                      operations: context.quick ? 200 : 2000,
                      operation: () => operation(served),
                      extra,
                    })
                  }),
                ),
              ),
            )
        })

      yield* sequential("command-sequential-jwt", yield* jwtAuth, {}, (served) =>
        served.command("hot", 1),
      )

      yield* sequential("command-sequential-assertion", yield* assertionAuth, {}, (served) =>
        served.command("hot", 1),
      )

      yield* sequential(
        "command-sequential-largest-principal",
        largest,
        { callerBytes },
        (served) => served.command("hot", 1),
      )

      yield* sequential("command-sequential-64kib", none, { payloadBytes: BLOB.length }, (served) =>
        served.weigh("payload", BLOB),
      )

      return results
    }),
}
