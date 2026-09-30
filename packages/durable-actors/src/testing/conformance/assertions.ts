import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Layer,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { Actor, Unauthorized, User } from "../../index.ts"
import { ActorError } from "../../errors/actor.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { RuntimeControl } from "../../runtime/drain.ts"
import type { AssertionClaims, AssertionKey } from "../../serve/assertion/verify.ts"
import type { AuthProvider } from "../../serve/auth.ts"
import {
  ASSERTION_HEADER,
  ASSERTION_TYPE,
  KEY_REFRESH_PATH,
  KEY_REFRESH_TYPE,
  reauthenticationDigest,
  requestDigest,
} from "../../serve/assertion/binding.ts"
import { actorErrorBody } from "../../serve/wire.ts"
import type { ConformanceCase } from "../conformance.ts"
import { gate, HttpRoom, receipts, runs, tenantOf } from "./http.ts"
import { endReason, opened, serveSockets, socket } from "./transports.ts"

/**
 * The runner half of hosted assertions: a runner serving with
 * `Actor.auth.assertion` admits a request only with a valid assertion bound
 * to exactly that request. The cases sign assertions as an edge would, with
 * their own Ed25519 keys.
 */

export const ISSUER = "https://edge.durable.test"

export const DEPLOYMENT = "dep-assertions"

export const REGION = "test-1"

/** An edge signing key and the public key runners verify it with. */
export interface EdgeKey {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly publicKey: AssertionKey
}

const utf8 = new TextEncoder()

export const edgeKey = Effect.fnUntraced(function* (kid: string) {
  const pair = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
  )

  const { x } = yield* Effect.promise(() => crypto.subtle.exportKey("jwk", pair.publicKey))

  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: { kid, kty: "OKP", crv: "Ed25519", x: x ?? "" },
  } satisfies EdgeKey
})

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const segment = (value: Schema.Json) =>
  encodeJson(value).pipe(Effect.orDie, Effect.map(Encoding.encodeBase64Url))

export interface JwsHeader {
  readonly alg: string
  readonly typ: string
  readonly kid: string
}

/** A compact JWS over `claims`; the header defaults to an Ed25519 assertion under `key`. */
export const signAssertion = Effect.fnUntraced(function* (
  key: EdgeKey,
  claims: AssertionClaims | { readonly [claim: string]: Schema.Json },
  header?: Partial<JwsHeader>,
) {
  const head = yield* segment({ alg: "EdDSA", typ: ASSERTION_TYPE, kid: key.kid, ...header })
  const signed = `${head}.${yield* segment({ ...claims })}`

  const signature = yield* Effect.promise(() =>
    crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, utf8.encode(signed)),
  )

  return `${signed}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`
})

/** A key-set refresh push for `audience`, issued now for 10 seconds, signed with `key`. */
export const signRefresh = Effect.fnUntraced(function* (key: EdgeKey, audience = DEPLOYMENT) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const claims = { iss: ISSUER, aud: audience, iat: now, exp: now + 10 }

  return yield* signAssertion(key, claims, { typ: KEY_REFRESH_TYPE })
})

/** Claims for `tenant`'s `subject`, issued now for 10 seconds, bound to `req`. */
export const claimsFor = Effect.fnUntraced(function* (options: {
  readonly tenant: string
  readonly subject: string
  readonly req: string
}) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

  return {
    iss: ISSUER,
    aud: DEPLOYMENT,
    region: REGION,
    iat: now,
    exp: now + 10,
    tenant: options.tenant,
    caller: User.make({ subject: options.subject }),
    req: options.req,
  } satisfies AssertionClaims
})

type Change = (claims: AssertionClaims) => AssertionClaims

interface Reply {
  readonly status: number
  readonly body: Schema.Json | undefined
}

