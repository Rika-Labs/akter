// Typecheck-only sketch: the reference program under test. The model and the tools are fakes; everything else is real.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { ActorTest } from "../framework/Testing.ts"
import { AgentSession, PromptQueued, SessionId, ToolFinished, TurnFinished, UnknownToolCall } from "./AgentSession.ts"
import { AgentSessionLive, Model, Tools } from "./AgentSession.server.ts"

// the activation's services are ordinary layers: the model streams the prompt back word by word
const ModelTest = Layer.succeed(Model, { stream: (prompt) => Stream.make(...prompt.split(" ")) })
const ToolsTest = Layer.succeed(Tools, { run: (name, args) => Effect.succeed(`${name}(${args})`) })

const TestLive = AgentSessionLive.pipe(
  Layer.provide(Layer.mergeAll(ModelTest, ToolsTest)),
  Layer.provideMerge(ActorTest.layer())
)

it.layer(TestLive)("AgentSession", (it) => {
  it.effect("a prompt is one turn: PromptQueued committed, nothing in the outbox (the model is the run loop, not an effect)", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s1")
      const session = yield* AgentSession.get(id)

      const turnId = yield* session.SendPrompt({ text: "fix the build" })
      const state = yield* test.inspect(AgentSession, id)
      expect(state.events.map((e) => e.event)).toEqual([new PromptQueued({ turnId, prompt: "fix the build" })])
      expect(state.outbox).toEqual([])
      // the turn id is the command id the receipt is keyed on
      expect(state.receipts.map((r) => r.commandId)).toEqual([turnId])
    }))

  it.effect("the run loop's answer comes back as a durable intent and finishes the turn", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s2")
      const session = yield* AgentSession.get(id)

      const turnId = yield* session.SendPrompt({ text: "hello" })
      // the loop reads the committed event, calls the model outside the transaction, then sends ModelReplied to itself
      const replied = yield* test.turns.next(AgentSession, id)
      expect(replied.command).toBe("ModelReplied")
      expect(replied.trigger).toBe("intent")
      expect(replied.emitted).toEqual([new TurnFinished({ turnId, text: "hello" })])
      // the cursor advanced with the same turn that emitted TurnFinished
      expect(replied.stateWritten).toEqual(["processedUpTo"])
    }))

  it.effect("a reconnecting client resumes from its cursor and sees exactly the turns it missed", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s3")
      const session = yield* AgentSession.get(id)
      yield* session.SendPrompt({ text: "one" })
      yield* test.turns.next(AgentSession, id)
      const cursor = (yield* test.inspect(AgentSession, id)).events.at(-1)?.sequence ?? 0

      // `after` is exclusive: nothing already seen is replayed
      const missed = yield* session.events(TurnFinished, { after: cursor }).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* session.SendPrompt({ text: "two" })
      expect((yield* Fiber.join(missed)).map((e) => e.sequence > cursor)).toEqual([true])
    }))

  it.effect("Tokens is live only: a connection opened after a turn sees only what is produced from now on", () =>
    Effect.gen(function*() {
      const session = yield* AgentSession.get(SessionId.make("s4"))
      yield* session.SendPrompt({ text: "already done" })
      const conn = yield* session.Tokens()
      const frames = yield* conn.frames.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* session.SendPrompt({ text: "second prompt" })
      expect((yield* Fiber.join(frames)).map((t) => t.text)).toEqual(["second"])
    }).pipe(Effect.scoped))

  it.effect("ApproveTool with an unknown call is a declared error, and its effect rolls back with the turn", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s5")
      const session = yield* AgentSession.get(id)
      // a fake executor for the rest of the scope: the real tool never runs in this test
      yield* test.effects.override(AgentSession, {
        RunTool: (ctx, effect) => ctx.self.ToolFinished.send({ callId: effect.callId, output: `fake:${effect.name}` })
      })

      const err = yield* session.ApproveTool({ callId: "nope" }).pipe(Effect.flip)
      expect(err).toEqual(new UnknownToolCall({ callId: "nope" }))
      // the handler failed before `perform`, so nothing reached the outbox
      expect(yield* test.effects.pending(AgentSession, id)).toEqual([])
      expect((yield* test.inspect(AgentSession, id)).events).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("Cancel is a turn of its own: it emits Cancelled and later prompts keep working", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s6")
      const session = yield* AgentSession.get(id)
      const turnId = yield* session.SendPrompt({ text: "x" })

      yield* session.Cancel({ turnId })
      const events = (yield* test.inspect(AgentSession, id)).events
      expect(events.map((e) => e.event._tag)).toContain("Cancelled")

      yield* session.SendPrompt({ text: "again" })
      const after = yield* test.inspect(AgentSession, id)
      // the cursor is gap-free across every turn of this actor
      expect(after.events.map((e) => e.sequence)).toEqual(after.events.map((_, i) => i + 1))
    }))

  it.effect("committed-but-reply-lost: the redelivered prompt replays the receipt instead of queueing twice", () =>
    Effect.gen(function*() {
      const session = yield* ActorTest.pipe(Effect.flatMap((test) => test.actor(AgentSession, SessionId.make("s7"))))
      yield* session.crash({ at: "after-commit", command: "SendPrompt" })
      const turnId = yield* session.handle.SendPrompt({ text: "x" })

      expect((yield* session.turns).map((t) => [t.trigger, t.replayed])).toEqual([["call", false], ["redelivery", true]])
      const state = yield* session.inspect
      expect(state.events.map((e) => e.event)).toEqual([new PromptQueued({ turnId, prompt: "x" })])
      expect(state.receipts).toHaveLength(1)
    }))

  it.effect("a session that idles past Hibernate.after wakes on the next prompt with its rows intact", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const id = SessionId.make("s8")
      const session = yield* AgentSession.get(id)
      yield* session.SendPrompt({ text: "x" })
      yield* test.clock.advance("11 minutes")
      expect((yield* test.inspect(AgentSession, id)).resident).toBe(false)
      yield* session.SendPrompt({ text: "y" })
      expect((yield* test.inspect(AgentSession, id)).events.filter((e) => e.event._tag === "PromptQueued")).toHaveLength(2)
    }))
})

// `ToolFinished` is internal: it is reachable from an executor's `ctx.self`, never from an outside handle
export type _ToolFinishedIsInternal = typeof ToolFinished
