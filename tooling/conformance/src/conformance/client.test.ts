import { connect } from "node:net"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import type { RpcClientError } from "effect/rpc"
import { ActorError, InvalidCommandId, Unauthorized } from "../../../../packages/akter/src/index.ts"
import { AkterClient } from "../../../../packages/akter/src/client/index.ts"
import { protocolLayer } from "../../../../packages/akter/src/client/transport.ts"
import type { Client } from "../../../../packages/akter/src/contract/handle.ts"
import { CommandIds } from "../../../../packages/akter/src/execution/command-ids.ts"
import {
  ActionFailed,
  ActionSuccess,
  groupOf,
  Tags,
} from "../../../../packages/akter/src/rpc/group.ts"
import type { Frame } from "../../../../packages/akter/src/rpc/group.ts"
import { Counter, LIMIT, Over, lossyProxy, makeAuth, serve } from "./client.ts"

/** The reason of an `ActorError` failure, or the failure itself when it is anything else. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => undefined,
    onSome: (error) => (Schema.is(ActorError)(error) ? error.reason : error),
  })

/** Runs `effect` with the client `layer` builds, for `effect`'s own scope. */
const using =
  (layer: Layer.Layer<Client>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer), (context) => Effect.provideContext(effect, context)),
    )

type WireError = ActorError | RpcClientError.RpcClientError

/** A raw client of the RPC group for the enclosing scope, for assertions about the wire itself. */
const wireAt = (url: string, authorization: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(
      protocolLayer({ url, actors: [Counter], headers: { authorization } }),
    )
    const flat = yield* Effect.provideContext(
      RpcClient.make(groupOf([Counter]), { flatten: true }),
      protocol,
    )
    const action = (
      member: string,
      id: string,
      commandId: string,
      payload: Schema.Json,
      headers = {},
    ) =>
      flat(
        Tags.action("Counter", member),
        { id, commandId, payload },
        { headers },
      ) as Effect.Effect<typeof ActionSuccess.Type, WireError | typeof ActionFailed.Type>
    return {
      add: (id: string, commandId: string, payload: Schema.Json) =>
        action("add", id, commandId, payload),
      whoami: (id: string, commandId: string, headers: Record<string, string> = {}) =>
        action("whoami", id, commandId, null, headers),
      state: (id: string) => flat(Tags.state("Counter"), { id }) as Stream.Stream<Frame, WireError>,
      reauthenticate: (authorization: string) =>
        flat(Tags.reauthenticate, { authorization }) as Effect.Effect<void, WireError>,
    }
  })

/** One raw HTTP/1.1 exchange, since `fetch` on Node refuses to send upgrade headers. */
const exchange = (
  port: number,
  init: { method: string; path: string; headers?: Record<string, string>; body?: string },
) =>
  Effect.callback<{ readonly status: number; readonly body: string }>((resume) => {
    const body = init.body ?? ""
    const head = {
      host: `127.0.0.1:${port}`,
      connection: "close",
      "content-length": String(body.length),
      ...init.headers,
    }
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `${init.method} ${init.path} HTTP/1.1\r\n${Object.entries(head)
          .map(([name, value]) => `${name}: ${value}\r\n`)
          .join("")}\r\n${body}`,
      ),
    )
    let received = ""
    const answer = (complete: boolean) => {
      const [header = "", rest = ""] = received.split("\r\n\r\n")
      const length = /content-length: *(\d+)/i.exec(header)?.[1]
      if (!complete && (length === undefined || Buffer.byteLength(rest) < Number(length))) return
      socket.destroy()
      resume(
        Effect.succeed({
          status: Number(header.split(" ")[1]),
          body: length === undefined ? rest : rest.slice(0, Number(length)),
        }),
      )
    }
    socket.on("data", (chunk) => {
      received += chunk.toString()
      answer(false)
    })
    socket.on("end", () => answer(true))
    socket.on("error", (error) => resume(Effect.die(error)))
    return Effect.sync(() => socket.destroy())
  })

const transports = [
  { name: "WebSocket", scheme: "ws" },
  { name: "HTTP", scheme: "http" },
] as const