/** A request as sent; an empty `body` sends none. */
interface Sent {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly key: string | undefined
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

interface AssertedServer {
  /** The runner's base URL. */
  readonly url: string
  readonly send: (request: Sent) => Effect.Effect<Reply>
  /** The `req` claim for `request` as the runner will receive it. */
  readonly digest: (request: Sent) => Effect.Effect<string>
  /** A v1 command id issued now. */
  readonly mint: Effect.Effect<string>
}

/** Sends `request` to the server at `url`. */
const sendTo = (client: HttpClient.HttpClient, url: string) => (request: Sent) =>
  Effect.gen(function* () {
    const base = HttpClientRequest.make(request.method)(`${url}${request.path}`, {
      headers: request.headers,
    })

    const keyed =
      request.key === undefined
        ? base
        : HttpClientRequest.setHeader(base, "idempotency-key", request.key)

    const built =
      request.body === ""
        ? keyed
        : HttpClientRequest.bodyText(keyed, request.body, "application/json")

    const response = yield* client.execute(built)
    const text = yield* response.text

    return { status: response.status, body: text === "" ? undefined : yield* decodeJson(text) }
  }).pipe(Effect.orDie)

/** Serves `HttpRoom` with `auth` from a real listening Bun server for the rest of the scope. */
const serveAsserted = Effect.fnUntraced(function* (
  auth: AuthProvider<HttpClient.HttpClient> | AuthProvider,
): Effect.fn.Return<
  AssertedServer,
  never,
  InternalActors | RuntimeControl | Crypto.Crypto | Scope.Scope
> {
  const actors = yield* InternalActors
  const random = yield* Crypto.Crypto
  const context = yield* Effect.context<InternalActors | RuntimeControl>()
  const fetchLayer = yield* Layer.build(FetchHttpClient.layer)
  const client = Context.get(fetchLayer, HttpClient.HttpClient)

  const app = Actor.serve({ actors: [HttpRoom], auth }).pipe(
    Layer.provide(Layer.succeedContext(context)),
    Layer.provide(Layer.succeedContext(fetchLayer)),
  )

  const web = HttpRouter.toWebHandler(app, { disableLogger: true })

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => web.handler(request),
  })

  yield* Effect.addFinalizer(() =>
    Effect.promise(() => server.stop(true)).pipe(
      Effect.andThen(Effect.promise(() => web.dispose())),
    ),
  )

  const url = `http://127.0.0.1:${server.port}`

  return {
    url,
    send: sendTo(client, url),
    digest: (request) =>
      requestDigest({
        method: request.method,
        target: request.path,
        idempotencyKey: request.key,
        body: utf8.encode(request.body),
      }),
    mint: Effect.gen(function* () {
      const now = yield* actors.databaseNow

      return `v1.${now}.${now + actors.retryWindowMs}.${yield* random.randomUUIDv4}`
    }).pipe(Effect.orDie),
  }
})

/** A runner's assertion provider trusting exactly `keys`. */
export const staticAuth = (keys: ReadonlyArray<EdgeKey>) =>
  Actor.auth.assertion({
    issuer: ISSUER,
    audience: DEPLOYMENT,
    region: REGION,
    keys: { keys: keys.map((key) => key.publicKey) },
  })

const unauthorizedBody = (code: Unauthorized["code"]) =>
  actorErrorBody(ActorError.make({ reason: Unauthorized.make({ code }) }))

/** A request to `HttpRoom/<id>/<member>` with a fresh command id. */
const command = Effect.fnUntraced(function* (
  server: AssertedServer,
  id: string,
  member: string,
  body = "",
) {
  return {
    method: "POST",
    path: `/actors/HttpRoom/${id}/${member}`,
    key: yield* server.mint,
    body,
    headers: {},
  } satisfies Sent
})

/** A query request, which carries no command id. */
const query = (id: string, member: string): Sent => ({
  method: "POST",
  path: `/actors/HttpRoom/${id}/${member}`,
  key: undefined,
  body: "",
  headers: {},
})

/** An assertion for `tenant`'s alice bound to `request`, with `change` applied to its claims. */
const assertionFor = Effect.fnUntraced(function* (options: {
  readonly edge: EdgeKey
  readonly server: AssertedServer
  readonly request: Sent
  readonly tenant: string
  readonly change?: Change
}) {
  const req = yield* options.server.digest(options.request)
  const claims = yield* claimsFor({ tenant: options.tenant, subject: "alice", req })

  return yield* signAssertion(
    options.edge,
    options.change === undefined ? claims : options.change(claims),
  )
})

/** Sends `request` carrying `assertion`. */
const asserted = (server: AssertedServer, request: Sent, assertion: string) =>
  server.send({ ...request, headers: { ...request.headers, [ASSERTION_HEADER]: assertion } })

/** A key-set URL whose keys the case changes while the runner polls it. */
const keySetServer = Effect.fnUntraced(function* (initial: ReadonlyArray<EdgeKey>) {
  let keys = initial

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ keys: keys.map((key) => key.publicKey) }),
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))

  return {
    url: new URL(`http://127.0.0.1:${server.port}/keys`),
    publish: (next: ReadonlyArray<EdgeKey>) =>
      Effect.sync(() => {
        keys = next
      }),
  }
})

