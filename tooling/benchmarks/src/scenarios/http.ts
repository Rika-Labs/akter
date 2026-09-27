import { BunCrypto } from "@effect/platform-bun"
import { Actor, User } from "durable-actors"
import { Clock, Context, Crypto, Effect, Encoding, Layer, type PlatformError, Schema } from "effect"
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
import { type ActorServices, type CaseResult, measure, type Scenario } from "../scenario.ts"

const ProtocolInfo = Schema.Struct({ retryWindowMs: Schema.Int, now: Schema.Int })

type Failure = HttpClientError.HttpClientError | PlatformError.PlatformError

interface Served {
  readonly url: string
  readonly command: (id: string, amount: number) => Effect.Effect<string, Failure>
  readonly weigh: (id: string, blob: string) => Effect.Effect<string, Failure>
  readonly query: (id: string) => Effect.Effect<string, Failure>
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

/** Serves the probe from a listening Bun server; every request crosses loopback through `fetch`. */
const serve = Effect.fnUntraced(function* (auth: Auth = none) {
  const services = yield* Effect.context<ActorServices>()
  const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
  )

  const app = Actor.serve({ actors: [Probe], auth: auth.provider }).pipe(
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

  return {
    url,
    command: (id, amount) =>
      mint.pipe(Effect.flatMap((key) => post(`/actors/Probe/${id}/Add`, String(amount), key))),
    weigh: (id, blob) =>
      mint.pipe(
        Effect.flatMap((key) => post(`/actors/Probe/${id}/Weigh`, JSON.stringify(blob), key)),
      ),
    query: (id) => post(`/actors/Probe/${id}/Peek`, "null"),
  } satisfies Served
})

/** Commands and queries through `Actor.serve`; compare with hot-actor and query-latency for the embedded cost. */
export const http: Scenario = {
  name: "http",
  description:
    "Actor.serve over loopback HTTP/1.1 keep-alive: sequential commands and queries on one actor, 64 concurrent command callers over 1k actors, then sequential commands with an ES256 JWT, the largest allowed principal, and a 64 KiB payload.",
  run: (context) =>
    Effect.gen(function* () {
      const quick = context.profile === "quick"
      const results: Array<CaseResult> = []

      results.push(
        yield* context.withRuntime({}, (instruments) =>
          Effect.scoped(
            Effect.gen(function* () {
              const served = yield* serve()
              yield* load({
                workers: 1,
                operations: 100,
                operation: () => served.command("hot", 1),
              })

              return yield* measure({
                name: "command-sequential",
                parameters: { actors: 1, workers: 1, auth: "none" },
                instruments,
                workers: 1,
                operations: quick ? 300 : 3000,
                operation: () => served.command("hot", 1),
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
              yield* served.command("read", 1).pipe(Effect.orDie)
              yield* load({ workers: 1, operations: 100, operation: () => served.query("read") })

              return yield* measure({
                name: "query-sequential",
                parameters: { actors: 1, workers: 1, auth: "none" },
                instruments,
                workers: 1,
                operations: quick ? 300 : 3000,
                operation: () => served.query("read"),
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
                operation: (actor) => served.command(`hot-${actor}`, 1),
              })

              return yield* measure({
                name: "command-concurrent-64",
                parameters: { actors, workers: 64, auth: "none" },
                instruments,
                workers: 64,
                durationMs: quick ? 2000 : 10_000,
                operation: (index) => served.command(`hot-${index % actors}`, 1),
              })
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
