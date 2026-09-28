import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { ActorError, TransportError } from "../errors/actor.ts"
import { Actor } from "../index.ts"
import { SUBPROTOCOL, type ServerWireMessage } from "../serve/frames.ts"

const Live = Actor.connection("Live", { client: Schema.String, server: Schema.String })

const Room = Actor.make("ConnectionClientRoom", { key: Schema.String, api: { Live } })

type Script = (send: (message: ServerWireMessage) => void) => void

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

  const server = Bun.serve({
    port: 0,
    fetch: (request, bun) =>
      bun.upgrade(request, { headers: { "sec-websocket-protocol": SUBPROTOCOL } })
        ? undefined
        : new Response("upgrade required", { status: 426 }),
    websocket: {
      message: (ws, text) => {
        received.push(String(text))
        const send = (message: ServerWireMessage) => ws.send(JSON.stringify(message))

        if (received.length === 1) {
          send({ t: "open", connectionId: "c1", baseline: "0" })
          script(send)
        }
      },
    },
  })

  servers.push(server)

  return { url: `http://127.0.0.1:${server.port}`, received }
}

// Far enough ahead that nothing expires during a test; the client doesn't read it.
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

  it("keeps the connection when the headers provider fails a renewal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0

        const { url, received } = serve((send) => {
          send({ t: "reauthenticate", by: RENEW_BY })
          // Sent after the renewal request, so it arrives once the failed renewal was handled.
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