export const assertionsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "refuses forged, unknown-kid, wrong-algorithm, and none-algorithm assertions before admission",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const impostor = yield* edgeKey("edge-1")
          const stranger = yield* edgeKey("edge-9")
          const server = yield* serveAsserted(staticAuth([edge]))
          const tenant = yield* tenantOf
          const before = runs.count

          const unsecured = (claims: AssertionClaims) =>
            Effect.gen(function* () {
              const header = yield* segment({ alg: "none", typ: ASSERTION_TYPE, kid: "edge-1" })

              return `${header}.${yield* segment({ ...claims })}.`
            })

          const attempts = [
            (claims: AssertionClaims) => signAssertion(impostor, claims),
            (claims: AssertionClaims) => signAssertion(stranger, claims),
            (claims: AssertionClaims) => signAssertion(edge, claims, { alg: "ES256" }),
            (claims: AssertionClaims) => signAssertion(edge, claims, { typ: "JWT" }),
            unsecured,
          ]

          for (const attempt of attempts) {
            const request = yield* command(server, "forged", "Whoami")
            const req = yield* server.digest(request)
            const claims = yield* claimsFor({ tenant, subject: "alice", req })
            const reply = yield* asserted(server, request, yield* attempt(claims))

            expect(reply.status).toBe(401)
            expect(reply.body).toEqual(yield* unauthorizedBody("invalid_credentials"))
          }

          const missing = yield* server.send(yield* command(server, "forged", "Whoami"))

          expect(missing.status).toBe(401)
          expect(missing.body).toEqual(yield* unauthorizedBody("missing_credentials"))
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "forged")).toBe(0)

          const request = yield* command(server, "forged", "Whoami")
          const valid = yield* assertionFor({ edge, server, request, tenant })

          expect(yield* asserted(server, request, valid)).toMatchObject({
            status: 200,
            body: `${tenant}/alice`,
          })
        }),
      ),
  },
  {
    name: "refuses expired assertions, assertions issued in the future beyond skew, and assertions for another deployment or region",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const server = yield* serveAsserted(staticAuth([edge]))
          const tenant = yield* tenantOf
          const before = runs.count

          const refused: ReadonlyArray<readonly [Change, Unauthorized["code"]]> = [
            [(claims) => ({ ...claims, iat: claims.iat - 20, exp: claims.iat - 6 }), "expired"],
            [
              (claims) => ({ ...claims, iat: claims.iat + 10, exp: claims.iat + 20 }),
              "invalid_credentials",
            ],
            [(claims) => ({ ...claims, exp: claims.iat + 61 }), "invalid_credentials"],
            [(claims) => ({ ...claims, aud: "dep-other" }), "invalid_credentials"],
            [(claims) => ({ ...claims, region: "test-2" }), "invalid_credentials"],
            [(claims) => ({ ...claims, iss: "https://edge.other.test" }), "invalid_credentials"],
          ]

          for (const [change, code] of refused) {
            const request = yield* command(server, "lifetime", "Whoami")
            const assertion = yield* assertionFor({ edge, server, request, tenant, change })
            const reply = yield* asserted(server, request, assertion)

            expect(reply.status).toBe(401)
            expect(reply.body).toEqual(yield* unauthorizedBody(code))
          }

          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "lifetime")).toBe(0)

          const skewed: ReadonlyArray<Change> = [
            (claims) => ({ ...claims, iat: claims.iat - 10, exp: claims.iat - 1 }),
            (claims) => ({ ...claims, iat: claims.iat + 4, exp: claims.iat + 14 }),
          ]

          for (const change of skewed) {
            const request = yield* command(server, "lifetime", "Whoami")
            const assertion = yield* assertionFor({ edge, server, request, tenant, change })

            expect((yield* asserted(server, request, assertion)).status).toBe(200)
          }
        }),
      ),
  },
  {
    name: "refuses an assertion moved to another method, path, query, idempotency key, or body",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const server = yield* serveAsserted(staticAuth([edge]))
          const tenant = yield* tenantOf
          const before = runs.count
          const original = yield* command(server, "bound", "Post", '{"text":"hello"}')
          const signed = yield* assertionFor({ edge, server, request: original, tenant })

          const moved: ReadonlyArray<Sent> = [
            { ...original, path: "/actors/HttpRoom/other/Post" },
            { ...original, path: "/actors/HttpRoom/bound/Hold", body: "" },
            { ...original, path: `${original.path}?member=Hold` },
            { ...original, key: yield* server.mint },
            { ...original, body: '{"text":"goodbye"}' },
            { ...original, body: '{ "text":"hello"}' },
          ]

          for (const request of moved) {
            const reply = yield* asserted(server, request, signed)

            expect(reply.status).toBe(401)
            expect(reply.body).toEqual(yield* unauthorizedBody("invalid_credentials"))
          }

          const get = yield* assertionFor({
            edge,
            server,
            request: { ...original, method: "GET" },
            tenant,
          })

          expect((yield* asserted(server, original, get)).status).toBe(401)

          const count = query("bound", "Count")
          const countSigned = yield* assertionFor({ edge, server, request: count, tenant })

          expect((yield* asserted(server, count, countSigned)).status).toBe(200)
          expect((yield* asserted(server, query("other", "Count"), countSigned)).status).toBe(401)
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "bound")).toBe(0)
          expect(yield* receipts(tenant, "HttpRoom", "other")).toBe(0)
          expect(yield* asserted(server, original, signed)).toMatchObject({ status: 200, body: 1 })
        }),
      ),
  },
  {
    name: "takes the caller and tenant only from the assertion, whatever authorization the request carries",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const server = yield* serveAsserted(staticAuth([edge]))
          const tenant = yield* tenantOf

          const request = {
            ...(yield* command(server, "caller", "Whoami")),
            headers: { authorization: "Bearer other-tenant:mallory", cookie: "session=mallory" },
          }

          const assertion = yield* assertionFor({ edge, server, request, tenant })

          expect(yield* asserted(server, request, assertion)).toMatchObject({
            status: 200,
            body: `${tenant}/alice`,
          })

          const bare = yield* server.send({
            ...(yield* command(server, "caller", "Whoami")),
            headers: { authorization: `Bearer ${tenant}:alice` },
          })

          expect(bare.status).toBe(401)
          expect(bare.body).toEqual(yield* unauthorizedBody("missing_credentials"))
        }),
      ),
  },
  {
    name: "keeps admitted work running after its assertion expires, and replays its receipt to a newly authenticated retry",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const server = yield* serveAsserted(staticAuth([edge]))
          const tenant = yield* tenantOf
          const request = yield* command(server, "expiring", "Hold")

          const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 10
          const exp = iat + 9

          const late = yield* assertionFor({
            edge,
            server,
            request,
            tenant,
            change: (claims) => ({ ...claims, iat, exp }),
          })

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          gate.hold = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )

          const before = runs.count
          const call = yield* asserted(server, request, late).pipe(Effect.forkChild)

          const admitted = yield* Effect.raceFirst(
            Deferred.await(entered).pipe(Effect.as(undefined)),
            Fiber.join(call),
          )

          expect(admitted).toBe(undefined)

          while ((yield* Clock.currentTimeMillis) <= (exp + 5) * 1000 + 200)
            yield* Effect.sleep("100 millis")

          gate.hold = Effect.void
          yield* Deferred.succeed(release, undefined)

          expect(yield* Fiber.join(call)).toMatchObject({ status: 200, body: 1 })

          const stale = yield* asserted(server, request, late)

          expect(stale.status).toBe(401)
          expect(stale.body).toEqual(yield* unauthorizedBody("expired"))

          const fresh = yield* assertionFor({ edge, server, request, tenant })

          expect(yield* asserted(server, request, fresh)).toMatchObject({ status: 200, body: 1 })
          expect(runs.count).toBe(before + 1)
          expect(yield* receipts(tenant, "HttpRoom", "expiring")).toBe(1)
        }),
      ),
  },
  {
    name: "accepts a rotated key during overlap and refuses a revoked key within the polling bound",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const old = yield* edgeKey("edge-2026-08")
          const rotated = yield* edgeKey("edge-2026-09")
          const keySet = yield* keySetServer([old])

          const server = yield* serveAsserted(
            Actor.auth.assertion({
              issuer: ISSUER,
              audience: DEPLOYMENT,
              region: REGION,
              keys: keySet.url,
              refreshEvery: "1 second",
            }),
          )

          const tenant = yield* tenantOf

          const status = Effect.fnUntraced(function* (key: EdgeKey) {
            const request = yield* command(server, "rotation", "Whoami")
            const assertion = yield* assertionFor({ edge: key, server, request, tenant })

            return (yield* asserted(server, request, assertion)).status
          })

          expect(yield* status(old)).toBe(200)

          yield* keySet.publish([old, rotated])
          yield* Effect.sleep("1200 millis")

          expect(yield* status(rotated)).toBe(200)
          expect(yield* status(old)).toBe(200)

          yield* keySet.publish([rotated])
          yield* Effect.sleep("1200 millis")

          expect(yield* status(old)).toBe(401)
          expect(yield* status(rotated)).toBe(200)
        }),
      ),
  },
  {
    name: "rereads its key set at once on the edge's authenticated refresh push, and refuses any other push",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const old = yield* edgeKey("edge-2026-08")
          const rotated = yield* edgeKey("edge-2026-09")
          const stranger = yield* edgeKey("edge-9")
          const keySet = yield* keySetServer([old, rotated])

          const server = yield* serveAsserted(
            Actor.auth.assertion({
              issuer: ISSUER,
              audience: DEPLOYMENT,
              region: REGION,
              keys: keySet.url,
            }),
          )

          const tenant = yield* tenantOf

          const status = Effect.fnUntraced(function* (key: EdgeKey) {
            const request = yield* command(server, "pushed", "Whoami")
            const assertion = yield* assertionFor({ edge: key, server, request, tenant })

            return (yield* asserted(server, request, assertion)).status
          })

          const push = (token: string | undefined) =>
            server.send({
              method: "POST",
              path: KEY_REFRESH_PATH,
              key: undefined,
              body: "",
              headers: token === undefined ? {} : { [ASSERTION_HEADER]: token },
            })

          expect(yield* status(old)).toBe(200)

          yield* keySet.publish([rotated])

          expect(yield* status(old)).toBe(200)

          const refused = [
            yield* push(undefined),
            yield* push(yield* signRefresh(stranger)),
            yield* push(yield* signRefresh(rotated, "dep-other")),
            yield* push(
              yield* assertionFor({
                edge: rotated,
                server,
                request: yield* command(server, "pushed", "Whoami"),
                tenant,
              }),
            ),
          ]

          expect(refused.map((reply) => reply.status)).toEqual([401, 401, 401, 401])
          expect(yield* status(old)).toBe(200)

          expect((yield* push(yield* signRefresh(rotated))).status).toBe(204)
          expect(yield* status(old)).toBe(401)
          expect((yield* push(yield* signRefresh(rotated))).status).toBe(204)
          expect(yield* status(rotated)).toBe(200)
        }),
      ),
  },
  {
    name: "refuses a reauthentication assertion whose sid belongs to another session",
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* edgeKey("edge-1")
          const host = yield* serveSockets(environment, { auth: staticAuth([edge]) })
          const tenant = yield* tenantOf
          const path = "/api/actors/SocketRoom/asserted/Chat"
          const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)

          const upgrade = yield* requestDigest({
            method: "GET",
            target: path,
            idempotencyKey: undefined,
            body: new Uint8Array(0),
          })

          const bearer = (claims: AssertionClaims) =>
            signAssertion(edge, claims).pipe(Effect.map((jws) => `Bearer ${jws}`))

          const base = yield* claimsFor({ tenant, subject: "alice", req: upgrade })
          const opening = yield* bearer({ ...base, sid: "session-a", cexp: now + 3600 })
          const ws = yield* socket(host, "asserted")

          yield* ws.send({ t: "hello", authorization: opening, params: { name: "alice" } })

          expect((yield* opened(yield* ws.next())).reauthenticateBy).toBe((now + 3600) * 1000)

          const renewal = Effect.fnUntraced(function* (sid: string) {
            const req = yield* reauthenticationDigest({ path, session: sid })

            return yield* bearer({ ...base, req, sid, cexp: now + 7200 })
          })

          yield* ws.send({ t: "reauthenticate", authorization: yield* renewal("session-a") })

          expect((yield* ws.until("reauthenticated")).at(-1)).toEqual({
            t: "reauthenticated",
            by: (now + 7200) * 1000,
          })

          yield* ws.send({ t: "reauthenticate", authorization: yield* renewal("session-b") })

          expect(yield* endReason((yield* ws.until("end")).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect((yield* ws.closed).code).toBe(1008)

          const second = yield* socket(host, "asserted")
          const secondOpening = yield* bearer({ ...base, sid: "session-c" })

          yield* second.send({
            t: "hello",
            authorization: secondOpening,
            params: { name: "alice" },
          })
          yield* opened(yield* second.next())
          yield* second.send({ t: "reauthenticate", authorization: secondOpening })

          expect(yield* endReason((yield* second.until("end")).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
        }),
      ),
  },
]

