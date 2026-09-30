import { BunCrypto } from "@effect/platform-bun"
import { type ActorRef, User } from "@durable-actors/core"
import { ActorTest, simulationSeeds, testDatabase } from "@durable-actors/core/testing"
import { Effect, Layer, ManagedRuntime } from "effect"
import { afterAll, expect, it } from "vitest"
import { Room, RoomId, Thread } from "./contract.ts"
import { RoomLive } from "./layer.ts"
import { ModerationApi, Moderators } from "./moderation.ts"
import { chatScript } from "./simulate.ts"

/** Provider calls per idempotency key. */
const provider = { calls: new Map<string, number>() }

const CountingModeration = Layer.succeed(ModerationApi, {
  check: (body, { idempotencyKey }) =>
    Effect.sync(() => {
      provider.calls.set(idempotencyKey, (provider.calls.get(idempotencyKey) ?? 0) + 1)

      return body.includes("spam")
    }),
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return RoomLive.pipe(
      Layer.provide([CountingModeration, Moderators.layer]),
      Layer.provideMerge(
        ActorTest.layer({ database: yield* testDatabase, as: User.make({ subject: "ada" }) }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const thread = (id: string) => Thread.get(id as Parameters<typeof Thread.get>[0])

/** Waits, without moving the clock, until a room's moderation has run for every post. */
const moderated = Effect.fnUntraced(function* (room: ActorRef, posts: number) {
  const test = yield* ActorTest

  while ((yield* test.receiptsFor(room, "Moderated")) < posts) yield* Effect.sleep("20 millis")
})

it(
  "simulates seeded posts, reactions, and reply threads with crashes and relay restarts, keeping receipts exactly once",
  () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const test = yield* ActorTest
        const seeds = yield* simulationSeeds
        let minted = 0

        for (const seed of seeds) {
          const before = new Set(provider.calls.keys())
          const { report, posted, threads, reactions } = yield* chatScript(seed)
          const room = yield* Room.get(RoomId.make(`sim-${seed}`))

          expect(report.steps.length).toBeGreaterThan(0)
          expect(new Set(posted).size).toBe(posted.length)
          expect(new Set(threads).size).toBe(threads.length)

          yield* moderated(room.ref, posted.length)

          expect((yield* test.inspect(room.ref)).state).toMatchObject({ reactions })
          expect(yield* test.receiptsFor(room.ref, "Post")).toBe(posted.length)

          expect([...provider.calls].flatMap(([key, n]) => (before.has(key) ? [] : [n]))).toEqual(
            posted.map(() => 1),
          )

          for (const id of threads) {
            const child = yield* thread(id)
            expect(yield* test.receiptsFor(child.ref, "Open")).toBe(1)
          }

          minted += threads.length
        }

        expect(minted).toBeGreaterThan(0)
      }),
    ),
  120_000,
)
