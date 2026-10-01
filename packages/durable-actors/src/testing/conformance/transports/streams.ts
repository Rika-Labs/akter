import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Socket } from "effect/socket"
import { User } from "../../../index.ts"
import { InternalActors } from "../../../runtime/actors.ts"
import { descriptorOf } from "../../../actor/descriptor.ts"
import { socketSession } from "../../../serve/sessions/socket.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Chat, FeedRoom, Refused, SocketRoom } from "./actors.ts"
import { asFailure, encodeClient } from "./wire.ts"
import { rows, setup } from "./harness.ts"

/** Unwritable sockets and stream members served over SSE. */
export const transportStreamConformance: ReadonlyArray<ConformanceCase> = [
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
            connection: descriptorOf(SocketRoom)!.served.connections.find(
              (connection) => connection.tag === Chat.tag,
            )!,
            holder: actors.holder,
            ref: () => ref,
            upgrade: principal,
            authenticate: () => Effect.succeed(principal),
            reauthenticate: () => Effect.succeed(principal),
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
