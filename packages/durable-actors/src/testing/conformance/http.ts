import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
  type Scope,
} from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpMethod,
  HttpMethod as HttpMethodModule,
  HttpRouter,
} from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Actor, ActorUnavailable, Unauthorized, User } from "../../index.ts"
import {
  ActorError,
  CommandConflict,
  CommandExpired,
  InvalidCommandId,
  InvalidInput,
  type Reason,
} from "../../errors/actor.ts"
import { InternalActors } from "../../handles/actors.ts"
import { ActorRef, System } from "../../identity/caller.ts"
import type { AuthProvider, AuthRequest } from "../../serve/auth.ts"
import type { ServeOptions } from "../../serve/layer.ts"
import { actorErrorBody } from "../../serve/wire.ts"
import { ActorTest } from "../actor-test.ts"
import type { ConformanceCase } from "../conformance.ts"

class Full extends Schema.TaggedError<Full>()("Full", { capacity: Schema.Int }) {}

class Closed extends Schema.TaggedError<Closed>()(
  "Closed",
  { reason: Schema.String },
  { httpApiStatus: 423 },
) {}

const Post = Actor.command("Post", {
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Int,
  errors: [Full, Closed],
})

const Whoami = Actor.command("Whoami", { output: Schema.String })

const Hold = Actor.command("Hold", { output: Schema.Int })

const Crash = Actor.command("Crash")

const Secret = Actor.command("Secret")

const Count = Actor.query("Count", { output: Schema.Int })

const Peek = Actor.query("Peek", { output: Schema.UndefinedOr(Schema.Int) })

const count = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

const HttpRoom = Actor.make("HttpRoom", {
  key: Schema.String,
  state: count,
  api: { Post, Whoami, Hold, Crash, Count, Peek },
  internal: { Secret },
})

const Join = Actor.command("Join", { output: Schema.Int })

const HttpLobby = Actor.make("HttpLobby", { key: Actor.singleton, state: count, api: { Join } })

const HttpTicket = Actor.make("HttpTicket", { state: count, api: { Join } })

/** Handler runs, so a replay can be shown not to rerun the handler. */
const runs = { count: 0 }

interface Gate {
  hold: Effect.Effect<void>
}

const gate: Gate = { hold: Effect.void }