for (const { name, scheme } of transports) {
  const url = (port: number) => `${scheme}://127.0.0.1:${port}/rpc`
  const as = (port: number, subject: string) =>
    using(
      AkterClient.layer({
        url: url(port),
        actors: [Counter],
        headers: { authorization: `Bearer ${subject}` },
      }),
    )
  const wire = (port: number, subject: string) => wireAt(url(port), `Bearer ${subject}`)
  /** The counter's state as one client reads it, after everything before it completed. */
  const countOf = (port: number, id: string) =>
    Effect.flatMap(Counter.client(id), (counter) => Stream.runHead(counter.state)).pipe(
      Effect.map((state) => Option.getOrThrow(state).count),
      as(port, "reader"),
    )

  describe(`client conformance over ${name}`, () => {
    it.live("calls reply as the caller, and a declared failure arrives as itself", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const alice = yield* Effect.gen(function* () {
          const counter = yield* Counter.client("calls")
          return {
            first: yield* counter.add(2),
            second: yield* counter.add(3),
            who: yield* counter.whoami(),
            over: yield* Effect.flip(counter.add(LIMIT)),
          }
        }).pipe(as(port, "alice"))
        const bob = yield* Effect.flatMap(Counter.client("calls"), (counter) =>
          counter.whoami(),
        ).pipe(as(port, "bob"))
        expect(alice).toEqual({
          first: 2,
          second: 5,
          who: "alice",
          over: Over.make({ limit: LIMIT }),
        })
        expect(alice.over).toBeInstanceOf(Over)
        expect(bob).toBe("bob")
      }).pipe(Effect.scoped),
    )

    it.live("the wire marks a same-id retry replayed, runs it once, and refuses a reused id", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const call = yield* wire(port, "alice")
        const other = yield* wire(port, "mallory")
        const now = yield* Clock.currentTimeMillis
        const id = yield* CommandIds.mint(now)
        const first = yield* call.add("dedupe", id, 2)
        const again = yield* call.add("dedupe", id, 2)
        const failing = yield* CommandIds.mint(now)
        const refused = yield* Effect.flip(call.add("dedupe", failing, LIMIT))
        const refusedAgain = yield* Effect.flip(call.add("dedupe", failing, LIMIT))
        const conflict = yield* Effect.exit(call.add("dedupe", id, 3))
        const stolen = yield* Effect.exit(other.add("dedupe", id, 2))
        const undecodable = yield* Effect.exit(call.add("dedupe", yield* CommandIds.mint(now), "x"))
        expect(first).toEqual({ value: 2, replayed: false })
        expect(again).toEqual({ value: 2, replayed: true })
        expect(refused).toHaveProperty("_tag", "ActionFailed")
        expect(refused).toHaveProperty(["error", "_tag"], "Over")
        expect(refused).toHaveProperty(["error", "limit"], LIMIT)
        expect(refused).toHaveProperty("replayed", false)
        expect(refusedAgain).toHaveProperty("replayed", true)
        expect(failureOf(conflict)).toEqual(
          InvalidCommandId.make({ commandId: id, code: "conflict" }),
        )
        expect(failureOf(stolen)).toEqual(Unauthorized.make({ code: "outcome_access_denied" }))
        expect(failureOf(undecodable)).toHaveProperty("code", "decode")
        expect(yield* countOf(port, "dedupe")).toBe(2)
      }).pipe(Effect.scoped),
    )

    it.live("calls run as the authenticated caller, whatever headers a frame carries", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const raw = yield* wire(port, "alice")
        const spoofed = yield* raw.whoami(
          "spoof",
          yield* CommandIds.mint(yield* Clock.currentTimeMillis),
          {
            authorization: "Bearer mallory",
            "x-akter-session": "forged",
          },
        )
        expect(spoofed).toEqual({ value: "alice", replayed: false })
      }).pipe(Effect.scoped),
    )

    it.live("a call whose reply was lost is retried with the same command id and runs once", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const proxy = yield* lossyProxy(port)
        proxy.cut()
        const reply = yield* Effect.flatMap(Counter.client("lost"), (counter) =>
          counter.add(7),
        ).pipe(as(proxy.port, "alice"))
        expect(proxy.cuts()).toBe(1)
        expect(reply).toBe(7)
        expect(yield* countOf(port, "lost")).toBe(7)
      }).pipe(Effect.scoped),
    )

    it.live("state and views stream a full value first, then patches in log order", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const call = yield* wire(port, "alice")
        const amounts = [1, 2, 3, 4, 5]
        const totals = [0, 1, 3, 6, 10, 15]
        const observed = yield* Effect.gen(function* () {
          const counter = yield* Counter.client("frames")
          const subscribed = yield* Deferred.make<void>()
          const frames = yield* call.state("frames").pipe(
            Stream.tap(() => Deferred.succeed(subscribed, undefined)),
            Stream.take(4),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const states = yield* counter.state.pipe(
            Stream.map((state) => state.count),
            Stream.takeUntil((count) => count === 15),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const doubled = yield* counter.doubled().pipe(
            Stream.takeUntil((value) => value === 30),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* Deferred.await(subscribed)
          for (const amount of amounts) yield* counter.add(amount)
          return {
            frames: yield* Fiber.join(frames),
            states: yield* Fiber.join(states),
            doubled: yield* Fiber.join(doubled),
          }
        }).pipe(as(port, "alice"))
        const kinds = observed.frames.map((frame) => frame.kind)
        const versions = observed.frames.map((frame) => frame.version)
        expect(kinds).toEqual(["Frame", "Patch", "Patch", "Patch"])
        expect(versions).toEqual([...versions].sort((left, right) => left - right))
        expect(new Set(versions).size).toBe(versions.length)
        for (const values of [observed.states, observed.doubled.map((value) => value / 2)]) {
          expect(values[0]).toBe(0)
          expect(values.at(-1)).toBe(15)
          expect(values.every((value) => totals.includes(value))).toBe(true)
          expect(values).toEqual([...values].sort((left, right) => left - right))
          expect(new Set(values).size).toBe(values.length)
        }
      }).pipe(Effect.scoped),
    )

    it.live(
      "streams resume after the connection drops, from a full value, without repeating one",
      () =>
        Effect.gen(function* () {
          const port = yield* serve({ auth: makeAuth().provider })
          const proxy = yield* lossyProxy(port)
          const values = yield* Effect.gen(function* () {
            const counter = yield* Counter.client("resume")
            const first = yield* Deferred.make<void>()
            const seen = yield* counter.state.pipe(
              Stream.map((state) => state.count),
              Stream.tap(() => Deferred.succeed(first, undefined)),
              Stream.takeUntil((count) => count === 5),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* Deferred.await(first)
            const opened = proxy.connections()
            proxy.sever()
            while (proxy.connections() === opened) yield* Effect.sleep("20 millis")
            yield* Effect.sleep("300 millis")
            yield* Effect.flatMap(Counter.client("resume"), (direct) => direct.add(5)).pipe(
              as(port, "alice"),
            )
            return yield* Fiber.join(seen)
          }).pipe(as(proxy.port, "alice"))
          expect(values).toEqual([0, 5])
        }).pipe(Effect.scoped),
    )

    it.live("join runs connect as the session's caller, and leaving runs disconnect", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const online = yield* Effect.gen(function* () {
          const counter = yield* Counter.client("presence")
          const during = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* counter.join({ name: "ana" })
              return yield* Stream.runHead(counter.state)
            }),
          )
          const after = yield* counter.state.pipe(
            Stream.filter((state) => Object.keys(state.online).length === 0),
            Stream.runHead,
          )
          return {
            during: Option.getOrThrow(during).online,
            after: Option.getOrThrow(after).online,
          }
        }).pipe(as(port, "ana"))
        expect(Object.values(online.during)).toEqual(["ana"])
        expect(online.after).toEqual({})
      }).pipe(Effect.scoped),
    )

    it.live("a dropped connection runs disconnect for the join it carried", () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider })
        const proxy = yield* lossyProxy(port)
        yield* Effect.gen(function* () {
          const counter = yield* Counter.client("dropped")
          yield* counter.join({ name: "ivy" })
          return yield* Effect.never
        }).pipe(as(proxy.port, "ivy"), Effect.forkScoped)
        const watch = (until: (online: Readonly<Record<string, string>>) => boolean) =>
          Effect.flatMap(Counter.client("dropped"), (counter) =>
            counter.state.pipe(
              Stream.map((state) => state.online),
              Stream.filter(until),
              Stream.runHead,
            ),
          ).pipe(Effect.map(Option.getOrThrow), as(port, "watcher"))
        const during = yield* watch((online) => Object.keys(online).length === 1)
        const [connection = ""] = Object.keys(during)
        proxy.sever()
        const after = yield* watch((online) => !(connection in online))
        expect(Object.values(during)).toEqual(["ivy"])
        expect(Object.keys(after)).not.toContain(connection)
      }).pipe(Effect.scoped),
    )

    it.live(
      "events reach a subscriber after the action, and lists read and watch their items",
      () =>
        Effect.gen(function* () {
          const port = yield* serve({ auth: makeAuth().provider })
          const seen = yield* Effect.gen(function* () {
            const counter = yield* Counter.client("events")
            const ready = yield* Deferred.make<void>()
            const events = yield* counter.added.pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.forkScoped,
            )
            const watched = yield* counter.entries.watch().pipe(
              Stream.tap(() => Deferred.succeed(ready, undefined)),
              Stream.map((items) => items.map((item) => item.amount)),
              Stream.takeUntil((amounts) => amounts.length === 2),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* Deferred.await(ready)
            yield* Effect.sleep("50 millis")
            yield* counter.add(4)
            yield* counter.add(6)
            return {
              events: yield* Fiber.join(events),
              watched: yield* Fiber.join(watched),
              range: (yield* counter.entries.range({ reverse: true })).map((item) => item.amount),
              found: yield* Counter.find({ where: { count: { gte: 10 } } }),
            }
          }).pipe(as(port, "alice"))
          expect(seen.events).toEqual([4, 6])
          expect(seen.watched[0]).toEqual([])
          expect(seen.watched.at(-1)).toEqual([4, 6])
          expect(seen.range).toEqual([6, 4])
          expect(seen.found).toEqual(["events"])
        }).pipe(Effect.scoped),
    )

    it.live("a revoked caller's session ends with access_denied and its streams stop", () =>
      Effect.gen(function* () {
        const { provider, control } = makeAuth()
        const port = yield* serve({ auth: provider, reauthorizeEvery: "300 millis" })
        const ended = yield* Effect.gen(function* () {
          const counter = yield* Counter.client("revoked")
          const first = yield* Deferred.make<void>()
          const stream = yield* counter.state.pipe(
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.runDrain,
            Effect.exit,
            Effect.forkScoped,
          )
          yield* Deferred.await(first)
          control.revoked.add("carol")
          const streamExit = yield* Fiber.join(stream)
          const callExit = yield* Effect.exit(counter.add(1))
          return { stream: failureOf(streamExit), call: failureOf(callExit) }
        }).pipe(as(port, "carol"))
        expect(ended.stream).toEqual(Unauthorized.make({ code: "access_denied" }))
        expect(ended.call).toHaveProperty("_tag", "Unauthorized")
        expect(yield* countOf(port, "revoked")).toBe(0)
      }).pipe(Effect.scoped),
    )

    it.live(
      "a session whose checks never succeed ends at its bound, and the client resumes on a new one",
      () =>
        Effect.gen(function* () {
          const { provider, control } = makeAuth()
          const port = yield* serve({ auth: provider, reauthorizeEvery: "300 millis" })
          const raw = yield* wire(port, "dave")
          const observed = yield* Effect.gen(function* () {
            const counter = yield* Counter.client("unavailable")
            const first = yield* Deferred.make<void>()
            const rawFirst = yield* Deferred.make<void>()
            const ended = yield* raw.state("unavailable").pipe(
              Stream.tap(() => Deferred.succeed(rawFirst, undefined)),
              Stream.runDrain,
              Effect.exit,
              Effect.forkScoped,
            )
            const seen = yield* counter.state.pipe(
              Stream.map((state) => state.count),
              Stream.tap(() => Deferred.succeed(first, undefined)),
              Stream.takeUntil((count) => count === 9),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* Deferred.await(first)
            yield* Deferred.await(rawFirst)
            control.unavailable = true
            const wireEnd = failureOf(yield* Fiber.join(ended))
            control.unavailable = false
            yield* counter.add(9)
            return { wireEnd, seen: yield* Fiber.join(seen) }
          }).pipe(as(port, "dave"))
          expect(observed.wireEnd).toEqual(
            Unauthorized.make({ code: "reauthorization_unavailable" }),
          )
          expect(observed.seen).toEqual([0, 9])
        }).pipe(Effect.scoped),
    )
  })
}

