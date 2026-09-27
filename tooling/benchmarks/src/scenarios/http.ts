import { BunCrypto } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
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
  HttpClientResponse,
  HttpRouter,
} from "effect/unstable/http"
import { load } from "../measure.ts"
import { Probe } from "../probe/contract.ts"
import { ReducerProbe } from "../probe/reducers.ts"
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

type Failure = HttpClientError.HttpClientError | PlatformError.PlatformError

type CallError = Failure | Cause.UnknownError

interface Caller {
  readonly command: (id: string, amount: number) => Effect.Effect<unknown, CallError>
  readonly query: (id: string) => Effect.Effect<unknown, CallError>
}

interface Served {
  readonly url: string
  readonly command: (id: string, amount: number) => Effect.Effect<string, Failure>
  readonly weigh: (id: string, blob: string) => Effect.Effect<string, Failure>
  readonly query: (id: string) => Effect.Effect<string, Failure>
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

interface Auth {
  readonly name: string
  readonly provider: typeof Actor.auth.none
  readonly authorization?: string
}

const none: Auth = { name: "none", provider: Actor.auth.none }

const ISSUER = "https://issuer.bench"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const segment = (value: Schema.Json) =>
  encodeJson(value).pipe(Effect.orDie, Effect.map(Encoding.encodeBase64Url))

/** `Actor.auth.jwt` with a static ES256 key, and a token it accepts for the whole run. */
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
    provider: Actor.auth.jwt({
      issuer: ISSUER,
      audience: "bench",
      algorithms: ["ES256"],
      jwks: {
        keys: [{ kty: "EC", crv: "P-256", x: exported.x ?? "", y: exported.y ?? "", kid: "k1" }],
      },
      tenant: () => "bench",
    }),
    authorization: `Bearer ${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`,
  } satisfies Auth
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

