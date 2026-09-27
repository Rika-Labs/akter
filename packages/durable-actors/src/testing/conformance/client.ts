import { Crypto, Deferred, Effect, Fiber, Schema } from "effect"
import { DatabaseClock, monotonic } from "../../client/clock.ts"
import { ActorError, RunnerAtCapacity, withRetryAfter } from "../../errors/actor.ts"
import { actorErrorBody } from "../../serve/wire.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ConformanceCase } from "../conformance.ts"
import {
  Closed,
  Full,
  gate,
  HttpLobby,
  HttpRoom,
  HttpTicket,
  receipts,
  runs,
  serveHttp,
  tenantOf,
} from "./http.ts"

const baseFetch = globalThis.fetch.bind(globalThis)

const urlOf = (input: RequestInfo | URL) =>
  new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)

/** One request the client sent, as the server would see it. */
interface Sent {
  readonly path: string
  readonly headers: Headers
}

type Intercept = (sent: Sent, index: number) => Response | "drop" | undefined

/**
 * A `fetch` that records every request and lets a case answer or drop one. A
 * dropped request still reaches the server; only its response is lost.
 */
const recording = (intercept: Intercept = () => undefined) => {
  const sent: Array<Sent> = []

  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input)
    const request: Sent = { path: url.pathname, headers: new Headers(init?.headers) }
    const index = sent.push(request) - 1
    const action = intercept(request, index)

    if (action instanceof Response) return Promise.resolve(action)

    return baseFetch(input, init).then((response) =>
      action === "drop"
        ? response.text().then(() => Promise.reject(new TypeError("connection reset")))
        : response,
    )
  }

  const commands = (member: string) => sent.filter((request) => request.path.endsWith(`/${member}`))

  return { sent, fetch, commands }
}

const keysOf = (requests: ReadonlyArray<Sent>) =>
  requests.map((request) => request.headers.get("idempotency-key"))

type Settled<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown }

const settle = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise(promise).pipe(
    Effect.match({
      onSuccess: (value): Settled<A> => ({ ok: true, value }),
      onFailure: (failure): Settled<A> => ({ ok: false, error: failure.cause }),
    }),
  )

const isActorError = Schema.is(ActorError)

/** A rejected call's framework reason as `{ tag, ...fields }`, or undefined. */
const reasonOf = (settled: Settled<unknown>) => {
  if (settled.ok || !isActorError(settled.error)) return undefined

  const reason = settled.error.reason

  return Object.assign({ tag: reason._tag }, reason)
}

const failed = (settled: Settled<unknown>) => (settled.ok ? undefined : settled.error)

