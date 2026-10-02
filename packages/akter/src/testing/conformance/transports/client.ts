import { Effect, Layer, Predicate, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { User } from "../../../index.ts"
import { RetentionGap, UnknownCursor } from "../../../errors/events.ts"
import { InternalActors } from "../../../runtime/actors.ts"
import type { ActorRef } from "../../../identity/caller.ts"
import { ActorTest } from "../../actor-test.ts"
import { ActorCluster } from "../../cluster.ts"
import type { ConformanceCase } from "../../conformance.ts"
import {
  Banned,
  FeedRoom,
  Hello,
  Percent,
  Said,
  Say,
  SocketRoom,
  transportsLayer,
} from "./actors.ts"
import { asFailure, serveSockets, socket } from "./wire.ts"
import { setup } from "./harness.ts"

/** The Promise client's feeds, connections, progress, and resync over served transports. */
export const transportClientConformance: ReadonlyArray<ConformanceCase> = [
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
    name: "client opens a connection with typed frames both ways, rejects a declared open failure or a failing headers provider, and ends on close",
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

          const refresh = new Error("token refresh failed")

          const failing = SocketRoom.client({
            baseUrl: `http://${host}/api`,
            headers: () => Promise.reject(refresh),
          }).get("client-socket")

          const unsent = yield* Effect.promise(() =>
            failing.Chat.connect({ name: "alice" }).then(
              () => "opened",
              (thrown: Error) => thrown,
            ),
          )

          expect(unsent).toBe(refresh)
        }),
      ),
  },
  {
    name: "carries executor progress over WebSocket as its own progress message, and the client yields it decoded apart from frames",
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const { host, token } = yield* setup(environment)
          const room = yield* SocketRoom.get("ws-progress")
          const ws = yield* socket(host, "ws-progress", { member: "Watch" })
          yield* ws.send({ t: "hello", authorization: token() })
          yield* ws.until("open")

          const client = SocketRoom.client({
            baseUrl: `http://${host}/api`,
            headers: () => ({ authorization: token() }),
          }).get("ws-progress")

          const connection = yield* Effect.promise(() => client.Watch.connect())
          const iterator = connection.messages[Symbol.asyncIterator]()
          yield* room.Start(10)

          const [wire] = (yield* ws.until("progress")).filter((message) => message.t === "progress")
          expect(wire).toMatchObject({ t: "progress", job: "Render", attempt: 1 })
          expect(
            Predicate.hasProperty(wire, "cursor") || Predicate.hasProperty(wire, "event"),
          ).toBe(false)
          expect(wire?.t === "progress" && wire.seq >= 1).toBe(true)
          expect(Schema.is(Percent)(wire?.t === "progress" ? wire.frame : undefined)).toBe(true)

          const received = yield* Effect.promise(() => iterator.next())
          const progress = received.value?._tag === "Progress" ? received.value : undefined
          expect([progress?.job, progress?.attempt]).toEqual(["Render", 1])
          expect(Schema.is(Percent)(progress?.frame)).toBe(true)

          yield* Effect.promise(() => connection.close())
        }),
      ),
  },
  {
    name: "client resyncs a connection in place after its owner dies: onResync runs, then live frames resume without duplicates",
    requiresFreshDatabase: true,
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
              authorize: () => Effect.succeed(true),
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

            expect(yield* seen).toEqual({ tag: "ResyncReplayed" })
            yield* post("after")
            expect(yield* seen).toEqual({ tag: "Frame", frame: Said.make({ text: "after" }) })
            expect(resyncs).toEqual(["1"])
            yield* Effect.promise(() => connection.close())
          }).pipe(Effect.provideContext(context))
        }),
      ),
  },
]
