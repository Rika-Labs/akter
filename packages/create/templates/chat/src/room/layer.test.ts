import { BunCrypto } from "@effect/platform-bun"
import { Actor, User } from "@durable-actors/core"
import { Actors, Database } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Config, Effect, Layer, ManagedRuntime, Option } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Room, RoomClosed, RoomId } from "./contract.ts"
import { RoomLive } from "./layer.ts"

/**
 * Postgres when DATABASE_URL is set, as in the app; otherwise a throwaway
 * PGlite directory.
 */
const url = Effect.runSync(
  Effect.gen(function* () {
    return yield* Config.option(Config.Redacted("DATABASE_URL"))
  }),
)
const dataDir = mkdtempSync(join(tmpdir(), "chat-"))
const database = Option.getOrElse(url, () => ({ dataDir }))

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

/** A runtime over the real turn path, with fault injection and inspection. */
const harness = () =>
  ManagedRuntime.make(
    RoomLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database, as: User.make({ subject: "ada" }) })),
      Layer.provide(BunCrypto.layer),
    ),
  )

/** The same wiring as `src/main.ts`, built fresh to model a process restart. */
/**
 * Opening a new PGlite directory runs initdb inside WebAssembly (about 2 s on a
 * laptop, over 5 s on a busy CI runner) and applies the framework's migrations,
 * so `beforeAll` opens it once and no test's own timeout pays for it.
 */
const app = () =>
  ManagedRuntime.make(
    RoomLive.pipe(
      Layer.provideMerge(Actors.layer({ authorize: () => Effect.succeed(true) })),
      Layer.provide(
        Option.match(url, {
          onNone: () => Database.pglite({ dataDir }),
          onSome: (value) => Database.postgres({ url: value }),
        }),
      ),
      Layer.provide(BunCrypto.layer),
    ),
  )

beforeAll(async () => {
  const runtime = app()
  await runtime.runPromise(Effect.void)
  await runtime.dispose()
}, 60_000)

test("posts land in the table and the event log together", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("posts"))

      const id = yield* room.Post({ body: "hello" })
      yield* room.Post({ body: "world" })

      expect((yield* room.Recent({ limit: 1 })).map(({ body }) => body)).toEqual(["world"])
      expect((yield* room.History({})).map(({ cursor, message }) => [cursor, message.id])).toEqual([
        ["1", id],
        ["2", expect.any(String)],
      ])
      expect(yield* room.History({ after: "1" })).toHaveLength(1)
      expect(yield* room.React(2)).toMatchObject({ reactions: 2 })
      expect(yield* test.inspect(room.ref)).toMatchObject({ events: 2, rows: { chat_messages: 2 } })
    }),
  )
  await runtime.dispose()
})

test("a post retried after its commit is not posted twice", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("retry"))

      yield* test.crashNext("afterCommit")
      const post = room.Post({ body: "once" })
      const id = yield* post

      expect(yield* post).toBe(id)
      expect(yield* test.inspect(room.ref)).toMatchObject({ events: 1, rows: { chat_messages: 1 } })
    }),
  )
  await runtime.dispose()
})

test("recent messages keep posting order across crashed and retried posts", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("order"))

      yield* room.Post({ body: "first" })

      yield* test.crashNext("beforeCommit")
      yield* room.Post({ body: "second" })

      yield* test.crashNext("afterCommit")
      const third = room.Post({ body: "third" })
      yield* third
      yield* third

      expect((yield* room.Recent({ limit: 3 })).map(({ body }) => body)).toEqual([
        "third",
        "second",
        "first",
      ])
      expect(yield* test.inspect(room.ref)).toMatchObject({
        state: { posted: 3 },
        rows: { chat_messages: 3 },
      })
    }),
  )
  await runtime.dispose()
})

test("a closed room rejects posts and keeps nothing from them", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const room = yield* Room.get(RoomId.make("closed"))

      yield* room.Close()

      expect(yield* room.Post({ body: "late" }).pipe(Effect.flip)).toBeInstanceOf(RoomClosed)
      expect(yield* test.inspect(room.ref)).toMatchObject({ events: 0, rows: { chat_messages: 0 } })
    }),
  )
  await runtime.dispose()
})

test("messages survive a restart", async () => {
  const room = Room.get(RoomId.make(crypto.randomUUID())).pipe(
    Actor.tenant("quickstart-test"),
    Actor.as(User.make({ subject: "ada" })),
  )

  const first = app()
  await first.runPromise(Effect.flatMap(room, (handle) => handle.Post({ body: "kept" })))
  await first.dispose()

  const second = app()
  const recent = await second.runPromise(
    Effect.flatMap(room, (handle) =>
      handle.Post({ body: "next" }).pipe(Effect.andThen(handle.Recent({ limit: 2 }))),
    ),
  )
  expect(recent.map(({ body }) => body)).toEqual(["next", "kept"])
  await second.dispose()
})