/**
 * The edge half: the same served actors behind a real hosted edge, which a
 * backend supplies as `ConformanceEdge`. The framework can't import the edge,
 * so the edge's own tests run these cases with it.
 */

/** A runner the edge may forward to. */
export interface EdgeRunner {
  readonly region: string
  /** The runner's base URL, such as `http://127.0.0.1:4000`. */
  readonly url: string
  /** The runner's `Actor.serve` base path, where the edge pushes key-set refreshes. */
  readonly basePath?: string
}

/** One running edge in front of one deployment, with the control plane it reads. */
export interface HostedEdge {
  /** The edge's base URL; requests to it are for `deployment`. */
  readonly url: string
  readonly issuer: string
  readonly deployment: string
  /** The published key set runners verify the edge's assertions with. */
  readonly keys: URL
  readonly addRunner: (runner: EdgeRunner) => Effect.Effect<void>
  /** Issues a hosted API key for `tenant`'s `subject`. */
  readonly issueApiKey: (options: {
    readonly tenant: string
    readonly subject: string
  }) => Effect.Effect<string>
  readonly revokeApiKey: (key: string) => Effect.Effect<void>
  /** Revokes an edge signing key in the control plane, as an operator would. */
  readonly revokeSigningKey: (kid: string) => Effect.Effect<void>
  /** Writes a directory row as a tenant move would, which only L.1's operators can do. */
  readonly home: (options: {
    readonly tenant: string
    readonly region: string
  }) => Effect.Effect<void>
  /** Rows in the tenant directory. */
  readonly directoryRows: Effect.Effect<number>
}

