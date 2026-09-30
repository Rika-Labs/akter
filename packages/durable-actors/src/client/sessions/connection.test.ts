import { Effect, Predicate, Schedule, Schema, Stream } from "effect"
import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { ActorError, RunnerAtCapacity, TransportError } from "../../errors/actor.ts"
import { Actor } from "../../index.ts"
import { SUBPROTOCOL, type ServerWireMessage } from "../../serve/frames.ts"
import { socketUrl } from "../make.ts"
import type { ConnectionMessage, ProgressMessage, ProgressOfConnection } from "./connection.ts"

const Live = Actor.connection("Live", { client: Schema.String, server: Schema.String })

const Room = Actor.make("ConnectionClientRoom", { key: Schema.String, api: { Live } })

class Render extends Actor.effect<Render>()("Render", {
  input: { steps: Schema.Int },
  progress: Schema.Struct({ percent: Schema.Finite }),
}) {}

class Scan extends Actor.effect<Scan>()("Scan", {
  progress: Schema.Struct({ found: Schema.Int, path: Schema.String }),
}) {}

const Watch = Actor.connection("Watch", {
  server: Schema.String,
  client: Schema.Finite,
  progress: { effects: [Render, Scan] },
})

const Jobs = Actor.make("ConnectionProgressRoom", {
  key: Schema.String,
  effects: [Render, Scan],
  api: { Live, Watch },
})

type Script = (send: (message: ServerWireMessage) => void, raw: (text: string) => void) => void

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true)
})

/**
 * A WebSocket server that answers `hello` with `open` and then runs `script`,
 * standing in for a server or an intermediary that sends what it likes.
 */
const serve = (script: Script) => {
  const received: Array<string> = []
  const closed = { at: undefined as number | undefined }

  const server = Bun.serve({
    port: 0,
    fetch: (request, bun) =>
      bun.upgrade(request, { headers: { "sec-websocket-protocol": SUBPROTOCOL } })
        ? undefined
        : new Response("upgrade required", { status: 426 }),
    websocket: {
      close: () => {
        closed.at = performance.now()
      },
      message: (ws, text) => {
        received.push(String(text))
        const send = (message: ServerWireMessage) => ws.send(JSON.stringify(message))

        if (received.length === 1) {
          send({ t: "open", connectionId: "c1", baseline: "0" })
          script(send, (raw) => ws.send(raw))
        }
      },
    },
  })

  servers.push(server)

  return { url: `http://127.0.0.1:${server.port}`, received, closed }
}

/** Far enough ahead that nothing expires during a test; the client doesn't read it. */
const RENEW_BY = 4_102_444_800_000

describe("client connections against a misbehaving server", () => {
  it("ends with a decode failure on a frame whose event cursor is not a position", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { url } = serve((send) => send({ t: "frame", frame: "hi", event: "not-a-cursor" }))

        const connection = yield* Effect.promise(() =>
          Room.client({ baseUrl: url }).get("r1").Live.connect(),
        )

        const iterator = connection.frames[Symbol.asyncIterator]()

        const failure = yield* Effect.promise(() =>
          iterator.next().then(
            () => undefined,
            (thrown: ActorError) => thrown,
          ),
        )

        expect(Schema.is(ActorError)(failure)).toBe(true)
        expect(Schema.is(TransportError)(failure?.reason)).toBe(true)
        expect(failure?.reason).toMatchObject({ code: "decode" })
      }),
    ))

  it("ignores a message whose t it doesn't know, and ends with a decode failure on one that isn't a message", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { url, closed } = serve((send, raw) => {
          raw(JSON.stringify({ t: "later", anything: 1 }))
          send({ t: "frame", frame: "after the unknown one" })
          raw("{not json")
        })

        const connection = yield* Effect.promise(() =>
          Room.client({ baseUrl: url }).get("r1").Live.connect(),
        )

        const iterator = connection.frames[Symbol.asyncIterator]()

        expect(yield* Effect.promise(() => iterator.next())).toEqual({
          done: false,
          value: "after the unknown one",
        })

        const failure = yield* Effect.promise(() =>
          iterator.next().then(
            () => undefined,
            (thrown: ActorError) => thrown,
          ),
        )

        expect(Schema.is(TransportError)(failure?.reason)).toBe(true)
        expect(failure?.reason).toMatchObject({ code: "decode" })

        yield* Effect.suspend(() =>
          closed.at === undefined ? Effect.fail("open") : Effect.void,
        ).pipe(Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 500 }), Effect.orDie)
      }),
    ))

  it("keeps the connection when the headers provider fails a renewal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0

        const { url, received } = serve((send) => {
          send({ t: "reauthenticate", by: RENEW_BY })
          send({ t: "frame", frame: "still here" })
        })

        const client = Room.client({
          baseUrl: url,
          headers: () => {
            calls += 1

            return calls === 1
              ? { authorization: "Bearer alice" }
              : Promise.reject(new Error("token refresh failed"))
          },
        })

        const connection = yield* Effect.promise(() => client.get("r1").Live.connect())
        const iterator = connection.frames[Symbol.asyncIterator]()

        expect(yield* Effect.promise(() => iterator.next())).toEqual({
          done: false,
          value: "still here",
        })

        expect(calls).toBe(2)
        expect(received.some((text) => text.includes('"reauthenticate"'))).toBe(false)
        yield* Effect.promise(() => connection.close())
      }),
    ))
})