export const httpLayer = Layer.mergeAll(
  HttpRoom.toLayer(
    Effect.succeed({
      Post: Effect.fnUntraced(function* ({ text }: { readonly text: string }) {
        const turn = yield* HttpRoom.Turn
        runs.count += 1
        yield* turn.state.set({ count: turn.state.count + 1 })

        if (text === "full") return yield* Full.make({ capacity: turn.state.count })

        if (text === "closed") return yield* Closed.make({ reason: "night" })

        return turn.state.count
      }),
      Whoami: Effect.fnUntraced(function* () {
        const turn = yield* HttpRoom.Turn
        runs.count += 1

        return `${turn.ref.tenant}/${Schema.is(User)(turn.caller) ? turn.caller.subject : turn.caller._tag}`
      }),
      Hold: Effect.fnUntraced(function* () {
        const turn = yield* HttpRoom.Turn
        yield* Effect.suspend(() => gate.hold)
        runs.count += 1
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
      Crash: () => Effect.die(new Error("handler crashed with a secret detail")),
      Secret: () => Effect.void,
    }),
  ),
  HttpRoom.toQueryLayer(
    Effect.succeed({
      Count: Effect.fnUntraced(function* () {
        return (yield* HttpRoom.Read).state.count
      }),
      Peek: Effect.fnUntraced(function* () {
        const { count } = (yield* HttpRoom.Read).state

        return count === 0 ? undefined : count
      }),
    }),
  ),
  HttpLobby.toLayer(
    Effect.succeed({
      Join: Effect.fnUntraced(function* () {
        const turn = yield* HttpLobby.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
    }),
  ),
  HttpTicket.toLayer(
    Effect.succeed({
      Join: Effect.fnUntraced(function* () {
        const turn = yield* HttpTicket.Turn
        yield* turn.state.set({ count: turn.state.count + 1 })

        return turn.state.count
      }),
    }),
  ),
)

// `Bearer <tenant>:<subject>`; `expired` and `unavailable` exercise the provider's failures.
const tokens = Actor.auth.make((request: AuthRequest) =>
  Effect.gen(function* () {
    const header = Headers.get(request.headers, "authorization")

    if (Option.isNone(header)) return yield* Unauthorized.make({ code: "missing_credentials" })

    const token = header.value.replace(/^Bearer /, "")

    if (token === "expired") return yield* Unauthorized.make({ code: "expired" })

    const match = /^([^:]+):(.+)$/s.exec(token)

    if (match === null) return yield* Unauthorized.make({ code: "invalid_credentials" })

    return { tenant: match[1]!, caller: User.make({ subject: match[2]! }) }
  }),
)

const unavailable: AuthProvider = {
  scheme: "bearer",
  cookies: false,
  authenticate: () =>
    Effect.fail(ActorUnavailable.make({ cause: new Error("identity provider secret detail") })),
}

// Providers are typed to return User or Anonymous; this one ignores that to prove the runtime check.
const systemCaller: AuthProvider = {
  scheme: "bearer",
  cookies: false,
  authenticate: () =>
    Effect.succeed({
      tenant: "t",
      caller: Object.assign(User.make({ subject: "smuggled" }), System.make({ source: "actor" })),
    }),
}

const served = [HttpRoom, HttpLobby, HttpTicket]

const encodeFull = (value: Full) => Schema.encodeEffect(Full)(value).pipe(Effect.orDie)

const encodeClosed = (value: Closed) => Schema.encodeEffect(Closed)(value).pipe(Effect.orDie)

interface Reply {
  readonly status: number
  readonly headers: globalThis.Headers
  readonly text: string
  readonly body: Schema.Json | undefined
}

interface Server {
  readonly url: string
  readonly send: (
    path: string,
    init?: {
      readonly method?: HttpMethod.HttpMethod
      readonly token?: string
      readonly key?: string
      readonly body?: Schema.Json
      readonly raw?: string
      readonly bytes?: Uint8Array
      readonly headers?: Readonly<Record<string, string>>
    },
  ) => Effect.Effect<Reply>
  /** A v1 id issued `offsetMs` from the database clock, in the runtime's window. */
  readonly mint: (offsetMs?: number, windowMs?: number) => Effect.Effect<string>
}

/** Serves the HTTP actors from a real listening Bun server for the rest of the scope. */
export const serveHttp = Effect.fnUntraced(function* (
  options?: Partial<ServeOptions<never>>,
): Effect.fn.Return<Server, never, InternalActors | Crypto.Crypto | Scope.Scope> {
  const actors = yield* InternalActors
  const crypto = yield* Crypto.Crypto
  const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)
  const context = yield* Effect.context<InternalActors>()

  const app = Actor.serve({ actors: served, auth: tokens, ...options }).pipe(
    Layer.provide(Layer.succeedContext(context)),
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
    send: (path, init) =>
      Effect.gen(function* () {
        const body =
          init?.raw ?? (init?.body === undefined ? undefined : yield* encodeJson(init.body))

        const base = HttpClientRequest.make(init?.method ?? "POST")(`${url}${path}`, {
          headers: init?.headers ?? {},
        })

        const authed =
          init?.token === undefined ? base : HttpClientRequest.bearerToken(base, init.token)

        const keyed =
          init?.key === undefined
            ? authed
            : HttpClientRequest.setHeader(authed, "idempotency-key", init.key)

        const type = init?.headers?.["content-type"] ?? "application/json"

        const request =
          init?.bytes !== undefined
            ? HttpClientRequest.bodyUint8Array(keyed, init.bytes, type)
            : body === undefined
              ? keyed
              : HttpClientRequest.bodyText(keyed, body, type)

        const response = yield* client.execute(request)
        const text = yield* response.text

        return {
          status: response.status,
          headers: new globalThis.Headers(response.headers),
          text,
          body: text === "" ? undefined : yield* decodeJson(text),
        }
      }).pipe(Effect.orDie),
    mint: (offsetMs = 0, windowMs = actors.retryWindowMs) =>
      Effect.gen(function* () {
        const now = yield* actors.databaseNow

        return `v1.${now + offsetMs}.${now + offsetMs + windowMs}.${yield* crypto.randomUUIDv4}`
      }).pipe(Effect.orDie),
  }
})

const isMethod = (value: string): value is HttpMethod.HttpMethod =>
  HttpMethodModule.isHttpMethod(value)

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))

const WireReason = Schema.Struct({
  reason: Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) }),
})

