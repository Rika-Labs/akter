import { BunCrypto } from "@effect/platform-bun"
import { type ActorRef, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import {
  Config,
  Crypto,
  Effect,
  Layer,
  ManagedRuntime,
  Queue,
  Redacted,
  Schema,
  Stream,
} from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { Cursor, DocId, Here, Joined, Left, Live, Moved } from "./contract.ts"
import { CursorLive } from "./layer.ts"

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("CHAT_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `cursor_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return CursorLive.pipe(
      Layer.provideMerge(
        ActorTest.layer({ database: yield* database, as: User.make({ subject: "ada" }) }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

/** Opens a connection and returns a reader of its frames, in order, none dropped between reads. */
const open = Effect.fnUntraced(function* (ref: ActorRef, color: string) {
  const test = yield* ActorTest
  const connection = yield* test.connect(ref, Live, { color })
  const inbox = yield* Queue.unbounded<typeof Live.server.Type>()
  yield* connection.frames.pipe(
    Stream.runForEach((frame) => Queue.offer(inbox, frame)),
    Effect.ignore,
    Effect.forkScoped,
  )

  return { ...connection, next: Queue.take(inbox) }
})

it("shows who is here, relays moves, and announces joins and leaves, across hibernation", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const doc = yield* Cursor.get(DocId.make("d1"))
      const peer = (connectionId: string, color: string) => ({ connectionId, user: "ada", color })

      const red = yield* open(doc.ref, "red")
      expect(yield* red.next).toEqual(Here.make({ peers: [] }))

      const blue = yield* open(doc.ref, "blue")
      expect(yield* blue.next).toEqual(Here.make({ peers: [peer(red.connectionId, "red")] }))
      expect(yield* red.next).toEqual(Joined.make({ peer: peer(blue.connectionId, "blue") }))

      // A parked document wakes for the frame and relays it to everyone else.
      yield* test.hibernate(doc.ref)
      yield* red.send({ x: 10, y: 20 })
      expect(yield* blue.next).toEqual(
        Moved.make({ connectionId: red.connectionId, at: { x: 10, y: 20 } }),
      )

      // A late joiner sees the last position of each cursor.
      const green = yield* open(doc.ref, "green")
      const here = yield* green.next
      expect(Schema.is(Here)(here) && byColor(here.peers)).toEqual([
        peer(blue.connectionId, "blue"),
        { ...peer(red.connectionId, "red"), at: { x: 10, y: 20 } },
      ])

      const joined = Joined.make({ peer: peer(green.connectionId, "green") })
      expect(yield* red.next).toEqual(joined)
      expect(yield* blue.next).toEqual(joined)

      yield* blue.close
      expect(yield* red.next).toEqual(Left.make({ connectionId: blue.connectionId }))
      expect(yield* green.next).toEqual(Left.make({ connectionId: blue.connectionId }))

      yield* red.close
      expect(yield* green.next).toEqual(Left.make({ connectionId: red.connectionId }))
      yield* green.close
    }).pipe(Effect.scoped),
  ))

const byColor = <P extends { readonly color: string }>(peers: ReadonlyArray<P>) =>
  [...peers].sort((a, b) => a.color.localeCompare(b.color))

it("stores nothing beyond the open connections", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const doc = yield* Cursor.get(DocId.make("d2"))
      const only = yield* test.connect(doc.ref, Live, { color: "red" })
      yield* only.send({ x: 1, y: 1 })
      yield* only.close

      expect(yield* test.inspect(doc.ref)).toMatchObject({ receipts: 0, events: 0, outbox: 0 })
    }),
  ))
