import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
} from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { SqlClient } from "effect/unstable/sql"
import { Actor, User } from "../../index.ts"
import { Unauthorized } from "../../errors/actor.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { type Authenticated, bearerToken } from "../../serve/auth.ts"
import { ClientWireMessage, SUBPROTOCOL, ServerWireMessage } from "../../serve/frames.ts"
import type { ServeOptions } from "../../serve/layer.ts"
import { ActorTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type { ConformanceCase, ConformanceEnvironment } from "../conformance.ts"

class Said extends Actor.Event<Said>()("Said", { text: Schema.String }) {}

class Hello extends Schema.TaggedClass<Hello>()("Hello", {
  name: Schema.String,
  resumed: Schema.Boolean,
}) {}

class Say extends Schema.TaggedClass<Say>()("Say", { text: Schema.String }) {}

class Banned extends Schema.TaggedError<Banned>()("Banned", { name: Schema.String }) {}

/** A member frame whose body looks like the holder's control message. */
const ForgedResync = Schema.TaggedStruct("Resync", { after: Schema.String })

const Chat = Actor.connection("Chat", {
  params: Schema.Struct({ name: Schema.String }),
  server: Schema.Union([Said, Hello]),
  client: Say,
  session: Schema.Struct({ name: Schema.String }),
  errors: [Banned],
})

const Blind = Actor.connection("Blind", { server: Said, stampCursor: false })

const Post = Actor.command("Post", { input: Schema.String })

/** The actor served over WebSocket; its short revocation bound keeps revocation cases fast. */
const SocketRoom = Actor.make("SocketRoom", {
  key: Schema.String,
  events: [Said],
  api: { Chat, Blind, Post },
  policy: { reauthorizeEvery: "2 seconds" },
})

export const transportsLayer = SocketRoom.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* (text: string) {
      const turn = yield* SocketRoom.Turn
      yield* turn.emit(Said.make({ text }))
      yield* turn.broadcast(Chat, Said.make({ text }))
      yield* turn.broadcast(Blind, Said.make({ text }))
    }),
    Chat: {
      open: Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
        const conn = yield* SocketRoom.Connection

        if (name === "mallory") return yield* Banned.make({ name })

        yield* conn.session.set({ name })
        yield* conn.send(Hello.make({ name, resumed: conn.resumed }))
      }),
      frame: Effect.fnUntraced(function* (frame: Say) {
        const conn = yield* SocketRoom.Connection
        const session = Option.getOrElse(yield* conn.session.get, () => ({ name: "" }))

        if (frame.text === "whoami")
          return yield* conn.send(Hello.make({ name: session.name, resumed: conn.resumed }))

        if (frame.text === "history") {
          for (const entry of yield* conn.events(Said, { after: undefined }).pipe(Effect.orDie))
            yield* conn.send(entry)

          return
        }

        yield* (yield* SocketRoom.get(conn.id)).Post(frame.text).pipe(Effect.orDie)
      }),
      resync: Effect.fnUntraced(function* ({ after }: { readonly after: string | undefined }) {
        const conn = yield* SocketRoom.Connection

        for (const entry of yield* conn.events(Said, { after }).pipe(Effect.orDie))
          yield* conn.send(entry)
      }),
    },
    Blind: { open: () => Effect.void, frame: () => Effect.void },
  }),
)

/**
 * `tenant:subject`, or `tenant:subject:expiresAtMs` for a credential with an
 * expiry, which the holder enforces on its own clock; `expired` is refused.
 * Read from `hello`, `reauthenticate`, or the upgrade's `authorization`.
 */
const tokens = Actor.auth.make((request) =>
  Effect.gen(function* () {
    const token = yield* bearerToken(request)

    if (token === "expired") return yield* Unauthorized.make({ code: "expired" })

    const match = /^([^:]+):([^:]+)(?::(\d+))?$/.exec(token)

    if (match === null) return yield* Unauthorized.make({ code: "invalid_credentials" })

    const authenticated: Authenticated = {
      tenant: match[1]!,
      caller: User.make({ subject: match[2]! }),
    }

    return match[3] === undefined
      ? authenticated
      : { ...authenticated, expiresAt: DateTime.makeUnsafe(Number(match[3])) }
  }),
)

