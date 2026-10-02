import {
  Context,
  flow,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  type Scope,
} from "effect"
import { FetchHttpClient, HttpClient, HttpRouter, HttpServer } from "effect/http"
import { ActorError, TransportError } from "../../../errors/actor.ts"
import { RetentionGap, UnknownCursor } from "../../../errors/events.ts"
import { InternalActors } from "../../../runtime/actors.ts"
import type { RuntimeControl } from "../../../runtime/drain.ts"
import { ClientWireMessage, SUBPROTOCOL, ServerWireMessage } from "../../../protocol/frames.ts"
import { serve, type ServeOptions } from "../../../serve/layer.ts"
import type { ConformanceEnvironment } from "../../conformance.ts"
import { Banned, Chat, FeedRoom, ForgedResync, Refused, Say, SocketRoom, tokens } from "./actors.ts"

/**
 * Serves `SocketRoom` and `FeedRoom` from a fresh listening server for the
 * rest of the scope; returns its host. A provider may fetch over HTTP.
 */
export const serveSockets = Effect.fnUntraced(function* (
  environment: ConformanceEnvironment,
  options?: Partial<ServeOptions<HttpClient.HttpClient>>,
): Effect.fn.Return<string, never, InternalActors | RuntimeControl | Scope.Scope> {
  const context = yield* Effect.context<InternalActors | RuntimeControl>()

  const app = serve({
    actors: [SocketRoom, FeedRoom],
    auth: tokens,
    basePath: "/api",
    ...options,
  }).pipe(Layer.provide(Layer.succeedContext(context)), Layer.provide(FetchHttpClient.layer))

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

export const encodeClient = Schema.encodeEffect(Schema.fromJsonString(ClientWireMessage))

const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerWireMessage))

const encodeSay = Schema.encodeEffect(Schema.toCodecJson(Say))

export const encodeForged = Schema.encodeEffect(Schema.toCodecJson(ForgedResync))

const decodeChatFrame = Schema.decodeUnknownEffect(Schema.toCodecJson(Chat.server))

export const decodeBanned = Schema.decodeUnknownEffect(Schema.toCodecJson(Banned))

const WireReason = Schema.Struct({
  reason: Schema.Struct({
    _tag: Schema.String,
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.String),
  }),
})

export const decodeReason = Schema.decodeUnknownEffect(WireReason)

const ClientFailure = Schema.Union([ActorError, RetentionGap, UnknownCursor, Banned, Refused])

/** What a Promise client call or iteration rejected with, typed; anything else is a test defect. */
export const asFailure = flow(
  Schema.decodeUnknownOption(ClientFailure),
  Option.getOrElse(() =>
    ActorError.make({ reason: TransportError.make({ code: "defect", retryable: false }) }),
  ),
)

/** A client frame saying `text`, as the socket carries it. */
export const say = (text: string) =>
  encodeSay(Say.make({ text })).pipe(
    Effect.orDie,
    Effect.map((frame): ClientWireMessage => ({ t: "frame", frame })),
  )

/** The member frame a server message carries, decoded with the member's schema. */
export const frameOf = (message: ServerWireMessage | undefined) =>
  message?.t === "frame"
    ? decodeChatFrame(message.frame).pipe(Effect.orDie)
    : Effect.die(new Error(`Expected a frame, got ${message?.t}`))

/** The reason an `end` message's `ActorError` carries, without its `_tag` key. */
export const endReason = (message: ServerWireMessage | undefined) =>
  message?.t === "end"
    ? decodeReason(message.error).pipe(
        Effect.orDie,
        Effect.map(({ reason }) => ({ tag: reason._tag, code: reason.code, cause: reason.cause })),
      )
    : Effect.die(new Error(`Expected end, got ${message?.t}`))

export const opened = (message: ServerWireMessage | undefined) =>
  message?.t === "open"
    ? Effect.succeed(message)
    : Effect.die(new Error(`Expected open, got ${message?.t}`))

export interface WireSocket {
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
export const socket = Effect.fnUntraced(function* (
  host: string,
  id: string,
  options?: { readonly member?: string },
) {
  return yield* Effect.acquireRelease(
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
})

/** The status a raw upgrade request is answered with, for upgrades the server refuses. */
export const upgradeStatus = (
  host: string,
  id: string,
  headers: Readonly<Record<string, string>>,
) =>
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
export const headerSocket = (host: string, id: string, authorization: string) =>
  Effect.gen(function* () {
    const [hostname, port] = host.split(":")
    const upgraded = yield* Deferred.make<number>()
    const received = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<{ readonly code: number }>()
    const decoder = new TextDecoder()
    let pending = new Uint8Array(0)
    let handshake = true

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
