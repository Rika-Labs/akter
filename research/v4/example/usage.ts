import { Effect, Layer } from "effect"
import { TestRunner } from "effect/unstable/cluster"
import { Actor, Actors, Database } from "../framework/Actor.ts"
import { Chat } from "./Chat.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { CountChanged, Counter } from "./Counter.ts"
import { CounterLive } from "./Counter.server.ts"

// client side: one yield to get the actor, then plain Effects
export const program = Effect.gen(function*() {
  const counter = yield* Counter.get("counter-123")
  const n = yield* counter.Increment(1)
  yield* counter.Increment(5, { commandId: "idempotency-key-from-http" })
  yield* counter.Reset()
  const total = yield* counter.GetCount()

  const room = yield* Chat.get("room-1")
  const msg = yield* room.SendMessage({ id: "m1", body: "hi" })

  const actors = yield* Actors // non-sugared form, same handle
  const same = actors.get(Counter, "counter-123")
  return { n, total, msg, same }
})

// typed event subscription (Stream, scoped)
export const ticks = Effect.map(Counter.get("counter-123"), (counter) => counter.events(CountChanged))

// server side: actor layers → Actor.layer → Database + cluster runner
export const AppLive = Layer.mergeAll(CounterLive, ChatLive).pipe(
  Layer.provide(Layer.succeed(RoomAccess, { requireMember: () => Effect.void })),
  Layer.provide(Actor.layer),
  Layer.provide(Layer.succeed(Database, {} as Database["Service"])), // Database.layer(config) in the real thing
  Layer.provide(TestRunner.layer)
)
