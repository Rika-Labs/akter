// Typecheck-only sketch: the reference program under test. The model is a fake executor; everything else is real.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { ActorTest } from "../framework/Testing.ts"
import { AgentSession, CallModel, SessionId, TurnFinished, TurnStarted, UnknownToolCall } from "./AgentSession.ts"
import { AgentSessionLive } from "./AgentSession.server.ts"

const TestLive = AgentSessionLive.pipe(Layer.provideMerge(ActorTest.layer()))

it.layer(TestLive)("AgentSession", (it) => {
  it.effect("a prompt is one turn: TurnStarted committed, CallModel in the outbox, nothing else yet", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s1")
      const session = yield* AgentSession.get(id)

      const turnId = yield* session.SendPrompt({ text: "fix the build" })
      const state = yield* test.inspect(AgentSession, id)
      expect(state.events.map((e) => e.event)).toEqual([new TurnStarted({ turnId, prompt: "fix the build" })])
      expect(state.outbox.map((o) => o.effect)).toEqual([new CallModel({ turnId, prompt: "fix the build" })])
    }))

  it.effect("the model's reply comes back as a durable intent and finishes the turn", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s2")
      const session = yield* AgentSession.get(id)

      // the fake model: same executor contract, no network
      yield* test.effects.override(AgentSession, {
        CallModel: (effect, ctx) => ctx.self.ModelReplied.send({ turnId: effect.turnId, text: `echo: ${effect.prompt}` })
      })
      const turnId = yield* session.SendPrompt({ text: "hello" })
      yield* test.effects.run

      const replied = yield* test.turns.next(AgentSession, id)
      expect(replied.command).toBe("ModelReplied")
      expect(replied.trigger).toBe("intent")
      expect(replied.emitted).toEqual([new TurnFinished({ turnId, text: "echo: hello" })])
    }))

  it.effect("a reconnecting client resumes from its cursor and sees exactly the turns it missed", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s3")
      const session = yield* AgentSession.get(id)
      yield* test.effects.override(AgentSession, {
        CallModel: (effect, ctx) => ctx.self.ModelReplied.send({ turnId: effect.turnId, text: "ok" })
      })
      yield* session.SendPrompt({ text: "one" })
      yield* test.effects.run
      const cursor = (yield* test.inspect(AgentSession, id)).events.at(-1)?.sequence ?? 0

      const missed = yield* session.events(TurnFinished, { from: cursor }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* session.SendPrompt({ text: "two" })
      yield* test.effects.run
      expect((yield* Fiber.join(missed)).map((e) => e.sequence > cursor)).toEqual([true])
    }))

  it.effect("Tokens is live only: a stream opened after the turn sees nothing from it", () =>
    Effect.gen(function*() {
      const session = yield* AgentSession.get(SessionId.make("s4"))
      yield* session.SendPrompt({ text: "x" })
      const tokens = yield* session.Tokens().pipe(Stream.take(1), Stream.runCollect, Effect.orDie)
      expect(tokens.map((t) => t.text)).toEqual([""])
    }))

  it.effect("ApproveTool with an unknown call is a declared error, not a defect", () =>
    Effect.gen(function*() {
      const session = yield* AgentSession.get(SessionId.make("s5"))
      const err = yield* session.ApproveTool({ callId: "" }).pipe(Effect.flip)
      expect(err).toEqual(new UnknownToolCall({ callId: "" }))
    }))

  it.effect("Cancel terminates: rows, timers and outbox are gone; the next prompt starts a fresh generation", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s6")
      const session = yield* AgentSession.get(id)
      yield* session.SendPrompt({ text: "x" })
      const before = yield* test.inspect(AgentSession, id)

      yield* session.Cancel()
      const gone = yield* test.inspect(AgentSession, id)
      expect(gone.exists).toBe(false)
      expect(gone.outbox).toEqual([])
      expect(gone.events).toEqual([])

      yield* session.SendPrompt({ text: "again" })
      const after = yield* test.inspect(AgentSession, id)
      expect(after.generation).toBeGreaterThan(before.generation)
      expect(after.events.map((e) => e.sequence)).toEqual([1])
    }))

  it.effect("a session that idles past Hibernate.after wakes on the next prompt with its rows intact", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s7")
      const session = yield* AgentSession.get(id)
      yield* session.SendPrompt({ text: "x" })
      yield* test.clock.advance("11 minutes")
      expect((yield* test.inspect(AgentSession, id)).resident).toBe(false)
      yield* session.SendPrompt({ text: "y" })
      expect((yield* test.inspect(AgentSession, id)).events).toHaveLength(2)
    }))
})
