import { Effect, Layer, Stream } from "effect"
import { TestRunner } from "effect/unstable/cluster"
import { WorkflowEngine } from "effect/unstable/workflow"
import { Actor, Actors, Database, TenantId } from "../framework/Actor.ts"
import type { Message } from "./Chat.ts"
import { Chat, RoomId } from "./Chat.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { CountChanged, Counter, CounterId } from "./Counter.ts"
import { CounterLive } from "./Counter.server.ts"
import { Onboard } from "./Onboard.ts"
import { OnboardLive } from "./Onboard.server.ts"

// client side: one yield to get the actor, then plain Effects
export const program = Effect.gen(function*() {
  const counter = yield* Counter.get(CounterId.make("counter-123"))
  const n = yield* counter.Increment(1)
  // externally supplied idempotency key, set ambiently for this call only
  yield* counter.Increment(5).pipe(Actor.commandId("idempotency-key-from-http"))
  yield* counter.Reset()
  const total = yield* counter.GetCount()

  const room = yield* Chat.get(RoomId.make("room-1"), { tenant: TenantId.make("acme") })
  const msg = yield* room.SendMessage({ id: "m1", body: "hi" }).pipe(Actor.as({ userId: "u1" }))
  const transcript: Stream.Stream<Message, never> = room.Transcript().pipe(Stream.orDie)

  const actors = yield* Actors // non-sugared form, same handle
  const same = actors.get(Counter, CounterId.make("counter-123"))

  const executionId = yield* Onboard.start({ userId: "u1", roomId: RoomId.make("room-1") })
  return { n, total, msg, same, transcript, executionId }
})

// typed event subscription (Stream, scoped)
export const ticks = Effect.map(Counter.get(CounterId.make("counter-123")), (counter) => counter.events(CountChanged))

// non-Effect callers (browsers, coding agents) get the same contract as Promises
const chat = Chat.client({ baseUrl: "https://actors.example.com" })
export const sendFromBrowser = async (body: string): Promise<Message> => await chat.get(RoomId.make("room-1")).SendMessage({ id: "m1", body })

// server side: actor layers → Actor.layer → Database + cluster runner + workflow engine
export const AppLive = Layer.mergeAll(CounterLive, ChatLive, OnboardLive).pipe(
  Layer.provide(Layer.succeed(RoomAccess, { requireMember: () => Effect.void })),
  Layer.provide(Actor.layer),
  // real apps use Database.layer(config); the sketch only depends on `effect`
  Layer.provide(Layer.succeed(Database, { sql: {} as Database["Service"]["sql"], drizzle: {} as Database["Service"]["drizzle"] })),
  Layer.provide(TestRunner.layer),
  Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, {} as WorkflowEngine.WorkflowEngine["Service"]))
)