/** Serves `SocketRoom` from a fresh listening server for the rest of the scope; returns its host. */
const serveSockets = Effect.fnUntraced(function* (
  environment: ConformanceEnvironment,
  options?: Partial<ServeOptions<never>>,
): Effect.fn.Return<string, never, InternalActors | Scope.Scope> {
  const context = yield* Effect.context<InternalActors>()

  const app = Actor.serve({
    actors: [SocketRoom],
    auth: tokens,
    basePath: "/api",
    ...options,
  }).pipe(Layer.provide(Layer.succeedContext(context)))

  const built = yield* Layer.build(
    HttpRouter.serve(app, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(environment.httpServer),
    ),
  )

  const address = Context.get(built, HttpServer.HttpServer).address

  if (Predicate.isTagged(address, "UnixPathAddress"))
    return yield* Effect.die(new Error("Expected a TCP address"))

  return `127.0.0.1:${address.port}`
})

const encodeClient = Schema.encodeEffect(Schema.fromJsonString(ClientWireMessage))

const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerWireMessage))

const encodeSay = Schema.encodeEffect(Schema.toCodecJson(Say))

const encodeForged = Schema.encodeEffect(Schema.toCodecJson(ForgedResync))

const decodeChatFrame = Schema.decodeUnknownEffect(Schema.toCodecJson(Chat.server))

const decodeBanned = Schema.decodeUnknownEffect(Schema.toCodecJson(Banned))

const WireReason = Schema.Struct({
  reason: Schema.Struct({
    _tag: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.String),
  }),
})

const decodeReason = Schema.decodeUnknownEffect(WireReason)

/** A client frame saying `text`, as the socket carries it. */
const say = (text: string) =>
  encodeSay(Say.make({ text })).pipe(
    Effect.orDie,
    Effect.map((frame): ClientWireMessage => ({ t: "frame", frame })),
  )

/** The member frame a server message carries, decoded with the member's schema. */
const frameOf = (message: ServerWireMessage | undefined) =>
  message?.t === "frame"
    ? decodeChatFrame(message.frame).pipe(Effect.orDie)
    : Effect.die(new Error(`Expected a frame, got ${message?.t}`))

/** The reason an `end` message's `ActorError` carries, without its `_tag` key. */
const endReason = (message: ServerWireMessage | undefined) =>
  message?.t === "end"
    ? decodeReason(message.error).pipe(
        Effect.orDie,
        Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code, cause: reason.cause })),
      )
    : Effect.die(new Error(`Expected end, got ${message?.t}`))

const opened = (message: ServerWireMessage | undefined) =>
  message?.t === "open"
    ? Effect.succeed(message)
    : Effect.die(new Error(`Expected open, got ${message?.t}`))

interface WireSocket {
  readonly send: (message: ClientWireMessage) => Effect.Effect<void>
  readonly sendRaw: (data: string | Uint8Array<ArrayBuffer>) => Effect.Effect<void>
  /** The next server message, failing the test if none arrives within `timeout`. */
  readonly next: (timeout?: number) => Effect.Effect<ServerWireMessage>
  /** The next server message within `timeout`, if one arrives. */
  readonly poll: (timeout: number) => Effect.Effect<Option.Option<ServerWireMessage>>
  /** Messages up to and including the first whose `t` is `t`. */
  readonly until: (
    t: ServerWireMessage["t"],
    timeout?: number,
  ) => Effect.Effect<ReadonlyArray<ServerWireMessage>>
  readonly closed: Effect.Effect<{ readonly code: number }>
  readonly close: Effect.Effect<void>
}

