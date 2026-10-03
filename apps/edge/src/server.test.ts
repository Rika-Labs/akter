import { publishedKeys } from "@akter/deployments"
import { migrate } from "@akter/postgres/migrate"
import {
  type ConformanceBackend,
  type ConformanceEdge,
  describeConformance,
  type EdgeKey,
  edgeKey,
  type HostedEdge,
} from "@rikalabs/akter/testing"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import {
  Config,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { Pool } from "pg"
import { SUBPROTOCOL } from "@rikalabs/akter"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { EdgeOptions } from "./config.ts"
import { makeEdge } from "./server.ts"

const harness = ManagedRuntime.make(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer))

afterAll(() => harness.dispose())

/** A new database on the test server, dropped with the scope. */
const createDatabase = Effect.fnUntraced(function* (prefix: string) {
  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `${prefix}_${(yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return base.href
})

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const sha256 = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map(hex),
  )

const encodeKeySet = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

/** A real edge for a new deployment, with its own control-plane database. */
const startEdge = Effect.fnUntraced(function* (options: {
  readonly primaryRegion: string
  readonly assertionSeconds?: number
  readonly apiKeySessionSeconds?: number
  readonly signingKeys?: ReadonlyArray<EdgeKey>
  readonly scaleToZero?: boolean
  readonly coldStartSeconds?: number
  readonly trustedProxies?: EdgeOptions["trustedProxies"]
}): Effect.fn.Return<
  HostedEdge & { readonly sql: SqlClient.SqlClient },
  never,
  Scope.Scope | Crypto.Crypto
> {
  const url = yield* createDatabase("edge").pipe(Effect.orDie)

  yield* Effect.promise(() => migrate(url))

  const control = yield* Layer.build(
    Layer.mergeAll(
      PgClient.layer({ url: Redacted.make(url), maxConnections: 5 }),
      FetchHttpClient.layer,
      BunCrypto.layer,
    ),
  ).pipe(Effect.orDie)

  const sql = Context.get(control, SqlClient.SqlClient)
  const random = yield* Crypto.Crypto
  const deployment = `dep-${(yield* random.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`

  yield* sql`INSERT INTO deployment (id, primary_region, scale_to_zero) VALUES (${deployment}, ${options.primaryRegion}, ${options.scaleToZero ?? false})`.pipe(
    Effect.orDie,
  )
  yield* sql`INSERT INTO deployment_host (host, deployment_id) VALUES ('127.0.0.1', ${deployment})`.pipe(
    Effect.orDie,
  )

  const keys = options.signingKeys ?? [yield* edgeKey("edge-test-1")]

  const signingKeys = yield* Effect.forEach(keys, (key) =>
    Effect.promise(() => crypto.subtle.exportKey("jwk", key.privateKey)).pipe(
      Effect.map((jwk) => ({ kid: key.kid, x: jwk.x ?? "", d: jwk.d ?? "" })),
    ),
  )

  const edgeOptions: EdgeOptions = {
    issuer: "https://edge.durable.test",
    controlPlaneUrl: Redacted.make(url),
    signingKeys,
    hostname: "127.0.0.1",
    port: 0,
    assertionLifetime: Duration.seconds(options.assertionSeconds ?? 10),
    apiKeySession: Duration.seconds(options.apiKeySessionSeconds ?? 300),
    pollEvery: Duration.millis(200),
    publicationLead: Duration.zero,
    requestBytes: 1024 * 1024,
    socketMessageBytes: 64 * 1024,
    socketBufferBytes: 1024 * 1024,
    coldStartTimeout: Duration.seconds(options.coldStartSeconds ?? 30),
    trustedProxies: options.trustedProxies ?? { nlbOnly: false, cloudflare: [] },
  }

  const edge = yield* makeEdge(edgeOptions).pipe(Effect.provideContext(control))

  const keySet = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Effect.runPromiseWith(control)(
        publishedKeys.pipe(
          Effect.flatMap(encodeKeySet),
          Effect.map(
            (body) => new Response(body, { headers: { "content-type": "application/json" } }),
          ),
          Effect.orDie,
        ),
      ),
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => keySet.stop(true)))

  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    effect.pipe(Effect.provideContext(control), Effect.orDie, Effect.asVoid)

  return {
    sql,
    url: edge.url,
    issuer: edgeOptions.issuer,
    deployment,
    keys: new URL(`http://127.0.0.1:${keySet.port}/keys`),
    addRunner: (runner) =>
      run(
        sql`INSERT INTO deployment_runner (deployment_id, region, url, base_path) VALUES (${deployment}, ${runner.region}, ${runner.url}, ${runner.basePath ?? ""})`,
      ),
    removeRunner: (url) =>
      run(sql`DELETE FROM deployment_runner WHERE deployment_id = ${deployment} AND url = ${url}`),
    takeWakes: sql<{
      readonly region: string
    }>`DELETE FROM runner_wake WHERE deployment_id = ${deployment} RETURNING region`.pipe(
      Effect.map((rows) => rows.map(({ region }) => region)),
      Effect.provideContext(control),
      Effect.orDie,
    ),
    issueApiKey: ({ tenant, subject }) =>
      Effect.gen(function* () {
        const key = `dak_${(yield* random.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "")}`

        yield* run(
          sql`INSERT INTO hosted_api_key (key_hash, deployment_id, tenant, subject) VALUES (${yield* sha256(key)}, ${deployment}, ${tenant}, ${subject})`,
        )

        return key
      }),
    revokeApiKey: (key) =>
      Effect.flatMap(sha256(key), (hash) =>
        run(sql`UPDATE hosted_api_key SET revoked_at = now() WHERE key_hash = ${hash}`),
      ),
    revokeSigningKey: (kid) => run(sql`UPDATE edge_key SET revoked_at = now() WHERE kid = ${kid}`),
    home: ({ tenant, region }) =>
      run(sql`
        INSERT INTO tenant_directory (routing_key, tenant_id, actor_id, deployment_id, tenant, region, state)
        VALUES (0, 'default', ${`${deployment}/${tenant}`}, ${deployment}, ${tenant}, ${region}, 'active')
        ON CONFLICT (deployment_id, tenant) DO UPDATE SET region = excluded.region
      `),
    directoryRows: sql<{
      readonly n: number
    }>`SELECT count(*)::int AS n FROM tenant_directory`.pipe(
      Effect.map(([row]) => row?.n ?? 0),
      Effect.provideContext(control),
      Effect.orDie,
    ),
  }
})

const edge: ConformanceEdge = {
  start: (options) =>
    Effect.gen(function* () {
      const crypto = Context.get(yield* Layer.build(BunCrypto.layer), Crypto.Crypto)

      return yield* startEdge(options).pipe(Effect.provideService(Crypto.Crypto, crypto))
    }),
}

const backend: ConformanceBackend = {
  independentConnections: true,
  freshDatabases: true,
  services: BunCrypto.layer,
  httpServer: Layer.orDie(BunHttpServer.layerServer({ hostname: "127.0.0.1", port: 0 })),
  edge,
  open: () =>
    harness.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const crypto = yield* Crypto.Crypto

        const provision = (prefix: string) =>
          createDatabase(prefix).pipe(
            Scope.provide(scope),
            Effect.orDie,
            Effect.map(Redacted.make),
            Effect.provideService(Crypto.Crypto, crypto),
          )

        return {
          database: yield* provision("runners"),
          freshDatabase: provision("isolated"),
          copy: (database) =>
            Effect.gen(function* () {
              if (!Redacted.isRedacted(database))
                return yield* Effect.die(
                  new Error("The edge backend copies only Postgres databases"),
                )
              const source = new URL(Redacted.value(database)).pathname.slice(1)
              const base = new URL(Redacted.value(database))
              const name = `restored_${(yield* crypto.randomUUIDv4).replaceAll("-", "")}`

              const admin = yield* Effect.acquireRelease(
                Effect.sync(() => new Pool({ connectionString: base.href })),
                (pool) => Effect.promise(() => pool.end()),
              )

              yield* Effect.acquireRelease(
                Effect.tryPromise(() =>
                  admin.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`),
                ).pipe(Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") })),
                () =>
                  Effect.promise(() =>
                    admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
                  ),
              )
              base.pathname = `/${name}`

              return Redacted.make(base.href)
            }).pipe(Scope.provide(scope), Effect.orDie),
          close: Scope.close(scope, Exit.void),
        }
      }),
    ),
}

describeConformance({
  name: "Hosted edge",
  backend,
  groups: ["edge", "coldServeEdge"],
  registrar: { describe, it, beforeAll, afterAll, expect, skip: (name) => it.skip(name) },
})

/** What a runner saw of one request or upgrade. */
interface Seen {
  readonly headers: Headers
}

/**
 * A runner that records the headers of every request and upgrade it gets, and
 * streams `/events` as two server-sent events, the second only after `release`.
 */
const startRunner = Effect.fnUntraced(function* () {
  const seen: Array<Seen> = []
  const gate = Deferred.makeUnsafe<void>()
  const text = new TextEncoder()

  const events = Stream.make(text.encode("id: 1\nevent: tick\ndata: first\n\n")).pipe(
    Stream.concat(
      Stream.fromEffect(Deferred.await(gate)).pipe(
        Stream.map(() => text.encode("id: 2\nevent: tick\ndata: second\n\n")),
      ),
    ),
  )

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, served) => {
      seen.push({ headers: request.headers })

      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        served.upgrade(request, { headers: { "sec-websocket-protocol": SUBPROTOCOL } })

        return undefined
      }

      if (new URL(request.url).pathname !== "/events") return new Response("ok")

      return new Response(Stream.toReadableStream(events), {
        headers: { "content-type": "text/event-stream" },
      })
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message)
      },
    },
  })

  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))

  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    release: () => Deferred.doneUnsafe(gate, Effect.void),
  }
})

const spoofed = {
  "cf-connecting-ip": "198.51.100.7",
  "x-forwarded-for": "203.0.113.9, 192.0.2.1",
  "x-forwarded-host": "evil.example",
  "x-forwarded-proto": "https",
  "x-real-ip": "203.0.113.10",
  "true-client-ip": "203.0.113.11",
  forwarded: "for=203.0.113.12;host=evil.example",
}

type Started = Effect.Success<ReturnType<typeof startEdge>>

/** A real edge with one recording runner, and a client that never follows or retries. */
const withEdge = (
  options: Parameters<typeof startEdge>[0],
  use: (context: {
    readonly edge: Started
    readonly runner: Effect.Success<ReturnType<typeof startRunner>>
    readonly send: (
      path: string,
      headers?: Record<string, string>,
    ) => Effect.Effect<number, never, never>
  }) => Effect.Effect<void, never, Scope.Scope | Crypto.Crypto | HttpClient.HttpClient>,
) =>
  harness.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const edge = yield* startEdge(options)
        const runner = yield* startRunner()
        const client = yield* HttpClient.HttpClient

        yield* edge.addRunner({ region: options.primaryRegion, url: runner.url })

        const send = (path: string, headers: Record<string, string> = {}) =>
          client
            .execute(
              HttpClientRequest.post(`${edge.url}${path}`).pipe(
                HttpClientRequest.setHeaders(headers),
                HttpClientRequest.bodyText("{}", "application/json"),
              ),
            )
            .pipe(
              Effect.flatMap((response) => Effect.as(response.text, response.status)),
              Effect.orDie,
            )

        yield* use({ edge, runner, send })
      }),
    ),
  )

const lastRequest = (runner: { readonly seen: ReadonlyArray<Seen> }) => runner.seen.at(-1)!.headers

describe("Hosted edge client address", () => {
  it("ignores spoofed forwarding headers from a peer outside the trusted lists and tells the runner the peer's address", () =>
    withEdge(
      {
        primaryRegion: "r1",
        trustedProxies: { nlbOnly: true, cloudflare: ["173.245.48.0/20"] },
      },
      ({ edge, runner, send }) =>
        Effect.gen(function* () {
          const key = yield* edge.issueApiKey({ tenant: "t1", subject: "u1" })

          yield* send("/actors/Counter/c1/Inc", {
            ...spoofed,
            authorization: `Bearer ${key}`,
            "idempotency-key": "k1",
          })

          const headers = lastRequest(runner)

          expect(headers.get("x-forwarded-for")).toBe("127.0.0.1")
          expect(headers.get("x-forwarded-host")).toBe("127.0.0.1")
          for (const name of [
            "cf-connecting-ip",
            "x-forwarded-proto",
            "x-real-ip",
            "true-client-ip",
            "forwarded",
            "authorization",
          ])
            expect(headers.has(name)).toBe(false)
          expect(headers.has("durable-assertion")).toBe(true)
        }),
    ))

  it("believes CF-Connecting-IP only behind the NLB-only gate from a Cloudflare peer, and only when it is an address", () =>
    withEdge(
      { primaryRegion: "r1", trustedProxies: { nlbOnly: true, cloudflare: ["127.0.0.1/32"] } },
      ({ runner, send }) =>
        Effect.gen(function* () {
          yield* send("/ping", spoofed)
          expect(lastRequest(runner).get("x-forwarded-for")).toBe("198.51.100.7")
          expect(lastRequest(runner).has("cf-connecting-ip")).toBe(false)

          yield* send("/ping", { ...spoofed, "cf-connecting-ip": "2001:DB8::1" })
          expect(lastRequest(runner).get("x-forwarded-for")).toBe("2001:db8::1")

          yield* send("/ping", { ...spoofed, "cf-connecting-ip": "198.51.100.7, 1.1.1.1" })
          expect(lastRequest(runner).get("x-forwarded-for")).toBe("127.0.0.1")
        }),
    ))

  it.each([
    { nlbOnly: false, cloudflare: ["127.0.0.1/32"] },
    { nlbOnly: true, cloudflare: ["10.0.0.0/8"] },
    { nlbOnly: true, cloudflare: [] },
  ])(
    "ignores CF-Connecting-IP without the gate, from a peer outside Cloudflare's ranges, or with no ranges %#",
    (trustedProxies) =>
      withEdge({ primaryRegion: "r1", trustedProxies }, ({ runner, send }) =>
        Effect.gen(function* () {
          yield* send("/ping", spoofed)
          expect(lastRequest(runner).get("x-forwarded-for")).toBe("127.0.0.1")
        }),
      ),
  )

  it("streams server-sent events through the edge as they are produced", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.get(`${edge.url}/events`).pipe(Effect.orDie)
        const decoder = new TextDecoder()
        const received: Array<string> = []

        expect(response.headers["content-type"]).toBe("text/event-stream")

        yield* response.stream.pipe(
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              received.push(decoder.decode(chunk))

              if (received.join("").includes("data: first")) runner.release()
            }),
          ),
          Effect.orDie,
        )

        expect(received.join("")).toContain("data: second")
      }),
    ))

  it("opens the upstream WebSocket with the edge's own forwarding headers and relays messages both ways", () =>
    withEdge(
      { primaryRegion: "r1", trustedProxies: { nlbOnly: true, cloudflare: ["10.0.0.0/8"] } },
      ({ edge, runner }) =>
        Effect.gen(function* () {
          const echoed = Deferred.makeUnsafe<string>()

          const socket: WebSocket = Reflect.construct(WebSocket, [
            `${edge.url.replace(/^http/, "ws")}/actors/A/1/Room`,
            { protocols: [SUBPROTOCOL], headers: spoofed },
          ])

          socket.onopen = () => socket.send("not-a-hello")
          socket.onmessage = (event) =>
            Deferred.doneUnsafe(echoed, Effect.succeed(String(event.data)))

          const message = yield* Deferred.await(echoed).pipe(
            Effect.timeout("5 seconds"),
            Effect.orDie,
          )

          socket.close()

          const upgrade = runner.seen.find(({ headers }) => headers.has("upgrade"))!.headers

          expect(message).toBe("not-a-hello")
          expect(upgrade.get("x-forwarded-for")).toBe("127.0.0.1")
          expect(upgrade.get("x-forwarded-host")).toBe("127.0.0.1")
          expect(upgrade.has("cf-connecting-ip")).toBe(false)
        }),
    ))

  it("commits deployment activity before forwarding an authenticated request, and for nothing else", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner, send }) =>
      Effect.gen(function* () {
        const { sql } = edge

        const recent = sql<{ readonly recent: boolean }>`
          SELECT last_activity_at > now() - interval '1 minute' AS recent FROM deployment WHERE id = ${edge.deployment}
        `.pipe(
          Effect.map(([row]) => row?.recent),
          Effect.orDie,
        )

        yield* sql`UPDATE deployment SET last_activity_at = now() - interval '1 hour' WHERE id = ${edge.deployment}`.pipe(
          Effect.orDie,
        )

        yield* send("/ping")
        expect(yield* recent).toBe(false)

        const key = yield* edge.issueApiKey({ tenant: "t1", subject: "u1" })

        expect(yield* send("/ping", { authorization: `Bearer ${key}` })).toBe(200)
        expect(yield* recent).toBe(true)
        expect(runner.seen).toHaveLength(2)
      }),
    ))

  it("refuses an authenticated request when its activity cannot be recorded, instead of forwarding it", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner, send }) =>
      Effect.gen(function* () {
        yield* edge.sql`ALTER TABLE deployment DROP COLUMN last_activity_at`.pipe(Effect.orDie)

        const key = yield* edge.issueApiKey({ tenant: "t1", subject: "u1" })

        expect(yield* send("/ping", { authorization: `Bearer ${key}` })).toBe(503)
        expect(runner.seen).toHaveLength(0)
        expect(yield* send("/ping")).toBe(200)
      }),
    ))
})