const largest: Auth = {
  name: "largest-principal",
  provider: Actor.auth.make(() =>
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

/** Serves the probe from a listening Bun server; every request crosses loopback through `fetch`. */
const serve = Effect.fnUntraced(function* (auth: Auth = none) {
  const services = yield* Effect.context<ActorServices>()
  const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
  )

  const app = Actor.serve({ actors: [Probe, ReducerProbe], auth: auth.provider }).pipe(
    Layer.provide(Layer.succeedContext(services)),
  )

  const web = HttpRouter.toWebHandler(app, { disableLogger: true })
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => web.handler(req) })

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => server.stop(true)).pipe(
      Effect.andThen(Effect.promise(() => web.dispose())),
    ),
  )

  const url = `http://127.0.0.1:${server.port}`

  const protocol = yield* client
    .get(`${url}/protocol`)
    .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ProtocolInfo)), Effect.orDie)

  const offset = protocol.now - (yield* Clock.currentTimeMillis)

  // A fresh command id from the database clock, as a thin client's retry loop keeps.
  const mint = Effect.gen(function* () {
    const issued = (yield* Clock.currentTimeMillis) + offset - 1000

    return `v1.${issued}.${issued + protocol.retryWindowMs}.${yield* crypto.randomUUIDv4}`
  })

  const post = (path: string, body: string, key?: string) =>
    Effect.gen(function* () {
      const base = HttpClientRequest.post(`${url}${path}`).pipe(
        HttpClientRequest.bodyText(body, "application/json"),
      )

      const authorized =
        auth.authorization === undefined
          ? base
          : HttpClientRequest.setHeader(base, "authorization", auth.authorization)

      const request =
        key === undefined
          ? authorized
          : HttpClientRequest.setHeader(authorized, "idempotency-key", key)

      return yield* (yield* client.execute(request)).text
    })

  const probes = Probe.client({ baseUrl: url })
  const lossy = Probe.client({ baseUrl: url, fetch: losing() })
  const reducers = ReducerProbe.client({ baseUrl: url })

  return {
    url,
    command: (id, amount) =>
      mint.pipe(Effect.flatMap((key) => post(`/actors/Probe/${id}/Add`, String(amount), key))),
    weigh: (id, blob) =>
      mint.pipe(
        Effect.flatMap((key) => post(`/actors/Probe/${id}/Weigh`, JSON.stringify(blob), key)),
      ),
    query: (id) => post(`/actors/Probe/${id}/Peek`, "null"),
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

/** Commands and queries through `Actor.serve`; compare with hot-actor and query-latency for the embedded cost. */
export const http: Scenario = {
  name: "http",
  description:
    "Actor.serve over loopback HTTP/1.1 keep-alive: sequential commands and queries on one actor and 64 concurrent command callers over 1k actors, through raw fetch and then the @durable-actors/core/client Promise SDK (also with 1% response loss), then sequential commands with an ES256 JWT, the largest allowed principal, and a 64 KiB payload.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      for (const via of ["fetch", "client"] as const) {
        const prefix = via === "fetch" ? "" : "client-"
        const pick = (served: Served): Caller => (via === "fetch" ? served : served.client)

        results.push(
          yield* context.withRuntime({}, (instruments) =>
            Effect.scoped(
              Effect.gen(function* () {
                const served = yield* serve()
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => pick(served).command("hot", 1),
                })

                return yield* measure({
                  name: `${prefix}command-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via },
                  instruments,
                  workers: 1,
                  operations: quick ? 300 : 3000,
                  operation: () => pick(served).command("hot", 1),
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
                const served = yield* serve()
                yield* pick(served).command("read", 1).pipe(Effect.orDie)
                yield* load({
                  workers: 1,
                  operations: 100,
                  operation: () => pick(served).query("read"),
                })

                return yield* measure({
                  name: `${prefix}query-sequential`,
                  parameters: { actors: 1, workers: 1, auth: "none", via },
                  instruments,
                  workers: 1,
                  operations: quick ? 300 : 3000,
                  operation: () => pick(served).query("read"),
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
                const served = yield* serve()
                const actors = 1000
                yield* load({
                  workers: 32,
                  operations: actors,
                  operation: (actor) => pick(served).command(`hot-${actor}`, 1),
                })

                return yield* measure({
                  name: `${prefix}command-concurrent-64`,
                  parameters: { actors, workers: 64, auth: "none", via },
                  instruments,
                  workers: 64,
                  durationMs: quick ? 2000 : 10_000,
                  operation: (index) => pick(served).command(`hot-${index % actors}`, 1),
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
              const operations = quick ? 300 : 3000
              yield* load({
                workers: 1,
                operations: warmup,
                operation: () => served.lossy.command("lossy", 1),
              })

              const result = yield* measure({
                name: "client-command-sequential-1pct-loss",
                parameters: { actors: 1, workers: 1, auth: "none", via: "client", loss: "1%" },
                instruments,
                workers: 1,
                operations,
                operation: () => served.lossy.command("lossy", 1),
              })

              const count = yield* served.client.query("lossy").pipe(Effect.orDie)

              // Each lost response is retried with its id; a second turn would count twice.
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
                parameters: { actors: 1, workers: 1, auth: "none", via: "client" },
                instruments,
                workers: 1,
                operations: quick ? 300 : 3000,
                operation: () => served.reduce("reduced", visible),
              })

              const sorted = visible.map((ns) => Number(ns) / 1e6).sort((a, b) => a - b)

              const at = (q: number) =>
                sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!

              // Read from `state.current` as the call returns, before the round trip.
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
        auth: Auth,
        extra: Readonly<Record<string, number | string>>,
        operation: (served: Served) => Effect.Effect<string, Failure>,
      ) =>
        context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve(auth)
              yield* load({ workers: 1, operations: 50, operation: () => operation(served) })

              return yield* measure({
                name,
                parameters: { actors: 1, workers: 1, auth: auth.name },
                instruments,
                workers: 1,
                operations: quick ? 200 : 2000,
                operation: () => operation(served),
                extra,
              })
            }),
          ),
        )

      results.push(
        yield* sequential("command-sequential-jwt", yield* jwtAuth, {}, (served) =>
          served.command("hot", 1),
        ),
      )

      results.push(
        yield* sequential(
          "command-sequential-largest-principal",
          largest,
          { callerBytes },
          (served) => served.command("hot", 1),
        ),
      )

      results.push(
        yield* sequential(
          "command-sequential-64kib",
          none,
          { payloadBytes: BLOB.length },
          (served) => served.weigh("payload", BLOB),
        ),
      )

      return results
    }),
}