export interface ConformanceEdge {
  /** Starts an edge for a new deployment whose primary region is `primaryRegion`. */
  readonly start: (options: {
    readonly primaryRegion: string
    /** How long each assertion lives; default 10 seconds. */
    readonly assertionSeconds?: number
    /** How long a session opened with an API key lasts before it must reauthenticate. */
    readonly apiKeySessionSeconds?: number
    /** The edge's signing keys; one new key when omitted. */
    readonly signingKeys?: ReadonlyArray<EdgeKey>
  }) => Effect.Effect<HostedEdge, never, Scope.Scope>
}

const edgeOf = (edge: ConformanceEdge | undefined) =>
  edge === undefined ? Effect.die(new Error("The case needs a hosted edge")) : Effect.succeed(edge)

/** Sends requests to the server at `url` for the rest of the scope. */
const clientFor = Effect.fnUntraced(function* (url: string) {
  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

  return sendTo(client, url)
})

/** A runner in `region` that trusts `edge`, rereading its key set every second. */
const edgeRunner = (edge: HostedEdge, region: string) =>
  serveAsserted(
    Actor.auth.assertion({
      issuer: edge.issuer,
      audience: edge.deployment,
      region,
      keys: edge.keys,
      refreshEvery: "1 second",
    }),
  )