const reasonOf = (body: Schema.Json | undefined) =>
  Schema.decodeUnknownEffect(WireReason)(body).pipe(
    Effect.orDie,
    Effect.map(({ reason }) =>
      reason.code === undefined ? { tag: reason._tag } : { tag: reason._tag, code: reason.code },
    ),
  )

const isDefectBody = Schema.is(Schema.TaggedStruct("Defect", { traceId: Schema.String }))

const envelope = (reason: Reason) => actorErrorBody(ActorError.make({ reason }))

const receipts = Effect.fnUntraced(function* (tenant: string, actor: string, id: string) {
  return (yield* (yield* ActorTest).inspect(ActorRef.make({ tenant, actor, id }))).receipts
})

const rows = Effect.fnUntraced(function* (table: string) {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql(table)}`

  return row!.n
})

const tenantOf = Effect.gen(function* () {
  const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)

  return `http-${uuid.slice(0, 8)}`
})

export const httpConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "gives concurrent requests with different tokens different principals",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const subjects = Array.from({ length: 16 }, (_, index) => `user-${index}`)

          const replies = yield* Effect.forEach(
            subjects,
            (subject) =>
              Effect.flatMap(server.mint(), (key) =>
                server.send("/actors/HttpRoom/shared/Whoami", {
                  token: `${tenant}:${subject}`,
                  key,
                }),
              ),
            { concurrency: "unbounded" },
          )

          expect(replies.map((reply) => reply.body)).toEqual(
            subjects.map((subject) => `${tenant}/${subject}`),
          )
        }),
      ),
  },
  {
    name: "fails missing, invalid, and expired credentials with their codes before any turn and never as Anonymous",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const before = runs.count

          for (const [token, code] of [
            [undefined, "missing_credentials"],
            ["no-colon", "invalid_credentials"],
            ["expired", "expired"],
          ] as const) {
            const reply = yield* server.send("/actors/HttpRoom/creds/Whoami", {
              token,
              key: yield* server.mint(),
            })

            expect(reply.status).toBe(401)
            expect(reply.headers.get("www-authenticate")).toBe("Bearer")
            expect(reply.body).toEqual(yield* envelope(Unauthorized.make({ code })))
            const query = yield* server.send("/actors/HttpRoom/creds/Count", { token })
            expect(query.status).toBe(401)
          }

          expect(runs.count).toBe(before)
          expect((yield* server.send("/command-ids")).status).toBe(401)
        }),
      ),
  },
  {
    name: "serves every caller as Anonymous in the default tenant under Actor.auth.none, ignoring credentials",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ auth: Actor.auth.none })

          const reply = yield* server.send("/actors/HttpRoom/public/Whoami", {
            token: "tenant:alice",
            key: yield* server.mint(),
            headers: { "x-tenant": "other" },
          })

          expect(reply.body).toBe("default/Anonymous")
        }),
      ),
  },
  {
    name: "replays a declared failure with the same tag, fields, and status",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`

          for (const [text, status, body] of [
            ["full", 422, yield* encodeFull(Full.make({ capacity: 1 }))],
            ["closed", 423, yield* encodeClosed(Closed.make({ reason: "night" }))],
          ] as const) {
            const key = yield* server.mint()

            const first = yield* server.send(`/actors/HttpRoom/declared-${text}/Post`, {
              token,
              key,
              body: { text },
            })

            const before = runs.count

            const replay = yield* server.send(`/actors/HttpRoom/declared-${text}/Post`, {
              token,
              key,
              body: { text },
            })

            for (const reply of [first, replay]) {
              expect(reply.status).toBe(status)
              expect(reply.body).toEqual(body)
              expect(reply.headers.get("x-request-id")).toBe(key)
            }

            expect(runs.count).toBe(before)
          }
        }),
      ),
  },
  {
    name: "replays a committed output when a response is dropped and the same Idempotency-Key is retried",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const key = yield* server.mint()

          const call = server.send("/actors/HttpRoom/replay/Post", {
            token: `${tenant}:alice`,
            key: `"${key}"`,
            body: { text: "hi" },
          })

          expect((yield* call).body).toBe(1)
          const before = runs.count

          const retry = yield* server.send("/actors/HttpRoom/replay/Post", {
            token: `${tenant}:alice`,
            key,
            body: { text: "hi" },
          })

          expect(retry).toMatchObject({ status: 200, body: 1 })
          expect(retry.headers.get("x-request-id")).toBe(key)
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "replay")).toBe(1)
        }),
      ),
  },
  {
    name: "returns 409 CommandConflict for a reused id with different input, without running the handler",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          const key = yield* server.mint()
          yield* server.send("/actors/HttpRoom/conflict/Post", { token, key, body: { text: "a" } })
          const before = runs.count

          const reply = yield* server.send("/actors/HttpRoom/conflict/Post", {
            token,
            key,
            body: { text: "b" },
          })

          expect(reply.status).toBe(409)
          expect(reply.body).toEqual(yield* envelope(CommandConflict.make({ commandId: key })))
          expect(runs.count).toBe(before)
        }),
      ),
  },
  {
    name: "returns 410 CommandExpired for an expired id even after its receipt is pruned",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const actors = yield* InternalActors
          const tenant = yield* tenantOf
          const key = yield* server.mint(-actors.retryWindowMs - 1)
          const before = runs.count

          const reply = yield* server.send("/actors/HttpRoom/expired/Post", {
            token: `${tenant}:alice`,
            key,
            body: { text: "a" },
          })

          expect(reply.status).toBe(410)
          expect(reply.body).toEqual(yield* envelope(CommandExpired.make({ commandId: key })))
          expect(reply.headers.get("x-request-id")).toBe(key)
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "expired")).toBe(0)
        }),
      ),
  },
  {
    name: "rejects a command without Idempotency-Key, and a malformed, future, or wrong-window id, before any turn",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const before = runs.count

          const missing = yield* server.send("/actors/HttpRoom/ids/Post", {
            token,
            body: { text: "a" },
            headers: { "x-request-id": yield* server.mint() },
          })

          expect(missing.status).toBe(400)
          expect(yield* reasonOf(missing.body)).toEqual({
            tag: "InvalidInput",
            code: "missing_command_id",
          })
          expect(missing.headers.get("x-request-id")).toBe(null)

          for (const [key, code] of [
            ["v1.not-an-id", "malformed"],
            [`v2.1.2.${yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)}`, "version"],
            [yield* server.mint(60 * 60_000), "future"],
            [yield* server.mint(0, 1_000), "window"],
          ] as const) {
            const reply = yield* server.send("/actors/HttpRoom/ids/Post", {
              token,
              key,
              body: { text: "a" },
            })

            expect(reply.status).toBe(400)
            expect(reply.body).toEqual(
              yield* envelope(InvalidCommandId.make({ commandId: key, code })),
            )
            expect(reply.headers.get("x-request-id")).toBe(key)
          }

          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "ids")).toBe(0)
        }),
      ),
  },
  {
    name: "mints ids from the database clock at /command-ids without writing, and admits them",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const actors = yield* InternalActors
          const token = `${yield* tenantOf}:alice`
          const protocol = yield* server.send("/protocol", { method: "GET" })
          expect(protocol.status).toBe(200)
          expect(protocol.body).toMatchObject({ protocol: 1, retryWindowMs: actors.retryWindowMs })
          expect(protocol.headers.get("durable-protocol")).toBe("1")
          expect(Number(protocol.headers.get("durable-now")) > 0).toBe(true)

          const receiptsBefore = yield* rows("actor_receipts")
          const minted = yield* server.send("/command-ids", { token })
          expect(minted.status).toBe(200)
          expect(yield* rows("actor_receipts")).toBe(receiptsBefore)
          const { commandId } = minted.body as { readonly commandId: string }
          const [, issued, expires] = commandId.split(".")
          expect(Number(expires) - Number(issued)).toBe(actors.retryWindowMs)

          const reply = yield* server.send("/actors/HttpRoom/minted-id/Post", {
            token,
            key: commandId,
            body: { text: "a" },
          })

          expect(reply).toMatchObject({ status: 200, body: 1 })
        }),
      ),
  },
  {
    name: "carries no ActorUnavailable cause over HTTP, and computes isRetryable and retryAfter on the wire",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ auth: unavailable })

          const reply = yield* server.send("/actors/HttpRoom/unavailable/Whoami", {
            key: yield* server.mint(),
          })

          expect(reply.status).toBe(503)
          const body = reply.body as { readonly retryAfter: number }
          expect(yield* reasonOf(reply.body)).toEqual({ tag: "ActorUnavailable" })
          expect(reply.body).toMatchObject({ isRetryable: true })
          expect(reply.text.includes("secret")).toBe(false)
          expect(Object.keys((reply.body as { readonly reason: object }).reason)).toEqual(["_tag"])
          expect(body.retryAfter >= 125 && body.retryAfter <= 375).toBe(true)
          expect(reply.headers.get("retry-after")).toBe("1")
        }),
      ),
  },
  {
    name: "answers an internal member exactly like an unknown one, and omits it from OpenAPI",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ openapi: { path: "/openapi.json" } })
          const token = `${yield* tenantOf}:alice`

          const internal = yield* server.send("/actors/HttpRoom/r/Secret", {
            token,
            key: yield* server.mint(),
          })

          const unknown = yield* server.send("/actors/HttpRoom/r/Nope", {
            token,
            key: yield* server.mint(),
          })

          expect(internal.status).toBe(404)
          expect(internal.body).toEqual(unknown.body)
          expect(yield* reasonOf(internal.body)).toEqual({
            tag: "InvalidInput",
            code: "unknown_route",
          })
          const spec = yield* server.send("/openapi.json", { method: "GET" })
          expect(spec.text.includes("Secret")).toBe(false)
        }),
      ),
  },
  {
    name: "routes keyed, singleton, and minted actors, and treats special characters in ids as one segment",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const odd = "a b/c?d#é"

          const keyed = yield* server.send(`/actors/HttpRoom/${encodeURIComponent(odd)}/Post`, {
            token,
            key: yield* server.mint(),
            body: { text: "a" },
          })

          expect(keyed).toMatchObject({ status: 200, body: 1 })
          expect(yield* receipts(tenant, "HttpRoom", odd)).toBe(1)

          const lobby = yield* server.send("/actors/HttpLobby/Join", {
            token,
            key: yield* server.mint(),
          })

          expect(lobby).toMatchObject({ status: 200, body: 1 })
          expect(yield* receipts(tenant, "HttpLobby", "singleton")).toBe(1)

          const id = yield* (yield* InternalActors).mintActorId

          const ticket = yield* server.send(`/actors/HttpTicket/${id}/Join`, {
            token,
            key: yield* server.mint(),
          })

          expect(ticket).toMatchObject({ status: 200, body: 1 })

          const notUuid = yield* server.send("/actors/HttpTicket/not-a-uuid/Join", {
            token,
            key: yield* server.mint(),
          })

          expect(notUuid.status).toBe(400)
          expect(yield* reasonOf(notUuid.body)).toEqual({ tag: "InvalidInput", code: "decode" })

          const dots = yield* server.send("/actors/HttpRoom/%2E%2E/Post", {
            token,
            key: yield* server.mint(),
            body: { text: "a" },
          })

          expect(dots.status === 400 || dots.status === 404).toBe(true)
        }),
      ),
  },
  {
    name: "keeps running a command whose HTTP client disconnected, and replays it on retry",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const token = `${tenant}:alice`
          const key = yield* server.mint()
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          gate.hold = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          )

          const call = yield* server
            .send("/actors/HttpRoom/disconnect/Hold", { token, key })
            .pipe(Effect.forkChild)

          yield* Deferred.await(entered)
          yield* Fiber.interrupt(call)
          yield* Effect.sleep("50 millis")
          gate.hold = Effect.void
          yield* Deferred.succeed(release, undefined)

          const retry: Reply = yield* server
            .send("/actors/HttpRoom/disconnect/Hold", { token, key })
            .pipe(
              Effect.repeat({
                until: (reply) => reply.status === 200,
                schedule: Schedule.spaced("100 millis"),
                times: 50,
              }),
            )

          expect(retry).toMatchObject({ status: 200, body: 1 })
          expect(yield* receipts(tenant, "HttpRoom", "disconnect")).toBe(1)
        }),
      ),
  },
  {
    name: "answers a defect with an opaque 500 and writes no receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const key = yield* server.mint()

          const reply = yield* server.send("/actors/HttpRoom/defect/Crash", {
            token: `${tenant}:alice`,
            key,
          })

          expect(reply.status).toBe(500)
          expect(Object.keys(reply.body as object).sort()).toEqual(["_tag", "traceId"])
          expect(isDefectBody(reply.body)).toBe(true)
          expect(reply.text.includes("secret")).toBe(false)
          expect(reply.headers.get("x-request-id")).toBe(key)
          expect(yield* receipts(tenant, "HttpRoom", "defect")).toBe(0)
        }),
      ),
  },
  {
    name: "takes the tenant only from the provider, and refuses a provider that returns a System caller",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf

          const reply = yield* server.send(`/actors/HttpRoom/tenant/Whoami?tenant=other`, {
            token: `${tenant}:alice`,
            key: yield* server.mint(),
            headers: { "x-tenant": "other", "durable-tenant": "other" },
          })

          expect(reply.body).toBe(`${tenant}/alice`)

          const system = yield* serveHttp({ auth: systemCaller })
          const before = runs.count

          const refused = yield* system.send("/actors/HttpRoom/tenant/Whoami", {
            key: yield* server.mint(),
          })

          expect(refused.status).toBe(500)
          expect(isDefectBody(refused.body)).toBe(true)
          expect(runs.count).toBe(before)
        }),
      ),
  },
  {
    name: "serves a 512-byte subject and rejects 513 bytes and an encoded caller over 1 KiB",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const fits = "é".repeat(256)

          const ok = yield* server.send("/actors/HttpRoom/subject/Whoami", {
            token: `${tenant}:${fits}`,
            key: yield* server.mint(),
          })

          expect(ok).toMatchObject({ status: 200, body: `${tenant}/${fits}` })

          const before = runs.count

          for (const subject of [`${fits}x`, `"`.repeat(500)]) {
            const reply = yield* server.send("/actors/HttpRoom/subject/Whoami", {
              token: `${tenant}:${subject}`,
              key: yield* server.mint(),
            })

            expect(reply.status).toBe(401)
            expect(yield* reasonOf(reply.body)).toEqual({
              tag: "Unauthorized",
              code: "invalid_credentials",
            })
          }

          expect(runs.count).toBe(before)
        }),
      ),
  },
  {
    name: "documents every served route and serves every documented one; the document is deterministic",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const options = { openapi: { path: "/openapi.json" as const } }
          const server = yield* serveHttp(options)
          const again = yield* serveHttp(options)
          const token = `${yield* tenantOf}:alice`
          const first = yield* server.send("/openapi.json", { method: "GET" })
          const second = yield* again.send("/openapi.json", { method: "GET" })
          expect(first.status).toBe(200)
          expect(first.text).toBe(second.text)

          const spec = first.body as {
            readonly openapi: string
            readonly paths: Record<
              string,
              Record<
                string,
                {
                  readonly operationId: string
                  readonly parameters: ReadonlyArray<{ readonly name: string; readonly in: string }>
                  readonly security: ReadonlyArray<Record<string, ReadonlyArray<string>>>
                }
              >
            >
          }

          expect(spec.openapi).toBe("3.1.0")

          const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
            Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
          )

          expect(operations.map(({ operation }) => operation.operationId).sort()).toEqual(
            [
              "HttpLobby.Join",
              "HttpRoom.Count",
              "HttpRoom.Crash",
              "HttpRoom.Hold",
              "HttpRoom.Peek",
              "HttpRoom.Post",
              "HttpRoom.Whoami",
              "HttpTicket.Join",
              "durable.commandIds",
              "durable.protocol",
            ].sort(),
          )

          for (const { path, method, operation } of operations) {
            const headers = operation.parameters.filter((parameter) => parameter.in === "header")

            const isCommand =
              path.startsWith("/actors/") && !path.endsWith("/Count") && !path.endsWith("/Peek")

            expect(headers.map((parameter) => parameter.name)).toEqual(
              isCommand ? ["idempotency-key"] : [],
            )
            expect(operation.security.length === 0).toBe(
              operation.operationId === "durable.protocol",
            )

            if (path === "/actors/HttpRoom/{id}/Crash" || path === "/actors/HttpRoom/{id}/Hold")
              continue

            const concrete = path.replace(
              "{id}",
              path.includes("HttpTicket") ? yield* (yield* InternalActors).mintActorId : "doc",
            )

            const reply = yield* server.send(concrete, {
              method: Option.getOrThrow(Option.liftPredicate(method.toUpperCase(), isMethod)),
              token,
              key: isCommand ? yield* server.mint() : undefined,
              body: path.endsWith("/Post") ? { text: "doc" } : undefined,
            })

            expect([concrete, reply.status < 300]).toEqual([concrete, true])
          }
        }),
      ),
  },
  {
    name: "refuses a request whose Origin is neither the server's nor listed, and serves requests without Origin",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ origins: ["https://app.example.com"] })
          const before = runs.count

          const refused = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            key: yield* server.mint(),
            headers: { origin: "https://evil.example.com" },
          })

          expect(refused.status).toBe(403)
          expect(yield* reasonOf(refused.body)).toEqual({
            tag: "InvalidInput",
            code: "origin_not_allowed",
          })
          expect(runs.count).toBe(before)

          const token = `${yield* tenantOf}:alice`

          const listed = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            token,
            key: yield* server.mint(),
            headers: { origin: "https://app.example.com" },
          })

          expect(listed.status).toBe(200)
          expect(listed.headers.get("access-control-allow-origin")).toBe("https://app.example.com")
          expect(listed.headers.get("access-control-expose-headers")).toContain("x-request-id")

          const same = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            token,
            key: yield* server.mint(),
            headers: { origin: server.url },
          })

          expect(same.status).toBe(200)

          const otherScheme = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            token,
            key: yield* server.mint(),
            headers: { origin: server.url.replace(/^http:/, "https:") },
          })

          expect(otherScheme.status).toBe(403)

          const bare = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            token,
            key: yield* server.mint(),
          })

          expect(bare.status).toBe(200)

          const preflight = yield* server.send("/actors/HttpRoom/origin/Whoami", {
            method: "OPTIONS",
            headers: { origin: "https://app.example.com" },
          })

          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key")
        }),
      ),
  },
  {
    name: "rejects non-JSON and oversized bodies and credentials before any turn",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ limits: { requestBytes: 64, credentialBytes: 128 } })
          const token = `${yield* tenantOf}:alice`
          const before = runs.count

          const text = yield* server.send("/actors/HttpRoom/body/Post", {
            token,
            key: yield* server.mint(),
            raw: "text=a",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          })

          expect(text.status).toBe(415)
          expect(yield* reasonOf(text.body)).toEqual({
            tag: "InvalidInput",
            code: "unsupported_media_type",
          })

          const large = yield* server.send("/actors/HttpRoom/body/Post", {
            token,
            key: yield* server.mint(),
            body: { text: "x".repeat(100) },
          })

          expect(large.status).toBe(413)

          const credential = yield* server.send("/actors/HttpRoom/body/Post", {
            token: `${token}${"x".repeat(200)}`,
            key: yield* server.mint(),
            body: { text: "a" },
          })

          expect(credential.status).toBe(413)

          const invalid = yield* server.send("/actors/HttpRoom/body/Post", {
            token,
            key: yield* server.mint(),
            body: { text: 5 },
          })

          expect(invalid.status).toBe(400)
          expect(invalid.body).toEqual(
            yield* envelope(
              InvalidInput.make({
                code: "decode",
                issues: [{ path: "text", message: "Invalid type" }],
              }),
            ),
          )

          const utf8 = yield* server.send("/actors/HttpRoom/body/Post", {
            token,
            key: yield* server.mint(),
            bytes: new Uint8Array([
              0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
            ]),
          })

          expect(utf8.status).toBe(400)
          expect(yield* reasonOf(utf8.body)).toEqual({ tag: "InvalidInput", code: "decode" })

          const protocol = yield* server.send("/actors/HttpRoom/body/Post", {
            token,
            key: yield* server.mint(),
            body: { text: "a" },
            headers: { "durable-protocol": "2" },
          })

          expect(protocol.status).toBe(400)
          expect(yield* reasonOf(protocol.body)).toEqual({
            tag: "InvalidInput",
            code: "unsupported_protocol",
          })
          expect(runs.count).toBe(before)
        }),
      ),
  },
  {
    name: "answers a query without Idempotency-Key or x-request-id, ignoring durable-min-version",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const token = `${yield* tenantOf}:alice`
          yield* server.send("/actors/HttpRoom/query/Post", {
            token,
            key: yield* server.mint(),
            body: { text: "a" },
          })

          const reply = yield* server.send("/actors/HttpRoom/query/Count", {
            token,
            headers: { "durable-min-version": "99" },
          })

          expect(reply).toMatchObject({ status: 200, body: 1 })
          expect(reply.headers.get("x-request-id")).toBe(null)
          expect(reply.headers.get("durable-version")).toBe(null)
          expect(reply.headers.get("durable-protocol")).toBe("1")
        }),
      ),
  },
  {
    name: "fails Actor.serve at startup when retryWindowMs is below 60 seconds, and admits ids minted at exactly 60 seconds",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const actors = yield* InternalActors
          const short = InternalActors.of({ ...actors, retryWindowMs: 59_999 })

          const exit = yield* HttpRouter.toHttpEffect(
            Actor.serve({ actors: served, auth: tokens }).pipe(
              Layer.provide(Layer.succeed(InternalActors, short)),
            ),
          ).pipe(Effect.exit)

          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("at least 60 seconds")
          expect(actors.retryWindowMs).toBe(60_000)

          const server = yield* serveHttp()
          const tenant = yield* tenantOf

          const reply = yield* server.send("/actors/HttpRoom/window/Whoami", {
            token: `${tenant}:alice`,
            key: yield* server.mint(0, 60_000),
          })

          expect(reply).toMatchObject({ status: 200, body: `${tenant}/alice` })
        }),
      ),
  },
  {
    name: "serves routes at the root for basePath /, and answers an undefined query output with 200 null",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp({ basePath: "/" })
          const token = `${yield* tenantOf}:alice`

          expect((yield* server.send("/protocol", { method: "GET" })).status).toBe(200)
          expect(yield* server.send("/actors/HttpRoom/peek/Peek", { token })).toMatchObject({
            status: 200,
            text: "null",
          })

          yield* server.send("/actors/HttpRoom/peek/Post", {
            token,
            key: yield* server.mint(),
            body: { text: "a" },
          })

          expect(yield* server.send("/actors/HttpRoom/peek/Peek", { token })).toMatchObject({
            status: 200,
            body: 1,
          })
        }),
      ),
  },
  {
    name: "fails Actor.serve at startup when a member's operation id collides with a protocol route",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const Durable = Actor.make("durable", {
            key: Actor.singleton,
            state: count,
            api: { protocol: Actor.query("protocol", { output: Schema.Int }) },
          })

          const exit = yield* HttpRouter.toHttpEffect(
            Actor.serve({ actors: [Durable], auth: tokens }).pipe(
              Layer.provide(Layer.succeed(InternalActors, yield* InternalActors)),
            ),
          ).pipe(Effect.exit)

          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
            "collides with a protocol operation id",
          )
        }),
      ),
  },
  {
    name: "fails Actor.serve at startup when openapi.path collides with a protocol route",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const internal = Layer.succeed(InternalActors, yield* InternalActors)

          for (const path of ["/protocol", "/command-ids", "/actors/Room"] as const) {
            const exit = yield* HttpRouter.toHttpEffect(
              Actor.serve({ actors: [HttpRoom], auth: tokens, openapi: { path } }).pipe(
                Layer.provide(internal),
              ),
            ).pipe(Effect.exit)

            expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
              `openapi.path ${path} collides with a protocol route`,
            )
          }
        }),
      ),
  },
]