describe("session renewal over WebSocket", () => {
  it.live(
    "$reauthenticate moves a session to a fresh credential of its caller and refuses another caller",
    () =>
      Effect.gen(function* () {
        const { provider, control } = makeAuth()
        const port = yield* serve({ auth: provider, reauthorizeEvery: "300 millis" })
        const url = `ws://127.0.0.1:${port}/rpc`
        let token = "erin~1"
        const seen = yield* Effect.gen(function* () {
          const counter = yield* Counter.client("renewed")
          const first = yield* Deferred.make<void>()
          const counts = yield* counter.state.pipe(
            Stream.map((state) => state.count),
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.takeUntil((count) => count === 4),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* Deferred.await(first)
          token = "erin~2"
          yield* Effect.sleep("250 millis")
          control.revoked.add("erin~1")
          yield* Effect.sleep("700 millis")
          yield* counter.add(4)
          return yield* Fiber.join(counts)
        }).pipe(
          using(
            AkterClient.layer({
              url,
              actors: [Counter],
              authorization: Effect.sync(() => `Bearer ${token}`),
              reauthenticateEvery: "100 millis",
            }),
          ),
        )
        const raw = yield* wireAt(url, "Bearer erin~2")
        const foreign = yield* Effect.exit(raw.reauthenticate("Bearer mallory"))
        const after = yield* Effect.exit(
          raw.whoami("renewed", yield* CommandIds.mint(yield* Clock.currentTimeMillis)),
        )
        expect(seen).toEqual([0, 4])
        expect(failureOf(foreign)).toEqual(Unauthorized.make({ code: "access_denied" }))
        expect(failureOf(after)).toEqual(Unauthorized.make({ code: "access_denied" }))
      }).pipe(Effect.scoped),
  )
})

describe("refusals before the RPC handler", () => {
  it.live(
    "answer 401 without credentials and 403 for a foreign origin, on POST and the upgrade",
    () =>
      Effect.gen(function* () {
        const port = yield* serve({ auth: makeAuth().provider, origins: ["https://app.example"] })
        const request = (init: {
          method: string
          headers?: Record<string, string>
          body?: string
        }) => exchange(port, { ...init, path: "/rpc" })
        const upgrade = {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        }
        const anonymous = yield* request({ method: "POST", body: "" })
        const foreign = yield* request({
          method: "POST",
          headers: { origin: "https://evil.example", authorization: "Bearer alice" },
          body: "",
        })
        const foreignUpgrade = yield* request({
          method: "GET",
          headers: { ...upgrade, origin: "https://evil.example", authorization: "Bearer alice" },
        })
        const anonymousUpgrade = yield* request({ method: "GET", headers: upgrade })
        const configured = yield* request({
          method: "POST",
          headers: { origin: "https://app.example" },
          body: "",
        })
        expect(anonymous.status).toBe(401)
        const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
        const envelope = yield* parse(anonymous.body)
        expect(envelope).toHaveProperty("_tag", "ActorError")
        expect(envelope).toHaveProperty(["reason", "_tag"], "Unauthorized")
        expect(envelope).toHaveProperty(["reason", "code"], "missing_credentials")
        expect(envelope).toHaveProperty("isRetryable", false)
        expect(foreign.status).toBe(403)
        expect(foreignUpgrade.status).toBe(403)
        expect(anonymousUpgrade.status).toBe(401)
        expect(configured.status).toBe(401)
        const ready = yield* exchange(port, { method: "GET", path: "/ready" })
        expect(ready.status).toBe(200)
        expect(yield* parse(ready.body)).toEqual({ ready: true })
      }).pipe(Effect.scoped),
  )

  it.live("reach an HTTP client as the envelope's ActorError, never as a transport failure", () =>
    Effect.gen(function* () {
      const { provider, control } = makeAuth()
      const port = yield* serve({ auth: provider })
      control.revoked.add("eve")
      const exit = yield* Effect.flatMap(Counter.client("refused"), (counter) =>
        counter.add(1),
      ).pipe(
        using(
          AkterClient.layer({
            url: `http://127.0.0.1:${port}/rpc`,
            actors: [Counter],
            headers: { authorization: "Bearer eve" },
          }),
        ),
        Effect.exit,
      )
      expect(failureOf(exit)).toEqual(Unauthorized.make({ code: "invalid_credentials" }))
    }).pipe(Effect.scoped),
  )
})
