import {
  type Cause,
  Context,
  flow,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"
import { SqlClient } from "effect/unstable/sql"
import { Actor, User } from "../../index.ts"
import { ActorError, TransportError, Unauthorized } from "../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../errors/events.ts"
import { InternalActors } from "../../handles/actors.ts"
import type { ActorRef } from "../../identity/caller.ts"
import { servedDefinitions } from "../../actor/served.ts"
import { socketSession } from "../../serve/sessions/socket.ts"
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

const socketLayer = SocketRoom.toLayer(
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

class Noted extends Actor.Event<Noted>()("Noted", { text: Schema.String }) {}

const Tell = Actor.command("Tell", { input: Schema.String })

const Note = Actor.command("Note", { input: Schema.String })

const Burst = Actor.command("Burst", { input: Schema.Int })

class Refused extends Schema.TaggedError<Refused>()("Refused", { at: Schema.Finite }) {}

/** `count` numbers, then its own end; a count over 100 is refused after the first element. */
const Count = Actor.stream("Count", {
  input: Schema.Finite,
  output: Schema.Finite,
  errors: [Refused],
})

/** Committed `Said` texts after `after`, then each new one as it commits. */
const Heard = Actor.stream("Heard", {
  input: Schema.Struct({ after: Schema.optional(Schema.String) }),
  output: Schema.String,
})

/** The actor served as an event feed: `Said` is served, `Noted` is declared but not a feed. */
const FeedRoom = Actor.make("FeedRoom", {
  key: Schema.String,
  events: [Said, Noted],
  feeds: [Said],
  api: { Tell, Note, Burst, Count, Heard },
  policy: { reauthorizeEvery: "2 seconds" },
})

const feedLayer = FeedRoom.toLayer(
  Effect.succeed({
    Tell: Effect.fnUntraced(function* (text: string) {
      yield* (yield* FeedRoom.Turn).emit(Said.make({ text }))
    }),
    Note: Effect.fnUntraced(function* (text: string) {
      yield* (yield* FeedRoom.Turn).emit(Noted.make({ text }))
    }),
    Count: (count: number) =>
      count > 100
        ? Stream.concat(Stream.make(1), Stream.fail(Refused.make({ at: 1 })))
        : Stream.range(1, count),
    Heard: ({ after }: { readonly after?: string | undefined }) =>
      Stream.unwrap(
        Effect.map(FeedRoom.Read, (read) =>
          read.follow(Said, { after }).pipe(Stream.map((entry) => entry.event.text)),
        ),
      ).pipe(Stream.orDie),
    Burst: Effect.fnUntraced(function* (count: number) {
      const turn = yield* FeedRoom.Turn

      for (let index = 0; index < count; index++)
        yield* turn.emit(Said.make({ text: `burst-${index}` }))
    }),
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
export const transportsLayer = Layer.mergeAll(socketLayer, feedLayer)

const serveSockets = Effect.fnUntraced(function* (
  environment: ConformanceEnvironment,
  options?: Partial<ServeOptions<never>>,
): Effect.fn.Return<string, never, InternalActors | Scope.Scope> {
  const context = yield* Effect.context<InternalActors>()

  const app = Actor.serve({
    actors: [SocketRoom, FeedRoom],
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

const ClientFailure = Schema.Union([ActorError, RetentionGap, UnknownCursor, Banned, Refused])

/** What a Promise client call or iteration rejected with, typed; anything else is a test defect. */
const asFailure = flow(
  Schema.decodeUnknownOption(ClientFailure),
  Option.getOrElse(() =>
    ActorError.make({ reason: TransportError.make({ code: "defect", retryable: false }) }),
  ),
)

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

interface SseMessage {
  readonly id: string | undefined
  readonly event: string | undefined
  readonly data: string
}

const FeedEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.toCodecJson(Said),
    commandId: Schema.String,
    timestamp: Schema.Finite,
  }),
)

const decodeEntry = Schema.decodeUnknownEffect(FeedEntry)

const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

/**
 * An event feed read over `fetch`, as the Promise client reads one: SSE
 * messages parsed from the body, comments skipped. Closed with the scope.
 */
const feed = (host: string, id: string, query: string, headers: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const client = Context.get(yield* Layer.build(FetchHttpClient.layer), HttpClient.HttpClient)

    const response = yield* client
      .execute(
        HttpClientRequest.get(`http://${host}/api/actors/FeedRoom/${id}/events?${query}`, {
          headers,
        }),
      )
      .pipe(Effect.orDie)

    const messages = yield* Queue.unbounded<SseMessage, Cause.Done>()

    if (response.status !== 200)
      return { status: response.status, body: yield* response.text.pipe(Effect.orDie), messages }

    let text = ""

    // Closing the scope interrupts the read, which aborts the request.
    yield* response.stream.pipe(
      Stream.decodeText,
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          text += chunk
          let end = text.indexOf("\n\n")

          while (end !== -1) {
            const block = text.slice(0, end)
            text = text.slice(end + 2)
            end = text.indexOf("\n\n")
            const fields = new Map<string, string>()

            for (const line of block.split("\n"))
              if (!line.startsWith(":")) {
                const colon = line.indexOf(":")
                fields.set(line.slice(0, colon), line.slice(colon + 2))
              }

            if (fields.has("data"))
              yield* Queue.offer(messages, {
                id: fields.get("id"),
                event: fields.get("event"),
                data: fields.get("data")!,
              })
          }
        }),
      ),
      Effect.ignore,
      Effect.andThen(Queue.end(messages)),
      Effect.forkScoped,
    )

    return { status: 200, body: "", messages }
  })

/** The next `count` feed messages, failing the test if they don't arrive in time. */
const take = (messages: Queue.Dequeue<SseMessage, Cause.Done>, count: number, timeout = 20_000) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    () =>
      Queue.take(messages).pipe(
        Effect.catch(() => Effect.die(new Error("The feed ended"))),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.die(new Error("No feed message arrived")),
        }),
      ),
  )