const json = (status: number, body: Schema.Json) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const clientConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "client retries a dropped response with the same command id and returns the committed receipt",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          let dropped = false

          const wire = recording((sent) => {
            if (dropped || !sent.path.endsWith("/Post")) return undefined
            dropped = true

            return "drop"
          })

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          })

          const before = runs.count
          const result = yield* settle(() => rooms.get("drop").Post({ text: "a" }))

          expect(result).toEqual({ ok: true, value: 1 })
          const keys = keysOf(wire.commands("Post"))
          expect(keys.length).toBe(2)
          expect(keys[1]).toBe(keys[0])
          expect(runs.count - before).toBe(1)
          expect(yield* receipts(tenant, "HttpRoom", "drop")).toBe(1)

          const replay = yield* settle(() =>
            rooms.get("drop").Post({ text: "a" }, { commandId: keys[0]! }),
          )

          expect(replay).toEqual({ ok: true, value: 1 })
          expect(runs.count - before).toBe(1)
        }),
      ),
  },
  {
    name: "client retries a gateway 5xx and a retryAfter envelope with the same id, honoring the delay",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          let posts = 0

          const capacity = yield* actorErrorBody(
            ActorError.make({ reason: RunnerAtCapacity.make() }).pipe(withRetryAfter(300)),
          )

          const wire = recording((sent) => {
            if (!sent.path.endsWith("/Post")) return undefined
            posts += 1

            if (posts === 1) return new Response("bad gateway", { status: 502 })

            if (posts === 2) return json(503, capacity)

            return undefined
          })

          const room = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          }).get("retry")

          const started = performance.now()
          const result = yield* settle(() => room.Post({ text: "a" }))
          const elapsed = performance.now() - started

          expect(result).toEqual({ ok: true, value: 1 })
          const keys = keysOf(wire.commands("Post"))
          expect(keys.length).toBe(3)
          expect(new Set(keys).size).toBe(1)
          expect(elapsed >= 300).toBe(true)
          expect(yield* receipts(tenant, "HttpRoom", "retry")).toBe(1)
        }),
      ),
  },
  {
    name: "client surfaces an expired id as CommandExpired without reminting or retrying",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const actors = yield* InternalActors
          const tenant = yield* tenantOf
          const expired = yield* server.mint(-actors.retryWindowMs - 1)
          const wire = recording()

          const room = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          }).get("expired")

          const before = runs.count
          const result = yield* settle(() => room.Post({ text: "a" }, { commandId: expired }))

          expect(reasonOf(result)).toMatchObject({ tag: "CommandExpired", commandId: expired })
          expect(keysOf(wire.commands("Post"))).toEqual([expired])
          expect(runs.count).toBe(before)
          expect(yield* receipts(tenant, "HttpRoom", "expired")).toBe(0)
        }),
      ),
  },
  {
    name: "client retries a future id with the same id once the database clock passes it, and never repairs a wrong-window id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const wire = recording()

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          })

          const future = yield* server.mint(400)

          const result = yield* settle(() =>
            rooms.get("future").Post({ text: "a" }, { commandId: future }),
          )

          expect(result).toEqual({ ok: true, value: 1 })
          expect(keysOf(wire.commands("Post"))).toEqual([future, future])

          const window = yield* server.mint(0, 1_000)

          const refused = yield* settle(() =>
            rooms.get("window").Post({ text: "a" }, { commandId: window }),
          )

          expect(reasonOf(refused)).toMatchObject({
            tag: "InvalidCommandId",
            code: "window",
            commandId: window,
          })
          expect(keysOf(wire.commands("Post")).slice(2)).toEqual([window])
          expect(yield* receipts(tenant, "HttpRoom", "window")).toBe(0)
        }),
      ),
  },
  {
    name: "client marks a self-minted id the server refused before any turn as never admitted",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf

          // A protocol answer with the wrong window makes the client mint an id the server refuses.
          const wire = recording((sent) =>
            sent.path === "/protocol"
              ? json(200, { protocol: 1, retryWindowMs: 1_000, now: Math.round(monotonic()) })
              : undefined,
          )

          const room = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          }).get("never")

          const refused = yield* settle(() => room.Post({ text: "a" }))

          expect(reasonOf(refused)).toMatchObject({
            tag: "InvalidCommandId",
            code: "window",
            neverAdmitted: true,
          })
          expect(wire.commands("Post").length).toBe(1)
        }),
      ),
  },
  {
    name: "client maps declared errors to their classes and framework failures to typed ActorErrors",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf

          const wire = recording((sent) =>
            sent.path.endsWith("/plain/Count") ? new Response("nope", { status: 400 }) : undefined,
          )

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          })

          const full = yield* settle(() => rooms.get("errors").Post({ text: "full" }))
          expect(Schema.is(Full)(failed(full))).toBe(true)
          expect(full).toMatchObject({ ok: false, error: { capacity: 1 } })

          const closed = yield* settle(() => rooms.get("errors").Post({ text: "closed" }))
          expect(Schema.is(Closed)(failed(closed))).toBe(true)
          expect(closed).toMatchObject({ ok: false, error: { reason: "night" } })

          const commandId = yield* settle(() => rooms.commandId())
          expect(commandId.ok).toBe(true)
          const id = commandId.ok ? commandId.value : ""
          yield* settle(() => rooms.get("errors").Post({ text: "a" }, { commandId: id }))

          const conflict = yield* settle(() =>
            rooms.get("errors").Post({ text: "b" }, { commandId: id }),
          )

          expect(reasonOf(conflict)).toMatchObject({ tag: "CommandConflict", commandId: id })

          const crash = yield* settle(() => rooms.get("errors").Crash())
          expect(reasonOf(crash)).toMatchObject({
            tag: "TransportError",
            code: "defect",
            status: 500,
            retryable: false,
          })
          expect(!crash.ok && String(crash.error)).not.toContain("secret detail")

          const plain = yield* settle(() => rooms.get("plain").Count())
          expect(reasonOf(plain)).toMatchObject({
            tag: "TransportError",
            code: "status",
            status: 400,
            retryable: false,
          })

          const sentBefore = wire.sent.length
          // @ts-expect-error input the member's schema rejects
          const invalid = yield* settle(() => rooms.get("errors").Post({ text: 7 }))
          expect(reasonOf(invalid)).toMatchObject({ tag: "InvalidInput", code: "decode" })
          expect(wire.sent.length).toBe(sentBefore)
        }),
      ),
  },
  {
    name: "client surfaces auth failures and refreshes expired credentials once with the same id",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const wire = recording()

          const missing = yield* settle(() =>
            HttpRoom.client({ baseUrl: server.url, fetch: wire.fetch }).get("auth").Count(),
          )

          expect(reasonOf(missing)).toMatchObject({
            tag: "Unauthorized",
            code: "missing_credentials",
          })

          const invalid = yield* settle(() =>
            HttpRoom.client({
              baseUrl: server.url,
              headers: { authorization: "Bearer nobody" },
              fetch: wire.fetch,
            })
              .get("auth")
              .Post({ text: "a" }),
          )

          expect(reasonOf(invalid)).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect(wire.commands("Post").length).toBe(1)

          const stale = yield* settle(() =>
            HttpRoom.client({
              baseUrl: server.url,
              headers: { authorization: "Bearer expired" },
              fetch: wire.fetch,
            })
              .get("auth")
              .Post({ text: "a" }),
          )

          expect(reasonOf(stale)).toMatchObject({ tag: "Unauthorized", code: "expired" })
          expect(wire.commands("Post").length).toBe(3)

          let calls = 0

          const refreshing = HttpRoom.client({
            baseUrl: server.url,
            headers: () => {
              calls += 1

              return Promise.resolve({
                authorization: calls === 1 ? "Bearer expired" : `Bearer ${tenant}:alice`,
              })
            },
            fetch: wire.fetch,
          })

          const refreshed = yield* settle(() => refreshing.get("auth").Post({ text: "a" }))

          expect(refreshed).toEqual({ ok: true, value: 1 })
          const keys = keysOf(wire.commands("Post").slice(3))
          expect(keys.length).toBe(2)
          expect(keys[1]).toBe(keys[0])
          expect(yield* receipts(tenant, "HttpRoom", "auth")).toBe(1)
        }),
      ),
  },
  {
    name: "client routes queries, singleton and minted actors, and special-character keys, sending the greatest consistency token",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const headers = { authorization: `Bearer ${tenant}:alice` }
          let versions = ["7", "12", "9"]

          const wire = recording()

          const tokened = (input: RequestInfo | URL, init?: RequestInit) =>
            wire.fetch(input, init).then((response) => {
              const [version, ...rest] = versions

              if (version === undefined) return response
              versions = rest
              const copy = new Headers(response.headers)
              copy.set("durable-version", version)

              return new Response(response.body, { status: response.status, headers: copy })
            })

          const rooms = HttpRoom.client({ baseUrl: `${server.url}/`, headers, fetch: tokened })
          const key = "a/b c?#%é"
          expect(yield* settle(() => rooms.get(key).Post({ text: "a" }))).toEqual({
            ok: true,
            value: 1,
          })
          expect(yield* settle(() => rooms.get(key).Count())).toEqual({ ok: true, value: 1 })
          expect(yield* settle(() => rooms.get(key).Count())).toEqual({ ok: true, value: 1 })
          expect(yield* receipts(tenant, "HttpRoom", key)).toBe(1)

          const counts = wire.commands("Count")
          expect(counts[0]!.path).toBe(`/actors/HttpRoom/${encodeURIComponent(key)}/Count`)
          expect(counts.map((request) => request.headers.get("durable-min-version"))).toEqual([
            "12",
            "12",
          ])
          expect(counts.map((request) => request.headers.get("idempotency-key"))).toEqual([
            null,
            null,
          ])

          const lobby = HttpLobby.client({ baseUrl: server.url, headers, fetch: wire.fetch })
          expect(yield* settle(() => lobby.get().Join())).toEqual({ ok: true, value: 1 })
          expect(wire.commands("Join")[0]!.path).toBe("/actors/HttpLobby/Join")

          const tickets = HttpTicket.client({ baseUrl: server.url, headers, fetch: wire.fetch })
          const ticket = tickets.create()
          expect(yield* settle(() => ticket.Join())).toEqual({ ok: true, value: 1 })
          expect(yield* settle(() => tickets.get(ticket.ref.id).Join())).toEqual({
            ok: true,
            value: 2,
          })
        }),
      ),
  },
  {
    name: "client stops waiting at its timeout or abort, and the same id later returns the committed receipt",
    run: ({ expect, environment }) => {
      const controllers = { timeout: new AbortController(), abort: new AbortController() }

      return environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const wire = recording()

          const rooms = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
          })

          for (const stop of ["timeout", "abort"] as const) {
            const id = `hold-${stop}`
            const commandId = yield* server.mint()
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            gate.hold = Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            )
            const controller = controllers[stop]

            const call = yield* settle(() =>
              rooms
                .get(id)
                .Hold(
                  stop === "timeout"
                    ? { commandId, timeoutInMs: 300 }
                    : { commandId, signal: controller.signal },
                ),
            ).pipe(Effect.forkChild)

            yield* Deferred.await(entered)

            if (stop === "abort") controller.abort()

            const stopped = yield* Fiber.join(call)
            expect(reasonOf(stopped)).toMatchObject({ tag: "Timeout", commandId })

            gate.hold = Effect.void
            yield* Deferred.succeed(release, undefined)

            const retried = yield* settle(() => rooms.get(id).Hold({ commandId }))
            expect(retried).toEqual({ ok: true, value: 1 })
            expect(yield* receipts(tenant, "HttpRoom", id)).toBe(1)
          }
        }),
      )
    },
  },
  {
    name: "client ids minted from a skewed local clock are admitted, and /command-ids ids are preserved",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const server = yield* serveHttp()
          const tenant = yield* tenantOf
          const actors = yield* InternalActors
          const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)

          for (const skew of [-10 * 60_000, 10 * 60_000]) {
            const clock = new DatabaseClock(() => monotonic() + skew)
            const sentAt = clock.localNow()
            const reply = yield* server.send("/protocol", { method: "GET" })
            clock.observe(sentAt, clock.localNow(), Number(reply.headers.get("durable-now")))

            const key = clock.mint(
              actors.retryWindowMs,
              uuid.replace(/^.{8}/, String(skew < 0 ? 10000000 : 20000000)),
            )

            const posted = yield* server.send(`/actors/HttpRoom/skew${skew}/Post`, {
              token: `${tenant}:alice`,
              key,
              body: { text: "a" },
            })

            expect(posted.status).toBe(200)
          }

          const wire = recording()

          const room = HttpRoom.client({
            baseUrl: server.url,
            headers: { authorization: `Bearer ${tenant}:alice` },
            fetch: wire.fetch,
            commandIds: "server",
          }).get("server-ids")

          expect(yield* settle(() => room.Post({ text: "a" }))).toEqual({ ok: true, value: 1 })
          expect(wire.sent.map((request) => request.path)).toEqual([
            "/command-ids",
            "/actors/HttpRoom/server-ids/Post",
          ])
        }),
      ),
  },
]