/** A client socket to a connection route, closed with the scope. */
const socket = (host: string, id: string, options?: { readonly member?: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<string>()
      const closed = yield* Deferred.make<{ readonly code: number }>()
      const ready = yield* Deferred.make<void>()

      const ws = new WebSocket(
        `ws://${host}/api/actors/SocketRoom/${id}/${options?.member ?? "Chat"}`,
        SUBPROTOCOL,
      )

      ws.onopen = () => Deferred.doneUnsafe(ready, Effect.void)
      ws.onmessage = (event) => Queue.offerUnsafe(received, String(event.data))

      ws.onclose = (event) => {
        Deferred.doneUnsafe(ready, Effect.void)
        Deferred.doneUnsafe(closed, Effect.succeed({ code: event.code }))
      }

      yield* Deferred.await(ready)

      const next = (timeout = 20_000) =>
        Queue.take(received).pipe(
          Effect.flatMap(decodeServer),
          Effect.orDie,
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.die(new Error("No socket message arrived")),
          }),
        )

      const wire: WireSocket = {
        send: (message) =>
          encodeClient(message).pipe(
            Effect.orDie,
            Effect.map((text) => ws.send(text)),
          ),
        sendRaw: (data) => Effect.sync(() => ws.send(data)),
        next,
        poll: (timeout) =>
          Queue.take(received).pipe(
            Effect.flatMap(decodeServer),
            Effect.orDie,
            Effect.timeoutOption(timeout),
          ),
        until: (t, timeout) =>
          Effect.gen(function* () {
            const seen: Array<ServerWireMessage> = []

            while (seen.at(-1)?.t !== t) seen.push(yield* next(timeout))

            return seen
          }),
        closed: Deferred.await(closed).pipe(
          Effect.timeoutOrElse({
            duration: 20_000,
            orElse: () => Effect.die(new Error("The socket did not close")),
          }),
        ),
        close: Effect.sync(() => ws.close(1000)),
      }

      return { wire, ws }
    }),
    ({ ws }) => Effect.sync(() => ws.close()),
  ).pipe(Effect.map(({ wire }) => wire))