const bearerHeaders = (key: string) => ({ authorization: `Bearer ${key}` })

/**
 * A proxy in front of a runner that holds each request for the delay its
 * path's actor id names, and counts the requests that reached it.
 */
const delayingProxy = Effect.fnUntraced(function* (target: string) {
  const delays = new Map<string, number>()
  const failures = new Map<string, number>()
  const arrived: Array<string> = []
  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
  const context = yield* Effect.context<never>()

  const hold = (request: Request) =>
    Effect.gen(function* () {
      const path = new URL(request.url).pathname
      const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))

      arrived.push(path)

      const failing = failures.get(path) ?? 0

      if (failing > 0) {
        failures.set(path, failing - 1)

        return new Response(null, { status: 503 })
      }

      yield* Effect.sleep(delays.get(path.split("/")[3] ?? "") ?? 0)

      const forwarded = HttpClientRequest.make(request.method === "GET" ? "GET" : "POST")(
        `${target}${path}`,
        { headers: Object.fromEntries(request.headers) },
      )

      const response = yield* client.execute(
        body.byteLength === 0
          ? forwarded
          : HttpClientRequest.bodyUint8Array(
              forwarded,
              body,
              request.headers.get("content-type") ?? undefined,
            ),
      )

      return new Response(yield* response.arrayBuffer, {
        status: response.status,
        headers: response.headers,
      })
    }).pipe(Effect.orDie)

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => Effect.runPromiseWith(context)(hold(request)),
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))

  return {
    url: `http://127.0.0.1:${server.port}`,
    delay: (id: string, ms: number) => Effect.sync(() => delays.set(id, ms)),
    /** Answers the next `times` requests for `path` with 503. */
    fail: (path: string, times: number) => Effect.sync(() => failures.set(path, times)),
    arrived: Effect.sync(() => arrived.length),
  }
})

