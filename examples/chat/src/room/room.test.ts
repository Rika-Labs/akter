import { BunCrypto } from "@effect/platform-bun"
import {
  Actor,
  ActorError,
  type ActorRef,
  CommandExpired,
  RetentionGap,
  User,
} from "durable-actors"
import { ActorTest } from "durable-actors/testing"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Option, Redacted, Schema } from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { Room, RoomClosed, RoomId } from "./contract.ts"
import { RoomLive } from "./layer.ts"
import { ModerationApi } from "./moderation.ts"

/** Provider calls per idempotency key. */
const provider = { calls: new Map<string, number>() }

const CountingModeration = Layer.succeed(ModerationApi, {
  check: (body, { idempotencyKey }) =>
    Effect.sync(() => {
      provider.calls.set(idempotencyKey, (provider.calls.get(idempotencyKey) ?? 0) + 1)

      return body.includes("spam")
    }),
})

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("CHAT_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `chat_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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
    return RoomLive.pipe(
      Layer.provide(CountingModeration),
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

/** Waits until the relay has run the room's moderation and delivered its route. */
const moderated = Effect.fnUntraced(function* (room: { readonly ref: ActorRef }, posts: number) {
  const test = yield* ActorTest

  while ((yield* test.receiptsFor(room.ref, "Moderated")) < posts) yield* Effect.sleep("20 millis")

  while ((yield* test.inspect(room.ref)).effects > 0) yield* Effect.sleep("20 millis")
})

const bytes = new TextEncoder().encode("attachment")

it("posts a message with its row, blob, event, moderation, and idle timer", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r0"))
      const id = yield* room.Post({ body: "hello", file: bytes })
      yield* moderated(room, 1)

      expect(yield* room.Recent({ limit: 10 })).toEqual([{ id, author: "ada", body: "hello" }])
      expect(Option.getOrThrow(yield* room.Attachment(id))).toEqual(bytes)
      expect(
        (yield* room.History({})).map(({ cursor, message }) => [cursor, message.body]),
      ).toEqual([["1", "hello"]])
      expect(yield* room.React(2)).toMatchObject({ reactions: 2, closed: false })
      expect(yield* test.inspect(room.ref)).toMatchObject({
        rows: { chat_messages: 1 },
        blobs: { attachments: 1 },
        events: 1,
        outbox: 1,
        effects: 0,
        state: { reactions: 2 },
      })
    }),
  ))

it("a declared failure commits nothing but its receipt", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r1"))
      yield* room.Archive()
      const failed = yield* room.Post({ body: "hi", file: bytes }).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(RoomClosed)
      expect(yield* test.inspect(room.ref)).toMatchObject({
        rows: { chat_messages: 0 },
        blobs: { attachments: 0 },
        events: 1,
        outbox: 0,
        effects: 0,
        receipts: 2,
      })
    }),
  ))

it("delivers an intent exactly once across a crash after the receiver commits", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r2"))
      yield* room.Post({ body: "hello" })
      yield* moderated(room, 1)

      // The idle check commits, then its turn crashes before the relay deletes the timer.
      yield* test.crashNext("afterCommit")
      yield* test.advance("24 hours")
      expect((yield* test.inspect(room.ref)).state).toMatchObject({ closed: true })
      expect(yield* test.receiptsFor(room.ref, "IdleCheck")).toBe(1)
      expect(yield* test.receiptsFor(room.ref, "Archive")).toBe(1)
      expect(yield* test.inspect(room.ref)).toMatchObject({ outbox: 0, events: 2 })
    }),
  ))

it("routes a moderation result once, even if the executor succeeds twice", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r3"))

      // The first attempt's result is lost after the provider answered, so the relay runs it again.
      const before = new Set(provider.calls.keys())
      yield* test.crashNext("afterExecute")
      yield* room.Post({ body: "buy spam" })

      // The crashed attempt keeps its lease; the relay retries once the lease has passed.
      while (![...provider.calls.keys()].some((key) => !before.has(key)))
        yield* Effect.sleep("20 millis")
      yield* test.advance("2 minutes")
      yield* moderated(room, 1)

      // Both attempts carried the same effect id as the provider's idempotency key.
      expect([...provider.calls].filter(([key]) => !before.has(key)).map(([, n]) => n)).toEqual([2])
      expect(yield* test.receiptsFor(room.ref, "Moderated")).toBe(1)
      expect(yield* room.Recent({ limit: 10 })).toEqual([])
    }),
  ))

it("replays MessagePosted in order after a cursor, and errors on a retention gap", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r4"))
      yield* room.Post({ body: "a" })
      yield* room.Post({ body: "b" })
      yield* room.Post({ body: "c" })
      yield* moderated(room, 3)

      const bodies = (entries: ReadonlyArray<{ readonly message: { readonly body: string } }>) =>
        entries.map(({ message }) => message.body)

      expect(bodies(yield* room.History({}))).toEqual(["a", "b", "c"])
      expect(bodies(yield* room.History({ after: "1" }))).toEqual(["b", "c"])
      expect(bodies(yield* room.History({ after: "1", limit: 1 }))).toEqual(["b"])

      // A month later the idle timer has archived the room and cleanup pruned the posts.
      yield* test.advance("31 days")
      yield* test.cleanup
      expect((yield* test.inspect(room.ref)).state).toMatchObject({ closed: true })
      expect(yield* room.History({}).pipe(Effect.flip)).toEqual(RetentionGap.make({ cursor: "0" }))
      expect(yield* room.History({ after: "3" })).toEqual([])
    }),
  ))

it("prunes receipts past keepReceipts and refuses the pruned command id", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("r5"))
      const post = room.Post({ body: "once" })
      const id = yield* post
      expect(yield* post).toBe(id)
      yield* moderated(room, 1)

      yield* test.advance("8 days")
      yield* test.cleanup
      expect(yield* test.receiptsFor(room.ref, "Post")).toBe(0)
      const retried = yield* post.pipe(Effect.flip)
      expect(Schema.is(ActorError)(retried) && retried.reason).toBeInstanceOf(CommandExpired)
      expect(yield* room.Recent({ limit: 10 })).toEqual([{ id, author: "ada", body: "once" }])
    }),
  ))

it("keeps each room's messages to itself", () =>
  run(
    Effect.gen(function* () {
      const mine = yield* Room.get(RoomId.make("r6"))
      const theirs = yield* Room.get(RoomId.make("r6")).pipe(Actor.tenant("elsewhere"))
      yield* mine.Post({ body: "mine" })
      yield* theirs.Post({ body: "theirs" })
      yield* moderated(mine, 1)

      expect((yield* mine.Recent({ limit: 10 })).map(({ body }) => body)).toEqual(["mine"])
      expect((yield* theirs.Recent({ limit: 10 })).map(({ body }) => body)).toEqual(["theirs"])
    }),
  ))
