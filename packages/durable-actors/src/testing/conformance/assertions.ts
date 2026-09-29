import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Layer,
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
  readonly send: (request: Sent) => Effect.Effect<Reply>
  /** The `req` claim for `request` as the runner will receive it. */
  readonly digest: (request: Sent) => Effect.Effect<string>
  /** A v1 command id issued now. */
  readonly mint: Effect.Effect<string>
}

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

  const build = (request: Sent) => {
    const base = HttpClientRequest.make(request.method)(
      `http://127.0.0.1:${server.port}${request.path}`,
      { headers: request.headers },
    )

    const keyed =
      request.key === undefined
        ? base
        : HttpClientRequest.setHeader(base, "idempotency-key", request.key)

    return request.body === ""
      ? keyed
      : HttpClientRequest.bodyText(keyed, request.body, "application/json")
  }

  return {
    send: (request) =>
      Effect.gen(function* () {
        const response = yield* client.execute(build(request))
        const text = yield* response.text

        return {
          status: response.status,
          body: text === "" ? undefined : yield* decodeJson(text),
        }
      }).pipe(Effect.orDie),
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

const staticAuth = (keys: ReadonlyArray<EdgeKey>) =>
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

          // An unsecured JWS: `alg: none` and an empty signature.
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

          // The same request signed by the published key is admitted.
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

          // Within the 5-second skew, an assertion just past its expiry or just ahead of its issue is admitted.
          const skewed: ReadonlyArray<Change> = [
            (claims) => ({ ...claims, iat: claims.iat - 10, exp: claims.iat - 4 }),
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

          // The edge signed a GET; the runner received a POST.
          const get = yield* assertionFor({
            edge,
            server,
            request: { ...original, method: "GET" },
            tenant,
          })

          expect((yield* asserted(server, original, get)).status).toBe(401)

          // A query is bound too.
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

          // Without an assertion, a bearer token authenticates nothing.
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

          // Past its expiry by 4 seconds, which the 5-second skew still admits.
          const late = yield* assertionFor({
            edge,
            server,
            request,
            tenant,
            change: (claims) => ({ ...claims, iat: claims.iat - 10, exp: claims.iat - 4 }),
          })

          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()

          gate.hold = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )

          const before = runs.count
          const call = yield* asserted(server, request, late).pipe(Effect.forkChild)

          yield* Deferred.await(entered)
          // Now the assertion is past the skew as well.
          yield* Effect.sleep("1500 millis")
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

          // A new key is published at least one polling interval before the edge signs with it.
          yield* keySet.publish([old, rotated])
          yield* Effect.sleep("1200 millis")

          expect(yield* status(rotated)).toBe(200)
          expect(yield* status(old)).toBe(200)

          // Revoked: the runner refuses the key once it rereads the set, within one interval.
          yield* keySet.publish([rotated])
          yield* Effect.sleep("1200 millis")

          expect(yield* status(old)).toBe(401)
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

          // Another session's renewal, correctly bound to that session, is refused.
          yield* ws.send({ t: "reauthenticate", authorization: yield* renewal("session-b") })

          expect(yield* endReason((yield* ws.until("end")).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect((yield* ws.closed).code).toBe(1008)

          // An open assertion is not a renewal either, even for the same session.
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