/** Edge cases: the edge strips client-supplied assertions, signs the caller it authenticated, honors key rotation and revocation bounds, and routes across runners and regions. */
export const edgeConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "strips a client-supplied durable-assertion and takes the caller only from the assertion",
    requiresEdge: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({ primaryRegion: REGION })
          const runner = yield* edgeRunner(edge, REGION)
          const send = yield* clientFor(edge.url)
          const tenant = yield* tenantOf
          const key = yield* edge.issueApiKey({ tenant, subject: "alice" })

          yield* edge.addRunner({ region: REGION, url: runner.url })

          const forger = yield* edgeKey("edge-1")
          const request = yield* command(runner, "stripped", "Whoami")

          const forged = yield* assertionFor({
            edge: forger,
            server: runner,
            request,
            tenant: "mallory",
          })

          const reply = yield* send({
            ...request,
            headers: { ...bearerHeaders(key), [ASSERTION_HEADER]: forged },
          })

          expect(reply).toMatchObject({ status: 200, body: `${tenant}/alice` })

          const bare = yield* send({
            ...(yield* command(runner, "stripped", "Whoami")),
            headers: { [ASSERTION_HEADER]: forged },
          })

          expect(bare.status).toBe(401)
          expect(bare.body).toEqual(yield* unauthorizedBody("missing_credentials"))
        }),
      ),
  },
  {
    name: "refuses new requests from a revoked caller at the edge, and admits in-flight ones only within the assertion lifetime",
    requiresEdge: true,
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({
            primaryRegion: REGION,
            assertionSeconds: 1,
          })

          const runner = yield* edgeRunner(edge, REGION)
          const proxy = yield* delayingProxy(runner.url)
          const send = yield* clientFor(edge.url)
          const tenant = yield* tenantOf
          const key = yield* edge.issueApiKey({ tenant, subject: "alice" })

          yield* edge.addRunner({ region: REGION, url: proxy.url })
          yield* proxy.delay("held-long", 7_000)
          yield* proxy.delay("held-short", 300)

          const long = yield* command(runner, "held-long", "Whoami")
          const short = yield* command(runner, "held-short", "Whoami")
          const late = yield* send({ ...long, headers: bearerHeaders(key) }).pipe(Effect.forkChild)

          const inTime = yield* send({ ...short, headers: bearerHeaders(key) }).pipe(
            Effect.forkChild,
          )

          while ((yield* proxy.arrived) < 2) yield* Effect.sleep("20 millis")

          yield* edge.revokeApiKey(key)

          const refused = yield* send({
            ...(yield* command(runner, "after", "Whoami")),
            headers: bearerHeaders(key),
          })

          expect(refused.status).toBe(401)
          expect(refused.body).toEqual(yield* unauthorizedBody("invalid_credentials"))
          expect(yield* proxy.arrived).toBe(2)
          expect(yield* Fiber.join(inTime)).toMatchObject({ status: 200, body: `${tenant}/alice` })

          const expired = yield* Fiber.join(late)

          expect(expired.status).toBe(401)
          expect(expired.body).toEqual(yield* unauthorizedBody("expired"))
          expect(yield* receipts(tenant, "HttpRoom", "held-long")).toBe(0)
          expect(yield* receipts(tenant, "HttpRoom", "after")).toBe(0)
        }),
      ),
  },
  {
    name: "reauthenticates a WebSocket session through the edge and closes it at the revocation bound",
    requiresEdge: true,
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({
            primaryRegion: REGION,
            apiKeySessionSeconds: 4,
          })

          const host = yield* serveSockets(environment, {
            auth: Actor.auth.assertion({
              issuer: edge.issuer,
              audience: edge.deployment,
              region: REGION,
              keys: edge.keys,
              refreshEvery: "1 second",
            }),
          })

          yield* edge.addRunner({ region: REGION, url: `http://${host}`, basePath: "/api/" })
          yield* edge.addRunner({ region: REGION, url: "http://127.0.0.1:9", basePath: "/api" })

          const tenant = yield* tenantOf
          const key = yield* edge.issueApiKey({ tenant, subject: "alice" })

          const probe = yield* socket(new URL(edge.url).host, "through-edge")

          yield* probe.send({
            t: "hello",
            authorization: `Bearer ${key}`,
            params: { name: "alice" },
          })
          yield* opened(yield* probe.next())
          yield* probe.close

          const ws = yield* socket(new URL(edge.url).host, "through-edge")

          yield* ws.send({ t: "hello", authorization: `Bearer ${key}`, params: { name: "alice" } })

          const open = yield* opened(yield* ws.next())
          const started = yield* Clock.currentTimeMillis

          const by = open.reauthenticateBy ?? 0

          expect(by > started + 2_000 && by <= started + 4_000).toBe(true)

          const asked = (yield* ws.until("reauthenticate", 10_000)).at(-1)

          expect(asked?.t).toBe("reauthenticate")

          yield* Effect.sleep("1100 millis")
          yield* ws.send({ t: "reauthenticate", authorization: `Bearer ${key}` })

          const renewed = (yield* ws.until("reauthenticated", 10_000)).at(-1)

          expect(
            renewed?.t === "reauthenticated" && (renewed.by ?? 0) > (open.reauthenticateBy ?? 0),
          ).toBe(true)

          yield* edge.revokeApiKey(key)
          yield* ws.until("reauthenticate", 10_000)
          yield* ws.send({ t: "reauthenticate", authorization: `Bearer ${key}` })

          expect(yield* endReason((yield* ws.until("end", 10_000)).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect((yield* ws.closed).code).toBe(1008)
          expect((yield* Clock.currentTimeMillis) - started < 10_000).toBe(true)
        }),
      ),
  },
  {
    name: "pushes a signing-key revocation to runners, which refuse the key well before their polling bound",
    requiresEdge: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const old = yield* edgeKey("edge-2026-08")
          const rotated = yield* edgeKey("edge-2026-09")

          const edge = yield* (yield* edgeOf(environment.edge)).start({
            primaryRegion: REGION,
            signingKeys: [old, rotated],
          })

          const runner = yield* serveAsserted(
            Actor.auth.assertion({
              issuer: edge.issuer,
              audience: edge.deployment,
              region: REGION,
              keys: edge.keys,
            }),
          )

          const door = yield* delayingProxy(runner.url)

          yield* door.fail(KEY_REFRESH_PATH, 1)
          yield* edge.addRunner({ region: REGION, url: door.url, basePath: "/" })

          const send = yield* clientFor(edge.url)
          const tenant = yield* tenantOf
          const apiKey = yield* edge.issueApiKey({ tenant, subject: "alice" })

          const direct = Effect.fnUntraced(function* (key: EdgeKey) {
            const request = yield* command(runner, "revoked-key", "Whoami")

            const claims = yield* claimsFor({
              tenant,
              subject: "alice",
              req: yield* runner.digest(request),
            })

            const assertion = yield* signAssertion(key, {
              ...claims,
              iss: edge.issuer,
              aud: edge.deployment,
            })

            return (yield* asserted(runner, request, assertion)).status
          })

          expect(yield* direct(old)).toBe(200)

          const started = yield* Clock.currentTimeMillis

          yield* edge.revokeSigningKey(old.kid)

          const refused = yield* direct(old).pipe(
            Effect.repeat({
              until: (status) => status === 401,
              schedule: Schedule.spaced("100 millis"),
              times: 100,
            }),
          )

          const elapsed = (yield* Clock.currentTimeMillis) - started

          expect(refused).toBe(401)
          expect(elapsed < 10_000).toBe(true)
          expect(yield* direct(rotated)).toBe(200)

          const through = yield* send({
            ...(yield* command(runner, "revoked-key", "Whoami")),
            headers: bearerHeaders(apiKey),
          })

          expect(through).toMatchObject({ status: 200, body: `${tenant}/alice` })
        }),
      ),
  },
  {
    name: "fails a WebSocket over to the next runner with an assertion signed after it accepts",
    requiresEdge: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({
            primaryRegion: REGION,
            assertionSeconds: 2,
          })

          const host = yield* serveSockets(environment, {
            auth: Actor.auth.assertion({
              issuer: edge.issuer,
              audience: edge.deployment,
              region: REGION,
              keys: edge.keys,
              refreshEvery: "1 second",
            }),
          })

          const hole = Bun.listen({
            hostname: "127.0.0.1",
            port: 0,
            socket: { data: () => undefined },
          })

          yield* Effect.addFinalizer(() => Effect.sync(() => hole.stop(true)))
          yield* edge.addRunner({ region: REGION, url: `http://${host}`, basePath: "/api" })
          yield* edge.addRunner({ region: REGION, url: `http://127.0.0.1:${hole.port}` })

          const tenant = yield* tenantOf
          const key = yield* edge.issueApiKey({ tenant, subject: "alice" })

          for (let index = 0; index < 2; index++) {
            const ws = yield* socket(new URL(edge.url).host, "fail-over")

            yield* ws.send({
              t: "hello",
              authorization: `Bearer ${key}`,
              params: { name: "alice" },
            })

            expect((yield* ws.next(10_000)).t).toBe("open")
            yield* ws.close
          }
        }),
      ),
  },
  {
    name: "routes a tenant with no directory row to the primary region and never writes a row",
    requiresEdge: true,
    timeoutMs: 30_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const edge = yield* (yield* edgeOf(environment.edge)).start({ primaryRegion: REGION })
          const other = "test-2"
          const primary = yield* edgeRunner(edge, REGION)
          const secondary = yield* edgeRunner(edge, other)
          const primaryDoor = yield* delayingProxy(primary.url)
          const secondaryDoor = yield* delayingProxy(secondary.url)
          const send = yield* clientFor(edge.url)

          yield* edge.addRunner({ region: REGION, url: primaryDoor.url })
          yield* edge.addRunner({ region: other, url: secondaryDoor.url })

          const homeless = yield* tenantOf
          const moved = yield* tenantOf
          const homelessKey = yield* edge.issueApiKey({ tenant: homeless, subject: "alice" })
          const movedKey = yield* edge.issueApiKey({ tenant: moved, subject: "alice" })

          yield* edge.home({ tenant: moved, region: other })

          const call = (key: string) =>
            Effect.flatMap(command(primary, "routed", "Whoami"), (request) =>
              send({ ...request, headers: bearerHeaders(key) }),
            )

          for (let index = 0; index < 3; index++)
            expect(yield* call(homelessKey)).toMatchObject({
              status: 200,
              body: `${homeless}/alice`,
            })

          expect(yield* primaryDoor.arrived).toBe(3)
          expect(yield* secondaryDoor.arrived).toBe(0)
          expect(yield* call(movedKey)).toMatchObject({ status: 200, body: `${moved}/alice` })
          expect(yield* secondaryDoor.arrived).toBe(1)
          expect(yield* edge.directoryRows).toBe(1)

          yield* edge.home({ tenant: homeless, region: other })

          const reached = yield* call(homelessKey).pipe(
            Effect.andThen(secondaryDoor.arrived),
            Effect.repeat({
              until: (arrived) => arrived > 1,
              schedule: Schedule.spaced("200 millis"),
              times: 100,
            }),
          )

          expect(reached).toBe(2)
        }),
      ),
  },
]