/** The `Said` text a feed message carries. */
const textOf = (message: SseMessage) =>
  decodeEntry(message.data).pipe(
    Effect.orDie,
    Effect.map((entry) => entry.event.text),
  )

/** The reason of a feed's `end` message or a refused feed's body, without its `_tag` key. */
const feedReason = (data: string) =>
  decodeBody(data).pipe(
    Effect.flatMap(decodeReason),
    Effect.orDie,
    Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code, cause: reason.cause })),
  )

const CursorBody = Schema.Struct({ _tag: Schema.String, cursor: Schema.String })

const cursorError = (body: string) =>
  decodeBody(body).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CursorBody)),
    Effect.orDie,
    Effect.map((error) => ({ tag: error._tag, cursor: error.cursor })),
  )

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
  {
    name: "serves an event feed: committed events after the cursor, then live ones, with no gap or repeat through a commit race",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-race")
          yield* room.Tell("one")
          yield* room.Note("not served")
          yield* room.Tell("two")

          // Commits race the open and its first read.
          const racing = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) => room.Tell(`race-${index}`),
            { concurrency: 4 },
          ).pipe(Effect.forkScoped)

          const opened = yield* feed(host, "sse-race", "event=Said&after=0", {
            authorization: token(),
          })

          expect(opened.status).toBe(200)
          yield* Fiber.join(racing)
          yield* room.Tell("live")

          const received = yield* take(opened.messages, 23)
          const cursors = received.map((message) => Number(message.id))

          // Every Said event once, in cursor order; the Noted event between them is not served.
          expect(cursors).toEqual([...cursors].sort((left, right) => left - right))
          expect(new Set(cursors).size).toBe(23)
          expect(cursors.includes(2)).toBe(false)
          expect(received.every((message) => message.event === "Said")).toBe(true)
          expect(yield* textOf(received[0]!)).toBe("one")
          expect(yield* textOf(received.at(-1)!)).toBe("live")
          const entry = yield* decodeEntry(received[0]!.data).pipe(Effect.orDie)
          expect(entry.commandId.startsWith("v1.")).toBe(true)
        }),
      ),
  },
  {
    name: "resumes a feed from Last-Event-ID with no gap or repeat, and answers UnknownCursor and RetentionGap before streaming",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-resume")

          for (const text of ["a", "b", "c", "d"]) yield* room.Tell(text)

          const after = yield* feed(host, "sse-resume", "event=Said&after=2", {
            authorization: token(),
          })

          expect((yield* take(after.messages, 2)).map((message) => message.id)).toEqual(["3", "4"])

          // Last-Event-ID overrides `after`, as a browser's own reconnect sends it.
          const resumed = yield* feed(host, "sse-resume", "event=Said&after=0", {
            authorization: token(),
            "last-event-id": "3",
          })

          expect((yield* take(resumed.messages, 1)).map((message) => message.id)).toEqual(["4"])

          const future = yield* feed(host, "sse-resume", "event=Said&after=99", {
            authorization: token(),
          })

          expect(future.status).toBe(404)
          expect(yield* cursorError(future.body)).toEqual({ tag: "UnknownCursor", cursor: "99" })

          const malformed = yield* feed(host, "sse-resume", "event=Said&after=abc", {
            authorization: token(),
          })

          expect(malformed.status).toBe(404)

          // Pruning removes a prefix; a cursor before it can't resume without a gap.
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_events WHERE tenant_id = ${room.ref.tenant}
            AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id} AND sequence <= 2`.pipe(
            Effect.orDie,
          )

          const pruned = yield* feed(host, "sse-resume", "event=Said&after=1", {
            authorization: token(),
          })

          expect(pruned.status).toBe(410)
          expect(yield* cursorError(pruned.body)).toEqual({ tag: "RetentionGap", cursor: "1" })

          const kept = yield* feed(host, "sse-resume", "event=Said&after=2", {
            authorization: token(),
          })

          expect((yield* take(kept.messages, 2)).map((message) => message.id)).toEqual(["3", "4"])
        }),
      ),
  },
  {
    name: "answers a feed for a never-created actor with 404 NotCreated and writes no row, and refuses undeclared, missing, and too many event filters",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const headers = { authorization: token() }
          const ref = (yield* FeedRoom.get("sse-nobody")).ref

          const missing = yield* feed(host, "sse-nobody", "event=Said", headers)
          expect(missing.status).toBe(404)
          expect(yield* feedReason(missing.body)).toMatchObject({ tag: "NotCreated" })
          expect(yield* rows(ref)).toEqual({ connections: 0, generations: 0 })

          yield* (yield* FeedRoom.get("sse-filters")).Tell("x")

          for (const query of ["event=Noted", "event=Nope", "after=0"]) {
            const refused = yield* feed(host, "sse-filters", query, headers)
            expect(refused.status).toBe(404)
            expect(yield* feedReason(refused.body)).toMatchObject({
              tag: "InvalidInput",
              code: "unknown_event",
            })
          }

          const many = Array.from({ length: 17 }, () => "event=Said").join("&")
          expect((yield* feed(host, "sse-filters", many, headers)).status).toBe(200)

          const distinct = Array.from({ length: 17 }, (_, index) => `event=E${index}`).join("&")
          const tooMany = yield* feed(host, "sse-filters", distinct, headers)
          expect(tooMany.status).toBe(400)
          expect(yield* feedReason(tooMany.body)).toMatchObject({ code: "too_many_filters" })

          // Unauthenticated feeds run nothing.
          const anonymous = yield* feed(host, "sse-filters", "event=Said", {})
          expect(anonymous.status).toBe(401)
        }),
      ),
  },
  {
    name: "authorizes a feed per event tag before reading, and revokes a live feed within reauthorizeEvery",
    timeoutMs: 40_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-revoke")
          yield* room.Tell("before")

          yield* Effect.gen(function* () {
            // `authorize` sees the event tag as the command of a feed.
            fixture.denied.add("Said")

            const refused = yield* feed(host, "sse-revoke", "event=Said", {
              authorization: token(),
            })

            expect(refused.status).toBe(403)
            expect(yield* feedReason(refused.body)).toMatchObject({
              tag: "Unauthorized",
              code: "access_denied",
            })
            fixture.denied.delete("Said")

            const live = yield* feed(host, "sse-revoke", "event=Said", { authorization: token() })
            expect(yield* textOf((yield* take(live.messages, 1))[0]!)).toBe("before")
            fixture.denied.add("Said")

            const [ended] = yield* take(live.messages, 1, 10_000)
            expect(ended!.event).toBe("end")
            expect(yield* feedReason(ended!.data)).toMatchObject({
              tag: "Unauthorized",
              code: "access_denied",
            })
          }).pipe(Effect.ensuring(Effect.sync(() => fixture.denied.delete("Said"))))
        }),
      ),
  },
  {
    name: "ends a feed at its credential's expiry with Unauthorized expired, and a reconnect from its last cursor loses nothing",
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const holder = (yield* InternalActors).holder
          const room = yield* FeedRoom.get("sse-expiry")
          yield* room.Tell("first")

          const expiring = `Bearer ${test.tenant}:alice:${(yield* holder.now) + 1_500}`
          const opened = yield* feed(host, "sse-expiry", "event=Said", { authorization: expiring })
          const [first] = yield* take(opened.messages, 1)

          const [ended] = yield* take(opened.messages, 1, 10_000)
          expect(ended!.event).toBe("end")
          expect(yield* feedReason(ended!.data)).toMatchObject({
            tag: "Unauthorized",
            code: "expired",
          })

          // Committed while the client was away; the reconnect resumes after its last cursor.
          yield* room.Tell("while away")

          const again = yield* feed(host, "sse-expiry", "event=Said", {
            authorization: token(),
            "last-event-id": first!.id!,
          })

          expect(yield* textOf((yield* take(again.messages, 1))[0]!)).toBe("while away")
        }),
      ),
  },
  {
    name: "keeps an idle feed parked, and delivers an event committed by a command that woke its actor",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-parked")
          yield* room.Tell("before")
          const opened = yield* feed(host, "sse-parked", "event=Said", { authorization: token() })
          yield* take(opened.messages, 1)

          yield* test.hibernate(room.ref)
          yield* room.Tell("woken")
          expect(yield* textOf((yield* take(opened.messages, 1))[0]!)).toBe("woken")
        }),
      ),
  },
  {
    name: "catches a lagging feed up from actor_events instead of ending it with SlowConsumer",
    timeoutMs: 60_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("sse-lag")
          yield* room.Tell("first")
          const opened = yield* feed(host, "sse-lag", "event=Said", { authorization: token() })
          yield* take(opened.messages, 1)

          // One turn's 1,100 frames overflow the holder's 1,024-frame buffer at once.
          yield* room.Burst(1_100)

          const received = yield* take(opened.messages, 1_100)
          expect(received.map((message) => Number(message.id))).toEqual(
            Array.from({ length: 1_100 }, (_, index) => index + 2),
          )
          expect(received.every((message) => message.event === "Said")).toBe(true)
        }),
      ),
  },
  {
    name: "resyncs a feed at its holder after an owner kill with no client-visible gap",
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
            let target: ActorRef | undefined

            for (let index = 0; target === undefined && index < 200; index++) {
              const candidate = (yield* cluster.on(0)(FeedRoom.get(`sse-crash-${index}`))).ref

              if ((yield* cluster.owner(candidate)) === 1) target = candidate
            }

            if (target === undefined)
              return yield* Effect.die(new Error("Runner 1 owns no probed actor"))

            const ref = target

            const tell = (text: string) =>
              cluster.on(0)(FeedRoom.get(ref.id).pipe(Effect.flatMap((room) => room.Tell(text))))

            yield* tell("before")
            const host = yield* cluster.on(0)(serveSockets(environment))

            const opened = yield* feed(host, ref.id, "event=Said", {
              authorization: `Bearer ${ref.tenant}:alice`,
            })

            expect(yield* textOf((yield* take(opened.messages, 1))[0]!)).toBe("before")

            yield* cluster.kill(1)
            yield* tell("after")

            // No control message reaches the client: the next message is the next event.
            const [next] = yield* take(opened.messages, 1, 60_000)
            expect(next!.id).toBe("2")
            expect(yield* textOf(next!)).toBe("after")
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
  {
    name: "client reads an event feed as an AsyncIterable and resumes from its cursor after the response drops",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("client-feed")
          yield* room.Tell("one")
          yield* room.Tell("two")
          const requests: Array<string | null> = []
          const send = yield* FetchHttpClient.Fetch
          let dropped = false

          // The first feed response is cut after its first event, as a lost connection would be.
          const flaky = (input: RequestInfo | URL, init?: RequestInit) =>
            send(input, init).then((response) => {
              requests.push(new Headers(init?.headers).get("last-event-id"))

              if (dropped || response.body === null) return response

              dropped = true
              const reader = response.body.getReader()

              const cut = new ReadableStream<Uint8Array>({
                pull: (controller) =>
                  reader.read().then((chunk) => {
                    if (chunk.done) return controller.close()

                    const text = new TextDecoder().decode(chunk.value)
                    const end = text.indexOf("\n\n")

                    if (end === -1) return controller.enqueue(chunk.value)

                    // Only the first complete message gets through.
                    controller.enqueue(new TextEncoder().encode(text.slice(0, end + 2)))
                    void reader.cancel()
                    controller.error(new Error("connection lost"))
                  }),
              })

              return new Response(cut, { status: response.status, headers: response.headers })
            })

          const handle = FeedRoom.client({
            baseUrl: `http://${host}/api`,
            headers: () => ({ authorization: token() }),
            fetch: flaky,
          }).get("client-feed")

          const iterated = Stream.fromAsyncIterable(handle.events(Said), asFailure).pipe(
            Stream.map((entry) => `${entry.cursor}:${entry.event.text}`),
          )

          const [first, second] = yield* iterated.pipe(Stream.take(2), Stream.runCollect)

          // A later event reaches a new iteration from the cursor it resumes after.
          const resumed = FeedRoom.client({
            baseUrl: `http://${host}/api`,
            headers: { authorization: token() },
          })
            .get("client-feed")
            .events(Said, { after: "2" })

          yield* room.Tell("three")

          const [third] = yield* Stream.fromAsyncIterable(resumed, asFailure).pipe(
            Stream.map((entry) => `${entry.cursor}:${entry.event.text}`),
            Stream.take(1),
            Stream.runCollect,
          )

          const received = [first, second, third]
          expect(received).toEqual(["1:one", "2:two", "3:three"])
          // The reopened request resumed after the one event it had delivered.
          expect(requests.slice(0, 2)).toEqual([null, "1"])
        }),
      ),
  },
  {
    name: "client feed reopens with fresh headers when its credential expires, and loses nothing",
    timeoutMs: 40_000,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { test, host } = yield* setup(environment)
          const holder = (yield* InternalActors).holder
          const room = yield* FeedRoom.get("client-expiry")
          yield* room.Tell("before")
          const send = yield* FetchHttpClient.Fetch
          const services = yield* Effect.context<never>()
          let opened = 0

          // Each request carries a fresh credential that expires 1.5 seconds later.
          const handle = FeedRoom.client({
            baseUrl: `http://${host}/api`,
            headers: () =>
              Effect.runPromiseWith(services)(
                Effect.map(holder.now, (now) => ({
                  authorization: `Bearer ${test.tenant}:alice:${now + 1_500}`,
                })),
              ),
            fetch: (input, init) =>
              send(input, init).then((response) => {
                if (response.ok) opened += 1

                return response
              }),
          }).get("client-expiry")

          const entries = Stream.fromAsyncIterable(handle.events(Said), asFailure).pipe(
            Stream.map((entry) => entry.event.text),
          )

          const received = yield* entries.pipe(
            Stream.tap((text) =>
              text === "before"
                ? Effect.sleep("2500 millis").pipe(Effect.andThen(room.Tell("after expiry")))
                : Effect.void,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("20 seconds"),
            Effect.orDie,
          )

          expect([...received]).toEqual(["before", "after expiry"])
          expect(opened).toBe(2)
        }),
      ),
  },
  {
    name: "client feed fails with RetentionGap for a pruned cursor and UnknownCursor for one never issued",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("client-gap")
          yield* room.Tell("a")
          yield* room.Tell("b")
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM actor_events WHERE tenant_id = ${room.ref.tenant}
            AND actor_type = ${room.ref.actor} AND actor_id = ${room.ref.id} AND sequence = 1`.pipe(
            Effect.orDie,
          )

          const handle = FeedRoom.client({
            baseUrl: `http://${host}/api`,
            headers: { authorization: token() },
          }).get("client-gap")

          const first = (after: string) =>
            Stream.fromAsyncIterable(handle.events(Said, { after }), asFailure).pipe(
              Stream.runHead,
              Effect.flip,
            )

          expect(yield* first("0")).toBeInstanceOf(RetentionGap)
          expect(yield* first("99")).toBeInstanceOf(UnknownCursor)
        }),
      ),
  },
  {
    name: "client opens a connection with typed frames both ways, rejects a declared open failure as its class, and ends on close",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)

          const handle = SocketRoom.client({
            baseUrl: `http://${host}/api`,
            headers: () => ({ authorization: token() }),
          }).get("client-socket")

          const refused = yield* Effect.tryPromise({
            try: () => handle.Chat.connect({ name: "mallory" }),
            catch: asFailure,
          }).pipe(Effect.flip)

          expect(refused).toBeInstanceOf(Banned)

          const connection = yield* Effect.promise(() => handle.Chat.connect({ name: "alice" }))
          expect(connection.cursor).toBe("0")
          const iterator = connection.frames[Symbol.asyncIterator]()
          const next = Effect.promise(() => iterator.next())

          expect((yield* next).value).toEqual(Hello.make({ name: "alice", resumed: false }))
          yield* Effect.promise(() => connection.send(Say.make({ text: "hi" })))
          expect((yield* next).value).toEqual(Said.make({ text: "hi" }))
          yield* Effect.promise(() => connection.close())
          expect((yield* next).done).toBe(true)
        }),
      ),
  },
  {
    name: "client resyncs a connection in place after its owner dies: onResync runs, then live frames resume without duplicates",
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
            let target: ActorRef | undefined

            for (let index = 0; target === undefined && index < 200; index++) {
              const candidate = (yield* cluster.on(0)(SocketRoom.get(`client-crash-${index}`))).ref

              if ((yield* cluster.owner(candidate)) === 1) target = candidate
            }

            if (target === undefined)
              return yield* Effect.die(new Error("Runner 1 owns no probed actor"))

            const ref = target

            const post = (text: string) =>
              cluster.on(0)(SocketRoom.get(ref.id).pipe(Effect.flatMap((room) => room.Post(text))))

            const host = yield* cluster.on(0)(serveSockets(environment))
            const resyncs: Array<string | undefined> = []

            const handle = SocketRoom.client({
              baseUrl: `http://${host}/api`,
              headers: { authorization: `Bearer ${ref.tenant}:alice` },
            }).get(ref.id)

            const connection = yield* Effect.promise(() =>
              handle.Chat.connect(
                { name: "alice" },
                {
                  // A callback that throws still lets the resync be acknowledged.
                  onResync: ({ after }) => {
                    resyncs.push(after)
                    throw new Error("the page failed to reload")
                  },
                },
              ),
            )

            const iterator = connection.messages[Symbol.asyncIterator]()

            const next = Effect.promise(() => iterator.next()).pipe(
              Effect.map((result) => (result.done === true ? undefined : result.value)),
              Effect.timeoutOrElse({
                duration: "60 seconds",
                orElse: () => Effect.die(new Error("No connection message arrived")),
              }),
            )

            // Each message as its tag and what it carries, for comparison.
            const seen = next.pipe(
              Effect.map((message) =>
                message === undefined
                  ? undefined
                  : Predicate.isTagged(message, "Frame")
                    ? { tag: message._tag, frame: message.frame }
                    : Predicate.isTagged(message, "Resync")
                      ? { tag: message._tag, after: message.after, reason: message.reason }
                      : { tag: message._tag },
              ),
            )

            expect((yield* seen)?.tag).toBe("Frame")
            yield* post("before")
            expect(yield* seen).toEqual({ tag: "Frame", frame: Said.make({ text: "before" }) })

            yield* cluster.kill(1)
            expect(yield* seen).toEqual({ tag: "Resync", after: "1", reason: "OwnerLost" })

            // The member's resync handler replays nothing new; the replay is reported, and the client acknowledged it.
            expect(yield* seen).toEqual({ tag: "ResyncReplayed" })
            yield* post("after")
            expect(yield* seen).toEqual({ tag: "Frame", frame: Said.make({ text: "after" }) })
            expect(resyncs).toEqual(["1"])
            yield* Effect.promise(() => connection.close())
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
  {
    name: "ends a WebSocket session whose socket can no longer be written, and deletes its row",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const test = yield* ActorTest
          const actors = yield* InternalActors
          const ref = (yield* SocketRoom.get("ws-unwritable")).ref

          const hello = yield* encodeClient({ t: "hello", params: { name: "alice" } }).pipe(
            Effect.orDie,
          )

          let pulled = false
          let writes = 0

          // A half-open peer: `hello` arrives, then nothing, and the first frame after `open` can't be written.
          const socket = Socket.make({
            reader: Effect.succeed({
              pull: Effect.suspend(() => {
                if (pulled) return Effect.never

                pulled = true

                return Effect.succeed([hello] as const)
              }),
              upgrade: () => Effect.void,
            }),
            writer: Effect.succeed({
              write: () =>
                Effect.suspend(() => {
                  writes += 1

                  return writes > 1
                    ? Effect.fail(
                        Socket.SocketError.make({
                          reason: Socket.SocketWriteError.make({ cause: new Error("peer gone") }),
                        }),
                      )
                    : Effect.void
                }),
              writeAll: () => Effect.void,
            }),
          })

          const principal = { tenant: test.tenant, caller: User.make({ subject: "alice" }) }

          yield* socketSession({
            socket,
            connection: servedDefinitions
              .get(SocketRoom)!
              .connections.find((connection) => connection.tag === Chat.tag)!,
            holder: actors.holder,
            ref: () => ref,
            upgrade: principal,
            authenticate: () => Effect.succeed(principal),
            greeted: Effect.void,
          }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.orDie)

          expect(writes).toBe(2)

          yield* Effect.gen(function* () {
            while ((yield* rows(ref)).connections > 0) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        }),
      ),
  },
  {
    name: "serves a stream over SSE: element messages, then end, with a declared failure in its end message",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          yield* (yield* FeedRoom.get("sse-stream")).Tell("x")

          const client = Context.get(
            yield* Layer.build(FetchHttpClient.layer),
            HttpClient.HttpClient,
          )

          const subscribe = (body: string) =>
            client
              .execute(
                HttpClientRequest.post(`http://${host}/api/actors/FeedRoom/sse-stream/Count`, {
                  headers: { authorization: token(), accept: "text/event-stream" },
                }).pipe(HttpClientRequest.bodyText(body, "application/json")),
              )
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.orDie,
              )

          expect(yield* subscribe("3")).toBe(
            "event: element\ndata: 1\n\nevent: element\ndata: 2\n\nevent: element\ndata: 3\n\nevent: end\ndata: null\n\n",
          )
          expect(yield* subscribe("101")).toBe(
            'event: element\ndata: 1\n\nevent: end\ndata: {"_tag":"Refused","at":1}\n\n',
          )
        }),
      ),
  },
  {
    name: "client subscribes to a stream as an AsyncIterable, and gets its declared failure as its class",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* FeedRoom.get("client-stream")
          yield* room.Tell("one")

          const handle = FeedRoom.client({
            baseUrl: `http://${host}/api`,
            headers: { authorization: token() },
          }).get("client-stream")

          const counted = yield* Stream.fromAsyncIterable(handle.Count(3), asFailure).pipe(
            Stream.runCollect,
          )

          expect([...counted]).toEqual([1, 2, 3])

          const refused = yield* Stream.fromAsyncIterable(handle.Count(101), asFailure).pipe(
            Stream.runDrain,
            Effect.flip,
          )

          expect(refused).toBeInstanceOf(Refused)

          // A live stream: the committed text, then one committed while subscribed.
          const heard = yield* Stream.fromAsyncIterable(handle.Heard({}), asFailure).pipe(
            Stream.tap((text) => (text === "one" ? room.Tell("two") : Effect.void)),
            Stream.take(2),
            Stream.runCollect,
            Effect.timeout("20 seconds"),
            Effect.orDie,
          )

          expect([...heard]).toEqual(["one", "two"])
        }),
      ),
  },
]
