import {
  type ConformanceBackend,
  type ConformanceEdge,
  describeConformance,
} from "@rikalabs/akter/testing"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import {
  Context,
  Crypto,
  Deferred,
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
import { createDatabase, startEdge } from "./fixtures.ts"

const harness = ManagedRuntime.make(Layer.mergeAll(BunCrypto.layer, FetchHttpClient.layer))

afterAll(() => harness.dispose())

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
  "x-forwarded-port": "8443",
  "x-client-ip": "203.0.113.13",
  "cf-connecting-ipv6": "2001:db8::13",
}

/** A session's `end` frame, decoding only when its reason is `ActorUnavailable`. */
const unavailableEnd = Schema.fromJsonString(
  Schema.Struct({
    t: Schema.Literal("end"),
    error: Schema.Struct({ reason: Schema.TaggedStruct("ActorUnavailable", {}) }),
  }),
)

/** The client-supplied attribution headers a runner must never receive. */
const attributionNames = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "forwarded",
]

/**
 * Opens a client WebSocket through the edge and sends one frame once open,
 * recording the first message it receives and the close code it ends with.
 */
const openSession = (url: string, headers: Record<string, string> = {}) => {
  const first = Deferred.makeUnsafe<string>()
  const closed = Deferred.makeUnsafe<number>()
  const socket: WebSocket = Reflect.construct(WebSocket, [
    `${url.replace(/^http/, "ws")}/actors/A/1/Room`,
    { protocols: [SUBPROTOCOL], headers },
  ])

  socket.onopen = () => socket.send("not-a-hello")
  socket.onmessage = (event) => Deferred.doneUnsafe(first, Effect.succeed(String(event.data)))
  socket.onclose = (event) => Deferred.doneUnsafe(closed, Effect.succeed(event.code))

  return {
    socket,
    first: Deferred.await(first).pipe(Effect.timeout("5 seconds"), Effect.orDie),
    closed: Deferred.await(closed).pipe(Effect.timeout("5 seconds"), Effect.orDie),
  }
}

/** Marks the deployment idle for an hour, and reads whether activity was recorded since. */
const activityOf = (edge: { readonly sql: SqlClient.SqlClient; readonly deployment: string }) => ({
  idle: edge.sql`UPDATE deployment SET last_activity_at = now() - interval '1 hour' WHERE id = ${edge.deployment}`.pipe(
    Effect.asVoid,
    Effect.orDie,
  ),
  recent: edge.sql<{ readonly recent: boolean }>`
    SELECT last_activity_at > now() - interval '1 minute' AS recent FROM deployment WHERE id = ${edge.deployment}
  `.pipe(
    Effect.map(([row]) => row?.recent),
    Effect.orDie,
  ),
})

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
          for (const name of [...attributionNames, "authorization"])
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
          const session = openSession(edge.url, spoofed)
          const message = yield* session.first

          session.socket.close()

          const upgrade = runner.seen.find(({ headers }) => headers.has("upgrade"))!.headers

          expect(message).toBe("not-a-hello")
          expect(upgrade.get("x-forwarded-for")).toBe("127.0.0.1")
          expect(upgrade.get("x-forwarded-host")).toBe("127.0.0.1")
          for (const name of attributionNames) expect(upgrade.has(name)).toBe(false)
        }),
    ))

  it("commits deployment activity before forwarding public and authenticated requests, and not for a rejected credential", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner, send }) =>
      Effect.gen(function* () {
        const activity = activityOf(edge)

        yield* activity.idle
        expect(yield* send("/command-ids", { authorization: "Bearer not-a-key" })).toBe(401)
        expect(yield* activity.recent).toBe(false)
        expect(runner.seen).toHaveLength(0)

        expect(yield* send("/command-ids")).toBe(200)
        expect(yield* activity.recent).toBe(true)

        yield* activity.idle
        const key = yield* edge.issueApiKey({ tenant: "t1", subject: "u1" })

        expect(yield* send("/command-ids", { authorization: `Bearer ${key}` })).toBe(200)
        expect(yield* activity.recent).toBe(true)
        expect(runner.seen).toHaveLength(2)
      }),
    ))

  it("commits deployment activity for a public socket session before opening its upstream", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner }) =>
      Effect.gen(function* () {
        const activity = activityOf(edge)

        yield* activity.idle

        const session = openSession(edge.url)

        expect(yield* session.first).toBe("not-a-hello")
        session.socket.close()
        expect(yield* activity.recent).toBe(true)
        expect(runner.seen.filter(({ headers }) => headers.has("upgrade"))).toHaveLength(1)
      }),
    ))

  it("refuses public and authenticated requests and socket sessions when activity cannot be recorded, instead of forwarding them", () =>
    withEdge({ primaryRegion: "r1" }, ({ edge, runner, send }) =>
      Effect.gen(function* () {
        yield* edge.sql`ALTER TABLE deployment DROP COLUMN last_activity_at`.pipe(Effect.orDie)

        const key = yield* edge.issueApiKey({ tenant: "t1", subject: "u1" })

        expect(yield* send("/ping", { authorization: `Bearer ${key}` })).toBe(503)
        expect(yield* send("/ping")).toBe(503)

        const session = openSession(edge.url)
        const ended = yield* Schema.decodeEffect(unavailableEnd)(yield* session.first).pipe(
          Effect.orDie,
        )

        expect(ended.error.reason._tag).toBe("ActorUnavailable")
        expect(yield* session.closed).toBe(1013)
        expect(runner.seen).toHaveLength(0)
      }),
    ))
})