/** The status a raw upgrade request is answered with, for upgrades the server refuses. */
const upgradeStatus = (host: string, id: string, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const [hostname, port] = host.split(":")
    const status = yield* Deferred.make<number>()
    const decoder = new TextDecoder()
    let received = ""

    const connection = yield* Effect.promise(() =>
      Bun.connect({
        hostname: hostname!,
        port: Number(port),
        socket: {
          data: (_socket, chunk) => {
            received += decoder.decode(chunk)
            const line = /^HTTP\/1\.1 (\d{3})/.exec(received)

            if (line !== null) Deferred.doneUnsafe(status, Effect.succeed(Number(line[1])))
          },
          close: () => {
            Deferred.doneUnsafe(status, Effect.succeed(0))
          },
        },
      }),
    )

    const lines = [
      `GET /api/actors/SocketRoom/${id}/Chat HTTP/1.1`,
      `Host: ${host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ]

    connection.write(`${lines.join("\r\n")}\r\n\r\n`)
    const answer = yield* Deferred.await(status)
    connection.end()

    return answer
  })

/**
 * A non-browser client that authenticates the upgrade request itself, spoken
 * over a raw TCP socket so it can send headers a browser's WebSocket can't.
 */
const headerSocket = (host: string, id: string, authorization: string) =>
  Effect.gen(function* () {
    const [hostname, port] = host.split(":")
    const upgraded = yield* Deferred.make<number>()
    const received = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<{ readonly code: number }>()
    const decoder = new TextDecoder()
    let pending = new Uint8Array(0)
    let handshake = true

    // Server frames are unmasked; this client reads text and close frames only.
    const read = (chunk: Uint8Array) => {
      const joined = new Uint8Array(pending.length + chunk.length)
      joined.set(pending)
      joined.set(chunk, pending.length)
      pending = joined

      if (handshake) {
        const text = decoder.decode(pending)
        const end = text.indexOf("\r\n\r\n")

        if (end === -1) return

        handshake = false
        Deferred.doneUnsafe(upgraded, Effect.succeed(Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1])))
        pending = pending.slice(new TextEncoder().encode(text.slice(0, end + 4)).length)
      }

      while (pending.length >= 2) {
        const opcode = pending[0]! & 0x0f
        const short = pending[1]! & 0x7f
        const offset = short === 126 ? 4 : 2
        const length = short === 126 ? (pending[2]! << 8) | pending[3]! : short

        if (pending.length < offset + length) return

        const payload = pending.slice(offset, offset + length)
        pending = pending.slice(offset + length)

        if (opcode === 1) Queue.offerUnsafe(received, decoder.decode(payload))

        if (opcode === 8)
          Deferred.doneUnsafe(closed, Effect.succeed({ code: (payload[0]! << 8) | payload[1]! }))
      }
    }

    const connection = yield* Effect.acquireRelease(
      Effect.promise(() =>
        Bun.connect({
          hostname: hostname!,
          port: Number(port),
          socket: {
            data: (_socket, chunk) => read(chunk),
            close: () => {
              Deferred.doneUnsafe(closed, Effect.succeed({ code: 1006 }))
            },
          },
        }),
      ),
      (open) => Effect.sync(() => open.end()),
    )

    connection.write(
      [
        `GET /api/actors/SocketRoom/${id}/Chat HTTP/1.1`,
        `Host: ${host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`,
        `Authorization: ${authorization}`,
      ].join("\r\n") + "\r\n\r\n",
    )

    const status = yield* Deferred.await(upgraded)

    // Client frames are masked; a zero mask keeps the payload as it is.
    const send = (message: ClientWireMessage) =>
      encodeClient(message).pipe(
        Effect.orDie,
        Effect.map((text) => {
          const payload = new TextEncoder().encode(text)

          const header =
            payload.length < 126
              ? [0x81, 0x80 | payload.length]
              : [0x81, 0xfe, payload.length >> 8, payload.length & 0xff]

          connection.write(new Uint8Array([...header, 0, 0, 0, 0, ...payload]))
        }),
      )

    const next = Queue.take(received).pipe(
      Effect.flatMap(decodeServer),
      Effect.orDie,
      Effect.timeoutOrElse({
        duration: 20_000,
        orElse: () => Effect.die(new Error("No socket message arrived")),
      }),
    )

    return { status, send, next, closed: Deferred.await(closed) }
  })

const rows = Effect.fnUntraced(function* (ref: ActorRef) {
  const sql = yield* SqlClient.SqlClient

  const [counts] = yield* sql<{ connections: number; generations: number }>`
    SELECT
      (SELECT count(*)::int FROM actor_connections WHERE tenant_id = ${ref.tenant}
        AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS connections,
      (SELECT count(*)::int FROM actor_generations WHERE tenant_id = ${ref.tenant}
        AND actor_type = ${ref.actor} AND actor_id = ${ref.id}) AS generations`

  return counts!
}, Effect.orDie)

const setup = (environment: ConformanceEnvironment, options?: Partial<ServeOptions<never>>) =>
  Effect.gen(function* () {
    const test = yield* ActorTest
    const host = yield* serveSockets(environment, options)

    return { test, host, token: (subject = "alice") => `Bearer ${test.tenant}:${subject}` }
  })

/** Says `hello` and reads through `open` and the open handler's greeting. */
const greet = (ws: WireSocket, authorization: string, name = "alice") =>
  Effect.gen(function* () {
    yield* ws.send({ t: "hello", authorization, params: { name } })
    const open = yield* opened((yield* ws.until("open")).at(-1))
    yield* ws.until("frame")

    return open
  })

export const transportsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "serves a connection over WebSocket: hello, open at its baseline, then member frames both ways with event cursors",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-open")
          yield* room.Post("before")
          const ws = yield* socket(host, "ws-open")
          yield* ws.send({ t: "hello", authorization: token(), params: { name: "alice" } })

          const open = yield* opened(yield* ws.next())
          expect(open.baseline).toBe("1")
          expect(open.reauthenticateBy).toBe(undefined)

          // The open handler's frame follows `open`, stamped with the flushed-through cursor.
          const greeting = yield* ws.next()
          expect(yield* frameOf(greeting)).toEqual(Hello.make({ name: "alice", resumed: false }))
          expect(greeting).toMatchObject({ cursor: "1" })

          // A client frame runs the handler, whose command's broadcast comes back stamped with
          // the flushed-through watermark it was sent above.
          yield* ws.send(yield* say("hi"))
          const hi = yield* ws.next()
          expect(yield* frameOf(hi)).toEqual(Said.make({ text: "hi" }))
          expect(hi).toMatchObject({ cursor: "1" })
          expect(Predicate.hasProperty(hi, "event")).toBe(false)

          // A command sent over HTTP (or in process) reaches the socket after it commits.
          yield* room.Post("live")
          const live = yield* ws.next()
          expect(yield* frameOf(live)).toEqual(Said.make({ text: "live" }))
          expect(live).toMatchObject({ cursor: "2" })

          // A frame sent from an event entry carries that event's own cursor to deduplicate on.
          yield* ws.send(yield* say("history"))
          const history = [yield* ws.next(), yield* ws.next(), yield* ws.next()]

          expect(
            history.map((message) => (message.t === "frame" ? message.event : undefined)),
          ).toEqual(["1", "2", "3"])
          expect((yield* rows(room.ref)).connections).toBe(1)

          // A client that closes its socket ends the session and its row goes.
          yield* ws.close
          expect((yield* ws.closed).code).toBe(1000)

          yield* Effect.gen(function* () {
            while ((yield* rows(room.ref)).connections > 0) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        }),
      ),
  },
  {
    name: "wakes nothing before hello authenticates, and ends with InvalidInput when hello does not arrive in 10 seconds",
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host } = yield* setup(environment)
          const ref = (yield* SocketRoom.get("ws-silent")).ref
          const ws = yield* socket(host, "ws-silent")

          // Upgraded but silent: no generation row, no connection row, no turn.
          yield* Effect.sleep("500 millis")
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })

          // A first message that isn't `hello` ends the session without waking anything.
          const early = yield* socket(host, "ws-silent")
          yield* early.send(yield* say("hi"))
          expect(yield* endReason(yield* early.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* early.closed).code).toBe(4400)

          expect(yield* endReason((yield* ws.until("end", 15_000)).at(-1))).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* ws.closed).code).toBe(4400)
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })
        }),
      ),
  },
  {
    name: "refuses upgrades from origins not listed, without the subprotocol, and past 1,000 sockets awaiting hello",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host } = yield* setup(environment, { origins: ["https://chat.example.com"] })
          const protocol = { "Sec-WebSocket-Protocol": SUBPROTOCOL }

          expect(
            yield* upgradeStatus(host, "ws-refused", {
              ...protocol,
              Origin: "https://evil.example",
            }),
          ).toBe(403)
          expect(
            yield* upgradeStatus(host, "ws-refused", {
              ...protocol,
              Origin: "https://chat.example.com",
            }),
          ).toBe(101)
          expect(yield* upgradeStatus(host, "ws-refused", {})).toBe(400)
          // The server selects the first offered subprotocol, so ours must come first.
          expect(
            yield* upgradeStatus(host, "ws-refused", {
              "Sec-WebSocket-Protocol": `chat, ${SUBPROTOCOL}`,
            }),
          ).toBe(400)
          // A bad upgrade credential is refused before the upgrade.
          expect(
            yield* upgradeStatus(host, "ws-refused", { ...protocol, Authorization: "Bearer nope" }),
          ).toBe(401)

          // Sockets that never say hello hold their places until their deadline.
          const silent = yield* Effect.forEach(
            Array.from({ length: 1_000 }, (_, index) => index),
            () => socket(host, "ws-crowd"),
            { concurrency: 50 },
          )

          expect(silent.length).toBe(1_000)
          expect(yield* upgradeStatus(host, "ws-crowd", protocol)).toBe(503)
          yield* Effect.forEach(silent, (ws) => ws.close, { discard: true })

          // Closed sockets free their places.
          yield* Effect.gen(function* () {
            while ((yield* upgradeStatus(host, "ws-crowd", protocol)) !== 101)
              yield* Effect.sleep("50 millis")
          }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        }),
      ),
  },
  {
    name: "authenticates hello or the upgrade, and ends a session whose upgrade and hello credentials name different callers",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          // No credential anywhere: Unauthorized before anything wakes.
          const missing = yield* socket(host, "ws-auth")
          yield* missing.send({ t: "hello", params: { name: "alice" } })
          expect(yield* endReason(yield* missing.next())).toMatchObject({
            tag: "Unauthorized",
            code: "missing_credentials",
          })
          expect((yield* missing.closed).code).toBe(1008)

          // A non-browser client authenticates the upgrade and sends a bare hello.
          const upgraded = yield* headerSocket(host, "ws-auth", token("bob"))
          expect(upgraded.status).toBe(101)
          yield* upgraded.send({ t: "hello", params: { name: "bob" } })
          expect((yield* upgraded.next).t).toBe("open")
          expect(yield* frameOf(yield* upgraded.next)).toEqual(
            Hello.make({ name: "bob", resumed: false }),
          )

          // Both credentials must name the same caller.
          const mixed = yield* headerSocket(host, "ws-auth", token("bob"))
          yield* mixed.send({
            t: "hello",
            authorization: token("carol"),
            params: { name: "carol" },
          })
          expect(yield* endReason(yield* mixed.next)).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
          expect((yield* mixed.closed).code).toBe(1008)

          // An expired credential in hello is refused with its code.
          const expired = yield* socket(host, "ws-auth")
          yield* expired.send({
            t: "hello",
            authorization: "Bearer expired",
            params: { name: "x" },
          })
          expect(yield* endReason(yield* expired.next())).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })

          // Undecodable params are InvalidInput, and a declared open failure is sent as itself.
          const bad = yield* socket(host, "ws-auth")
          yield* bad.send({ t: "hello", authorization: token(), params: { nom: "x" } })
          expect(yield* endReason(yield* bad.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* bad.closed).code).toBe(4400)

          const banned = yield* socket(host, "ws-auth")
          yield* banned.send({ t: "hello", authorization: token(), params: { name: "mallory" } })
          const refused = yield* banned.next()

          expect(
            refused.t === "end" ? yield* decodeBanned(refused.error).pipe(Effect.orDie) : refused,
          ).toEqual(Banned.make({ name: "mallory" }))
          expect((yield* banned.closed).code).toBe(4400)
        }),
      ),
  },
  {
    name: "keeps control messages in their own envelope: an unknown client t ends the session, and a member frame shaped like a control message is decoded as a member frame",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const forged = yield* socket(host, "ws-envelope")
          yield* greet(forged, token())
          // An unsolicited `resyncDone` is consumed by the holder and changes nothing.
          yield* forged.send({ t: "resyncDone", through: "99" })
          yield* forged.send(yield* say("whoami"))
          expect(yield* frameOf(yield* forged.next())).toEqual(
            Hello.make({ name: "alice", resumed: false }),
          )

          // A member frame that looks like the holder's control message is still a member frame.
          const resync = yield* encodeForged(ForgedResync.make({ after: "0" })).pipe(Effect.orDie)
          yield* forged.send({ t: "frame", frame: resync })
          expect(yield* endReason(yield* forged.next())).toMatchObject({
            tag: "InvalidInput",
            code: "decode",
          })
          expect((yield* forged.closed).code).toBe(4400)

          // A command never travels over the socket.
          const unknown = yield* socket(host, "ws-envelope")
          yield* greet(unknown, token())
          yield* unknown.sendRaw(`{"t":"command","member":"Post","input":"x"}`)
          expect(yield* endReason(yield* unknown.next())).toMatchObject({ tag: "InvalidInput" })
          expect((yield* unknown.closed).code).toBe(4400)

          // A second hello is not a message a session accepts.
          const again = yield* socket(host, "ws-envelope")
          yield* greet(again, token())
          yield* again.send({ t: "hello", authorization: token(), params: { name: "alice" } })
          expect(yield* endReason(yield* again.next())).toMatchObject({ tag: "InvalidInput" })
        }),
      ),
  },
  {
    name: "ends a session with SessionEnded Defect and close 1009 on a frame over 64 KiB, and closes a binary message with 1003",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const large = yield* socket(host, "ws-bounds")
          yield* greet(large, token())
          yield* large.send(yield* say("x".repeat(65_536)))
          expect(yield* endReason(yield* large.next())).toMatchObject({
            tag: "SessionEnded",
            cause: "Defect",
          })
          expect((yield* large.closed).code).toBe(1009)

          const binary = yield* socket(host, "ws-bounds")
          yield* greet(binary, token())
          yield* binary.sendRaw(new Uint8Array([1, 2, 3]))
          expect(yield* endReason(yield* binary.next())).toMatchObject({ tag: "InvalidInput" })
          expect((yield* binary.closed).code).toBe(1003)
        }),
      ),
  },
  {
    name: "reauthenticates a session before its credential expires, ends it with Unauthorized expired when the client doesn't answer, and ends a renewal for a different caller",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host } = yield* setup(environment)
          const holder = (yield* InternalActors).holder

          const expiring = (subject: string, ms: number) =>
            Effect.map(holder.now, (now) => `Bearer ${test.tenant}:${subject}:${now + ms}`)

          // Asked at half the credential's remaining life; a fresh one extends the session.
          const renewing = yield* socket(host, "ws-renew")
          const open = yield* greet(renewing, yield* expiring("alice", 3_000))
          expect(open.reauthenticateBy === undefined).toBe(false)
          expect((yield* renewing.until("reauthenticate", 5_000)).at(-1)).toMatchObject({
            by: open.reauthenticateBy,
          })

          const fresh = (yield* holder.now) + 120_000
          yield* renewing.send({
            t: "reauthenticate",
            authorization: `Bearer ${test.tenant}:alice:${fresh}`,
          })
          expect(yield* renewing.next()).toEqual({ t: "reauthenticated", by: fresh })

          // Past the old credential's expiry the session still delivers.
          yield* Effect.sleep("2 seconds")
          yield* renewing.send(yield* say("whoami"))
          expect(yield* frameOf(yield* renewing.next())).toEqual(
            Hello.make({ name: "alice", resumed: false }),
          )

          // Without an answer, the session ends at the credential's expiry.
          const silent = yield* socket(host, "ws-renew")
          yield* greet(silent, yield* expiring("alice", 2_000))
          expect(yield* endReason((yield* silent.until("end", 10_000)).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })
          expect((yield* silent.closed).code).toBe(1008)

          // A renewal for a different caller ends the session: identity never changes mid-session.
          const swapped = yield* socket(host, "ws-renew")
          yield* greet(swapped, yield* expiring("alice", 60_000))
          yield* swapped.send({
            t: "reauthenticate",
            authorization: `Bearer ${test.tenant}:mallory`,
          })
          expect(yield* endReason((yield* swapped.until("end")).at(-1))).toMatchObject({
            tag: "Unauthorized",
            code: "invalid_credentials",
          })
        }),
      ),
  },
  {
    name: "revokes a live and a parked WebSocket session within reauthorizeEvery",
    timeoutMs: 40_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-revoke")
          const live = yield* socket(host, "ws-revoke")
          yield* greet(live, token())
          const parked = yield* socket(host, "ws-revoke")
          yield* greet(parked, token("bob"), "bob")
          yield* test.hibernate(room.ref)

          fixture.denied.add("Chat")

          yield* Effect.gen(function* () {
            for (const ws of [live, parked]) {
              expect(yield* endReason((yield* ws.until("end", 10_000)).at(-1))).toMatchObject({
                tag: "Unauthorized",
                code: "access_denied",
              })
              expect((yield* ws.closed).code).toBe(1008)
            }
          }).pipe(Effect.ensuring(Effect.sync(() => fixture.denied.delete("Chat"))))
        }),
      ),
  },
  {
    name: "keeps a parked connection parked over a real socket, and a frame wakes its actor with the session restored",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-parked")
          const ws = yield* socket(host, "ws-parked")
          yield* greet(ws, token())

          yield* test.hibernate(room.ref)
          // Nothing arrives while parked, and the socket stays open.
          expect(yield* ws.poll(500)).toEqual(Option.none())

          yield* ws.send(yield* say("whoami"))
          expect(yield* frameOf(yield* ws.next())).toEqual(
            Hello.make({ name: "alice", resumed: true }),
          )

          // A command that wakes the actor reaches the parked socket too.
          yield* test.hibernate(room.ref)
          yield* room.Post("wake")
          expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "wake" }))
        }),
      ),
  },
  {
    name: "carries event cursors on frames, and omits every cursor under stampCursor: false",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-blind")
          yield* room.Post("first")

          const blind = yield* socket(host, "ws-blind", { member: "Blind" })
          yield* blind.send({ t: "hello", authorization: token() })
          const open = yield* opened(yield* blind.next())
          expect(open.baseline).toBe(undefined)

          const chat = yield* socket(host, "ws-blind")
          expect((yield* greet(chat, token())).baseline).toBe("1")

          yield* room.Post("second")
          const stamped = yield* chat.next()
          const bare = yield* blind.next()
          expect(yield* frameOf(stamped)).toEqual(Said.make({ text: "second" }))
          expect(stamped).toMatchObject({ cursor: "1" })
          expect(yield* frameOf(bare)).toEqual(Said.make({ text: "second" }))
          expect(Object.keys(bare).sort()).toEqual(["frame", "t"])
        }),
      ),
  },
  {
    name: "resyncs a WebSocket in place after its owner dies, and holds live frames until resyncDone",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const context = yield* Layer.build(
            ActorTest.cluster({
              database,
              runners: 2,
              shardLockExpiration: "3 seconds",
              actors: transportsLayer,
              as: User.make({ subject: "alice" }),
            }),
          )

          yield* Effect.gen(function* () {
            const cluster = yield* ActorCluster
            yield* cluster.ready

            // Runner 0 holds the socket; find an actor runner 1 owns.
            let target: ActorRef | undefined

            for (let index = 0; target === undefined && index < 200; index++) {
              const candidate = (yield* cluster.on(0)(SocketRoom.get(`ws-crash-${index}`))).ref

              if ((yield* cluster.owner(candidate)) === 1) target = candidate
            }

            if (target === undefined)
              return yield* Effect.die(new Error("Runner 1 owns no probed actor"))

            const ref = target

            const post = (text: string) =>
              cluster.on(0)(SocketRoom.get(ref.id).pipe(Effect.flatMap((room) => room.Post(text))))

            const host = yield* cluster.on(0)(serveSockets(environment))
            const ws = yield* socket(host, ref.id)
            yield* greet(ws, `Bearer ${ref.tenant}:alice`)

            yield* post("before")
            expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "before" }))

            yield* cluster.kill(1)

            // The holder keeps the socket and asks the client to resync from the last cursor it proved.
            expect(yield* ws.next(60_000)).toEqual({
              t: "resync",
              after: "1",
              reason: "OwnerLost",
              deadline: 30_000,
            })

            // The new owner's resync handler replays, then the holder says so.
            const replay = yield* ws.until("resyncReplayed", 60_000)
            expect(replay.at(-1)).toEqual({ t: "resyncReplayed" })
            expect(replay.filter((message) => message.t === "frame")).toEqual([])

            // A broadcast committed before the client acknowledges waits for it.
            yield* post("during")
            expect(yield* ws.poll(1_000)).toEqual(Option.none())

            yield* ws.send({ t: "resyncDone", through: "1" })
            expect(yield* frameOf(yield* ws.next())).toEqual(Said.make({ text: "during" }))
            yield* ws.send(yield* say("whoami"))
            expect(yield* frameOf(yield* ws.next())).toEqual(
              Hello.make({ name: "alice", resumed: true }),
            )
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
