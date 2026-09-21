// Typecheck-only sketch: a durable workflow under virtual time, crashes and a human-in-the-loop wait.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import { ActorTest } from "../framework/Testing.ts"
import { Chat, RoomId } from "./Chat.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { CounterLive } from "./Counter.server.ts"
import { Onboard } from "./Onboard.ts"
import { OnboardLive } from "./Onboard.server.ts"

const TestLive = Layer.mergeAll(OnboardLive, ChatLive, CounterLive).pipe(
  Layer.provide(Layer.succeed(RoomAccess, { requireMember: () => Effect.void })),
  Layer.provideMerge(ActorTest.layer())
)

it.layer(TestLive)("Onboard", (it) => {
  it.effect("the welcome activity is idempotent across retries: one receipt, one message", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const roomId = RoomId.make("r1")

      yield* test.workflows.crashActivity(Onboard, "welcome", { times: 2 })
      const execution = yield* Onboard.start({ userId: "u1", roomId })
      yield* test.settle

      const wf = yield* test.workflows.inspect(Onboard, execution)
      expect(wf.activities.find((a) => a.name === "welcome")?.attempts).toBe(3)
      // three attempts, one command applied: the framework piped Actor.commandId(`${executionId}:welcome`)
      const room = yield* test.inspect(Chat, roomId)
      expect(room.receipts.map((r) => r.commandId)).toEqual([`${execution}:welcome`])
      expect(room.events).toHaveLength(1)
      expect(wf.status).toBe("waiting")
    }))

  it.effect("waitFor resolves on the actor's next event, from any caller", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const roomId = RoomId.make("r2")
      const done = yield* Onboard.execute({ userId: "u2", roomId }).pipe(Effect.forkScoped)
      yield* test.settle
      expect((yield* test.workflows.inspect(Onboard, "u2")).status).toBe("waiting")

      const room = yield* Chat.get(roomId)
      yield* room.SendMessage({ id: "reply", body: "thanks" })
      yield* Fiber.join(done)
      expect((yield* test.workflows.inspect(Onboard, "u2")).status).toBe("completed")
    }))

  it.effect("no reply for a day: waitFor yields None and the workflow sleeps a durable day", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const done = yield* Onboard.execute({ userId: "u3", roomId: RoomId.make("r3") }).pipe(Effect.forkScoped)
      yield* test.settle
      yield* test.clock.advance("1 day")
      const sleeping = yield* test.workflows.inspect(Onboard, "u3")
      expect(sleeping.status).toBe("sleeping")
      expect(Option.isSome(sleeping.sleepingUntil)).toBe(true)
      yield* test.clock.advance("1 day")
      yield* Fiber.join(done)
    }))

  it.effect("the same idempotencyKey does not start a second execution", () =>
    Effect.gen(function*() {
      const a = yield* Onboard.start({ userId: "u4", roomId: RoomId.make("r4") })
      const b = yield* Onboard.start({ userId: "u4", roomId: RoomId.make("r4") })
      expect(a).toBe(b)
    }))
})