describe("socketUrl", () => {
  it("keeps TLS: https and wss routes open wss sockets, http and ws ones ws", () => {
    expect(socketUrl("https://a.test/api/x")).toBe("wss://a.test/api/x")
    expect(socketUrl("wss://a.test/api/x")).toBe("wss://a.test/api/x")
    expect(socketUrl("http://a.test/x")).toBe("ws://a.test/x")
    expect(socketUrl("ws://a.test/x")).toBe("ws://a.test/x")
  })
})

class Posted extends Actor.Event<Posted>()("Posted", { text: Schema.String }) {}

const Board = Actor.make("FeedClientBoard", {
  key: Schema.String,
  events: [Posted],
  feeds: [Posted],
  api: { Ping: Actor.command("Ping") },
})

describe("client event feeds", () => {
  it("delivers an event named end, which carries a cursor, instead of reading it as the feed's end", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const entry = {
          event: yield* Schema.encodeEffect(Schema.toCodecJson(Posted))(
            Posted.make({ text: "hi" }),
          ),
          commandId: "c1",
          timestamp: 0,
        }

        const fetch = (_input: RequestInfo | URL) =>
          Promise.resolve(
            new Response(`id: 1\nevent: end\ndata: ${JSON.stringify(entry)}\n\n`, {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          )

        const feed = Board.client({ baseUrl: "http://feed.test", fetch }).get("b1").events(Posted)
        const first = yield* Effect.promise(() => feed[Symbol.asyncIterator]().next())

        expect(first.value?.cursor).toBe("1")
        expect(first.value?.event).toEqual(Posted.make({ text: "hi" }))
      }),
    ))

  it("waits the Retry-After a refused feed carried before it reopens", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const opened: Array<number> = []

        const refused = yield* Schema.encodeEffect(Schema.toCodecJson(ActorError))(
          ActorError.make({ reason: RunnerAtCapacity.make({}) }),
        )

        const entry = {
          event: yield* Schema.encodeEffect(Schema.toCodecJson(Posted))(
            Posted.make({ text: "hi" }),
          ),
          commandId: "c1",
          timestamp: 0,
        }

        const fetch = (_input: RequestInfo | URL) => {
          opened.push(performance.now())

          return Promise.resolve(
            opened.length === 1
              ? new Response(JSON.stringify(refused), {
                  status: 503,
                  headers: { "retry-after": "1" },
                })
              : new Response(`id: 1\ndata: ${JSON.stringify(entry)}\n\n`, {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                }),
          )
        }

        const feed = Board.client({ baseUrl: "http://feed.test", fetch }).get("b1").events(Posted)
        const first = yield* Effect.promise(() => feed[Symbol.asyncIterator]().next())

        expect(first.value?.event).toEqual(Posted.make({ text: "hi" }))
        expect(opened.length).toBe(2)
        expect(opened[1]! - opened[0]!).toBeGreaterThanOrEqual(990)
      }),
    ))
})

