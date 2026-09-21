// Typecheck-only sketch: caller attribution, effects held/run/failed, event cursors, cross-actor intents.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Cause, Effect, Fiber, Layer, Stream } from "effect"
import { Actor, Caller, TenantId } from "../framework/Actor.ts"
import { ActorTest } from "../framework/Testing.ts"
import { Chat, MessageAdded, NotAMember, RoomId, SendEmail } from "./Chat.ts"
import { ChatReads } from "./Chat.queries.ts"
import { ChatLive, RoomAccess } from "./Chat.server.ts"
import { Counter, CounterId } from "./Counter.ts"
import { CounterLive } from "./Counter.server.ts"
import { MailerLive } from "./Mailer.ts"
import { OrgId, UserId } from "./Principal.ts"

const member = { userId: UserId.make("alice"), orgId: OrgId.make("acme"), roles: ["member"] as const }
const stranger = { userId: UserId.make("mallory"), orgId: OrgId.make("acme"), roles: [] as const }

// the app service is a plain Layer: the test decides who is a member
const RoomAccessTest = Layer.succeed(RoomAccess, {
  requireMember: (caller) =>
    caller._tag === "User" && caller.principal.roles.includes("member")
      ? Effect.void
      : Effect.fail(new NotAMember({ userId: caller._tag === "User" ? caller.principal.userId : "anonymous" }))
})

// `as` is the default caller for the whole file; `Actor.as` still wins per call
const TestLive = Layer.mergeAll(ChatLive, ChatReads, CounterLive).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessTest, MailerLive)),
  Layer.provideMerge(ActorTest.layer({ as: member }))
)

it.layer(TestLive)("Chat", (it) => {
  it.effect("the caller rides in the envelope headers and the handler sees it after (de)serialization", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = RoomId.make("r1")
      const room = yield* Chat.get(id)

      const msg = yield* room.SendMessage({ body: "hi" })
      expect(msg.authorId).toBe("alice")

      const denied = yield* room.SendMessage({ body: "hi" }).pipe(Actor.as(stranger), Effect.flip)
      expect(denied).toEqual(new NotAMember({ userId: "mallory" }))
      // a rejected command still gets a receipt and a turn, but no event
      const state = yield* test.inspect(Chat, id)
      expect(state.receipts.map((r) => r.exit._tag)).toEqual(["Success", "Failure"])
      expect(state.events).toHaveLength(1)
    }))

  it.effect("effects are held: the outbox row exists, nothing ran, then run → executor → done", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      // the bound form (decision 120): handle plus harness for one id
      const room = yield* test.actor(Chat, RoomId.make("r2"))
      const msg = yield* room.handle.SendMessage({ body: "hello" })

      const pending = yield* room.effects
      // the message id is the turn's commandId, so the effect points back at the row that was written
      expect(pending.map((p) => p.effect)).toEqual([new SendEmail({ messageId: msg.id, to: "room@example.com", body: "hello" })])
      expect(pending[0]?.attempt).toBe(0)

      yield* test.effects.run
      expect((yield* room.inspect).outbox).toEqual([])
    }))

  it.effect("an executor that keeps failing is retried on the schedule, dead-lettered, and the actor is told", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = RoomId.make("r3")
      const room = yield* Chat.get(id)
      yield* room.SendMessage({ body: "boom" })

      yield* test.effects.fail(Chat, SendEmail, Cause.fail(new Error("smtp down")), { times: "always" })
      yield* test.effects.drain // advances the clock through Schedule.spaced("1 second") until the policy gives up

      const state = yield* test.inspect(Chat, id)
      expect(state.outbox).toEqual([])
      expect(state.deadLetters.map((d) => d.effect._tag)).toEqual(["SendEmail"])
      // `Chat.onEffectFailed` ran inside a turn of its own, with the System caller for this actor
      const failed = (yield* test.turns.of(Chat, id)).find((t) => t.trigger === "effect-failed")!
      expect(failed.caller).toEqual(Caller.system("effect", { ref: failed.ref }))
    }))

  it.effect("events(E, { after }) replays the log and then follows live without a gap or a duplicate", () =>
    Effect.gen(function*() {
      const id = RoomId.make("r4")
      const room = yield* Chat.get(id)
      yield* room.SendMessage({ body: "one" })
      yield* room.SendMessage({ body: "two" })

      // `after` is exclusive: sequence 1 is skipped, 2 is replayed, 3 arrives live
      const collected = yield* room.events(MessageAdded, { after: 1 }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped
      )
      // the third message is sent while the subscriber is between replay and live
      yield* room.SendMessage({ body: "three" })
      const events = yield* Fiber.join(collected)
      expect(events.map((e) => [e.sequence, e.event.message.body])).toEqual([[2, "two"], [3, "three"]])
    }))

  it.effect("a cross-actor intent is committed with the turn and delivered afterwards, with a System caller", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const room = yield* Chat.get(RoomId.make("r5"))

      const { turns } = yield* test.record(room.SendMessage({ body: "x" }))
      const sent = turns.find((t) => t.command === "SendMessage")!
      // both intents ride the same transaction: the shared counter and the author's own User actor
      expect(sent.intents.map((i) => [i.to.actor, i.to.id, i.command, i.input])).toEqual([
        ["Counter", "messages-sent", "Increment", 1],
        ["User", "alice", "NoteMessage", { roomId: "r5", messageId: sent.commandId }]
      ])

      const inc = yield* test.turns.next(Counter, CounterId.make("messages-sent"))
      expect(inc.trigger).toBe("intent")
      expect(inc.caller).toEqual(Caller.system("actor", { ref: sent.ref, onBehalfOf: member }))
    }))

  it.effect("the query layer answers on the caller's node against committed rows, without waking the actor", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = RoomId.make("r6")
      const room = yield* Chat.get(id)
      yield* room.SendMessage({ body: "x" })
      yield* test.clock.advance("6 minutes") // Hibernate.after("5 minutes")

      const recent = yield* room.Recent({ limit: 10 })
      expect(recent).toHaveLength(0) // the sketch's Recent returns []; the real one reads `messages`
      expect((yield* test.inspect(Chat, id)).resident).toBe(false)
      expect(yield* room.Recent({ limit: 10 }).pipe(Actor.as(stranger), Effect.flip)).toEqual(new NotAMember({ userId: "mallory" }))
    }))

  it.effect("tenants never see each other's rows, timers or events", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = RoomId.make("shared-id")
      const acme = yield* Chat.get(id, { tenant: TenantId.make("acme") })
      const globex = yield* Chat.get(id, { tenant: TenantId.make("globex") })
      yield* acme.SendMessage({ body: "acme" })
      yield* globex.SendMessage({ body: "globex" })
      // the same id in two tenants is two actors: the ref carries the tenant
      expect(acme.ref).not.toEqual(globex.ref)
      const acmeState = yield* test.inspect(Chat, id).pipe(Actor.tenant(TenantId.make("acme")))
      const bodies = acmeState.events
        .map((e) => e.event)
        .filter((e): e is MessageAdded => e._tag === "MessageAdded")
        .map((e) => e.message.body)
      expect(bodies).toEqual(["acme"])
    }))
})
