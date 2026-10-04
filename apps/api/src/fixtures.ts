import { expect } from "@effect/vitest"
import { BunCrypto, BunHttpServer } from "@effect/platform-bun"
import { Config, Crypto, Effect, Layer, Redacted, Schema } from "effect"
import {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  HttpRouter,
} from "effect/http"
import type { SqlClient } from "effect/sql"
import { Pool } from "pg"
import type { ApiOptions } from "./config.ts"
import { infrastructure, routes } from "./server.ts"

export const enterpriseOrganizations: Array<string> = []

export const baseOrigin = "http://localhost:3001"

export const password = "correct-horse-battery-staple-42"

export const options = (databaseUrl: Redacted.Redacted<string>): ApiOptions => ({
  enterpriseOrganizations,
  databaseUrl,
  secret: Redacted.make("api-integration-test-secret-not-for-production"),
  origin: baseOrigin,
  port: 0,
  production: false,
  emailMode: "local",
  emailFrom: "auth@localhost",
})

/** The real API infrastructure over the database at `TEST_DATABASE_URL`, with local email and local billing. */
export const TestLive = Layer.unwrap(
  Config.Redacted("TEST_DATABASE_URL").pipe(Effect.map(options), Effect.map(infrastructure)),
).pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(BunCrypto.layer))

/** A new database on the server at `TEST_DATABASE_URL`, dropped with the scope. */
export const createDatabase = (prefix: string) =>
  Effect.gen(function* () {
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
    return Redacted.make(base.href)
  })

/** The real API infrastructure over a database of its own, so a suite owns every row it asserts on. */
export const isolatedLive = (overrides: Partial<ApiOptions> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* createDatabase("api_isolated")
      return infrastructure({ ...options(url), ...overrides })
    }),
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BunCrypto.layer),
    Layer.orDie,
  )

interface RequestInput {
  readonly path: string
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly body?: Schema.Json
  readonly raw?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly cookie?: string
  readonly key?: string
  readonly origin?: string
}

/** The routes behind a real Bun HTTP server, handled with the context the infrastructure layer built. */
export const testServer = Effect.gen(function* () {
  const context = yield* Effect.context<Layer.Success<ReturnType<typeof infrastructure>>>()
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        routes.pipe(
          Layer.provide(Layer.succeedContext(context)),
          Layer.provide(BunHttpServer.layerHttpServices),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  )
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => web.handler(request, context),
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  )
  const origin = `http://127.0.0.1:${server.port}`
  const client = yield* HttpClient.HttpClient
  const request = Effect.fn(function* (input: RequestInput) {
    const requestHeaders = new Headers({
      "content-type": "application/json",
      origin: input.origin ?? baseOrigin,
      ...input.headers,
    })
    if (input.cookie !== undefined) requestHeaders.set("cookie", input.cookie)
    if (input.key !== undefined) requestHeaders.set("x-api-key", input.key)
    let httpRequest = HttpClientRequest.make(input.method ?? "GET")(`${origin}${input.path}`).pipe(
      HttpClientRequest.setHeaders(requestHeaders),
    )
    if (input.raw !== undefined)
      httpRequest = HttpClientRequest.bodyText(httpRequest, input.raw, "application/json")
    else if (input.body !== undefined)
      httpRequest = yield* HttpClientRequest.bodyJson(input.body)(httpRequest)
    return yield* client
      .execute(httpRequest)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
  })
  return { request, origin }
})

export type Requester = Effect.Success<typeof testServer>["request"]

export const read = Effect.fn("Fixture.read")(
  <A, I>(response: HttpClientResponse.HttpClientResponse, schema: Schema.Codec<A, I>) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.toCodecJson(schema))),
      Effect.orDie,
    ),
)

const BasicUser = Schema.Struct({
  user: Schema.Struct({ id: Schema.String, email: Schema.String, emailVerified: Schema.Boolean }),
})

/** Signs a user up, proves sign-in is refused until the emailed link is followed, and returns the verified session. */
export const signupWith = ({
  request,
  sql,
  suffix,
}: {
  readonly request: Requester
  readonly sql: SqlClient.SqlClient
  readonly suffix: string
}) =>
  Effect.fn(function* (name: string) {
    const email = `${name}-${suffix}@example.com`
    const response = yield* request({
      path: "/auth/sign-up/email",
      method: "POST",
      body: { name, email, password },
    })
    expect(response.status).toBe(200)
    const user = yield* read(response, BasicUser)
    expect(user.user.emailVerified).toBe(false)
    const denied = yield* request({
      path: "/auth/sign-in/email",
      method: "POST",
      body: { email, password },
    })
    expect(denied.status).toBe(403)
    const [message] = yield* sql<{
      body: string
      subject: string
    }>`SELECT body, subject FROM cloud_email_outbox WHERE recipient = ${email} ORDER BY id DESC LIMIT 1`
    expect(message?.subject).toBe("Verify your email")
    if (message === undefined) return yield* Effect.die(new Error("Verification email missing"))
    const verifyPath = new URL(message.body).pathname + new URL(message.body).search
    const verified = yield* request({ path: verifyPath })
    expect(verified.status).toBe(302)
    const login = yield* request({
      path: "/auth/sign-in/email",
      method: "POST",
      body: { email, password },
    })
    expect(login.status).toBe(200)
    const cookie = Cookies.toCookieHeader(login.cookies)
    expect(cookie).toContain("better-auth.session_token=")
    return { email, cookie, id: user.user.id }
  })

/**
 * Sends `head`, an HTTP/1.1 request line and headers, then `body` to the
 * server at `origin` over a raw socket that then stays open without sending
 * anything more, and answers the response's status and how many
 * milliseconds it took to arrive. A server that waits for the rest of the
 * body never answers, so the caller bounds the wait.
 */
export const stalledRequest = (request: {
  readonly origin: string
  readonly head: string
  readonly body: Uint8Array
}) =>
  Effect.callback<{ readonly status: number; readonly elapsedMs: number }>((resume, signal) => {
    const url = new URL(request.origin)
    const started = performance.now()
    const head = new TextEncoder().encode(request.head)
    const pending = { bytes: new Uint8Array(head.byteLength + request.body.byteLength) }
    pending.bytes.set(head)
    pending.bytes.set(request.body, head.byteLength)
    let received = ""
    const flush = (socket: Bun.Socket) => {
      const written = socket.write(pending.bytes)
      pending.bytes = pending.bytes.subarray(Math.max(written, 0))
    }

    void Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        open: flush,
        drain: flush,
        data: (socket, data) => {
          received += new TextDecoder().decode(data)
          const status = /^HTTP\/1\.1 (\d{3})/u.exec(received)
          if (status === null || !received.includes("\r\n\r\n")) return
          resume(
            Effect.succeed({ status: Number(status[1]), elapsedMs: performance.now() - started }),
          )
          socket.end()
        },
      },
    }).then((socket) => signal.addEventListener("abort", () => socket.end()))
  })
