import { Effect, Layer, Stream } from "effect"
import { Actor, Actors, Caller, CurrentCaller, Database, TenantId, Topology } from "../framework/Actor.ts"
import { AgentSessionLive } from "./AgentSession.server.ts"
import type { Message } from "./Chat.ts"
import { Chat, RoomId } from "./Chat.ts"
import { ChatReads } from "./Chat.queries.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { CountChanged, Counter, CounterId } from "./Counter.ts"
import { CounterLive, CounterReads } from "./Counter.server.ts"
import { NightlyLive } from "./Nightly.server.ts"
import { Onboard } from "./Onboard.ts"
import { OnboardLive } from "./Onboard.server.ts"
import { PrincipalSchema, UserId } from "./Principal.ts"

const principal = { userId: UserId.make("u1"), roles: ["member"] as const }

// client side: one yield to get the actor, then plain Effects. Every call names its caller.
export const program = Effect.gen(function*() {
  const counter = yield* Counter.get(CounterId.make("counter-123"))
  const n = yield* counter.Increment(1).pipe(Actor.as(principal))
  // externally supplied idempotency key, set ambiently for this call only
  yield* counter.Increment(5).pipe(Actor.commandId("idempotency-key-from-http"), Actor.as(principal))
  yield* counter.Reset().pipe(Actor.anonymous)
  const total = yield* counter.GetCount().pipe(Actor.as(principal))

  const room = yield* Chat.get(RoomId.make("room-1"), { tenant: TenantId.make("acme") })
  const msg = yield* room.SendMessage({ id: "m1", body: "hi" }).pipe(Actor.as(principal))
  const transcript: Stream.Stream<Message, never> = room.Transcript().pipe(Stream.orDie, Stream.provideService(CurrentCaller, Caller.user(principal)))

  const actors = yield* Actors // non-sugared form, same handle
  const same = actors.get(Counter, CounterId.make("counter-123"))

  const executionId = yield* Onboard.start({ userId: "u1", roomId: RoomId.make("room-1") })
  return { n, total, msg, same, transcript, executionId }
})

// typed event subscription with a cursor: replay from the beginning, then follow live
export const ticks = Effect.map(
  Counter.get(CounterId.make("counter-123")),
  (counter) => counter.events(CountChanged, { from: 0 })
)

// non-Effect callers (browsers, coding agents) get the same contract as Promises
const chat = Chat.client({ baseUrl: "https://actors.example.com" })
export const sendFromBrowser = async (body: string): Promise<Message> => await chat.get(RoomId.make("room-1")).SendMessage({ id: "m1", body })

// server side: actor layers → Actor.layer({ principal, topology }) → Database.layer
export const AppLive = Layer.mergeAll(CounterLive, CounterReads, ChatLive, ChatReads, OnboardLive, NightlyLive, AgentSessionLive).pipe(
  Layer.provide(Layer.succeed(RoomAccess, { requireMember: () => Effect.void })),
  Layer.provide(Actor.layer({
    principal: PrincipalSchema,
    topology: Topology.http({ listen: { host: "0.0.0.0", port: 3000 }, advertise: { host: "10.0.0.7", port: 3000 } })
  })),
  Layer.provide(Database.layer({ url: "postgres://localhost/actors", migrate: "auto" }))
)