describe("client connection progress", () => {
  /** The server's `end` closes the session with `ServerClosed`, after the messages before it. */
  it("yields a progress frame decoded by its effect's schema, typed by effect", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { url } = serve((send) => {
          send({
            t: "progress",
            effect: "Render",
            effectId: "e1",
            attempt: 1,
            seq: 2,
            frame: { percent: 40 },
          })
          send({
            t: "progress",
            effect: "Scan",
            effectId: "e2",
            attempt: 1,
            seq: 1,
            frame: { found: 3, path: "/a" },
          })
          send({
            t: "progress",
            effect: "Render",
            effectId: "e1",
            attempt: 1,
            seq: 3,
            frame: { percent: "x" },
          })
          send({ t: "progress", effect: "Unlisted", effectId: "e3", attempt: 1, seq: 1, frame: {} })
          send({ t: "end" })
        })

        const connection = yield* Effect.promise(() =>
          Jobs.client({ baseUrl: url }).get("j1").Watch.connect(),
        )

        const received = Array.from(
          yield* Stream.fromAsyncIterable(connection.messages, (thrown) => thrown).pipe(
            Stream.catch(() => Stream.empty),
            Stream.runCollect,
          ),
        )

        expect(
          received.map((message) =>
            Predicate.isTagged(message, "Progress")
              ? [message.effect, message.effectId, message.seq, message.frame]
              : message._tag,
          ),
        ).toEqual([
          ["Render", "e1", 2, { percent: 40 }],
          ["Scan", "e2", 1, { found: 3, path: "/a" }],
        ])

        const [first] = received

        if (first?._tag === "Progress" && first.effect === "Render")
          expectTypeOf(first.frame).toEqualTypeOf<{ readonly percent: number }>()
      }),
    ))
})

describe("progress types", () => {
  type Watched = typeof Watch

  it("types each progress message's frame by its effect, and none for a member without progress", () => {
    type Update = ProgressOfConnection<Watched>

    expectTypeOf<Update>().toEqualTypeOf<
      | { readonly effect: "Render"; readonly frame: { readonly percent: number } }
      | {
          readonly effect: "Scan"
          readonly frame: { readonly found: number; readonly path: string }
        }
    >()

    expectTypeOf<Extract<Update, { readonly effect: "Scan" }>["frame"]>().toEqualTypeOf<{
      readonly found: number
      readonly path: string
    }>()

    expectTypeOf<ProgressOfConnection<typeof Live>>().toEqualTypeOf<never>()
  })

  it("narrows a Progress message on `effect`, and carries the attempt's identity beside it", () => {
    const narrow = (message: ConnectionMessage<string, ProgressOfConnection<Watched>>) => {
      if (!Predicate.isTagged(message, "Progress")) return

      expectTypeOf(message.effectId).toEqualTypeOf<string>()
      expectTypeOf(message.attempt).toEqualTypeOf<number>()
      expectTypeOf(message.seq).toEqualTypeOf<number>()
      expectTypeOf(message.effect).toEqualTypeOf<"Render" | "Scan">()

      if (message.effect === "Render")
        expectTypeOf(message.frame).toEqualTypeOf<{ readonly percent: number }>()
      else expectTypeOf(message.frame.path).toEqualTypeOf<string>()
    }

    expect(narrow).toBeTypeOf("function")
  })

  it("has no Progress message for a connection that lists no effects, and `unknown` frames by default", () => {
    type Messages = ConnectionMessage<string, ProgressOfConnection<typeof Live>>

    expectTypeOf<Extract<Messages, { readonly _tag: "Progress" }>>().toEqualTypeOf<never>()
    expectTypeOf<ProgressMessage["frame"]>().toEqualTypeOf<unknown>()
    expectTypeOf<ProgressMessage["effect"]>().toEqualTypeOf<string>()
  })

  it("types connect() on the client handle with the member's progress", () => {
    const handle = Jobs.client({ baseUrl: "http://progress.test" }).get("j1")

    type Opened = Awaited<ReturnType<typeof handle.Watch.connect>>

    type Message = Opened["messages"] extends AsyncIterable<infer M> ? M : never

    expectTypeOf<Extract<Message, { readonly _tag: "Progress" }>["effect"]>().toEqualTypeOf<
      "Render" | "Scan"
    >()
  })
})
