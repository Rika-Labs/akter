// Typecheck-only sketch: the CodingAgent example under test. Nothing about the actor is mocked — the real turn, the
// real run loop, the real outbox — only the two application services at the edge (E2B sandboxes, the OpenCode server)
// are in-memory fakes whose event feed the test pushes by hand.
import { it } from "@effect/vitest"
import { expect } from "vitest"
import { Cause, Context, Effect, Fiber, Layer, Option, Queue, Ref, Stream } from "effect"
import { Actor, Actors } from "../framework/Actor.ts"
import type { CommandContext } from "../framework/Actor.ts"
import { ActorTest } from "../framework/Testing.ts"
import {
  agentTurns,
  CodingAgent,
  Delta,
  Done,
  RunPrompt,
  Ship
} from "./CodingAgent.ts"
import { CodingAgentLive, CodingAgentReads } from "./CodingAgent.server.ts"
import { OrgId, UserId } from "./Principal.ts"
import type { OpenCodeClient, OpenCodeEvent, SandboxId as SandboxIdType } from "./services.ts"
import { OpenCode, OpenCodeError, OpenCodeSessionId, Sandboxes, SandboxGone, SandboxId } from "./services.ts"

// ---------------------------------------------------------------------------------------------------
// The edges: in-memory sandboxes and one OpenCode server whose event bus the test drives
// ---------------------------------------------------------------------------------------------------

const session = OpenCodeSessionId.make("session-1")
const hostOf = (id: SandboxIdType) => `${id}.sandbox.test`

class Fakes extends Context.Service<Fakes, {
  /** the OpenCode event bus: the run loop subscribes, the test offers `Delta` / `Idle` / `Error` */
  readonly events: Queue.Queue<OpenCodeEvent>
  readonly session: OpenCodeSessionId
  /** sandbox ids whose `connect` fails with `SandboxGone` */
  readonly gone: Ref.Ref<ReadonlyArray<SandboxIdType>>
  readonly paused: Ref.Ref<ReadonlyArray<SandboxIdType>>
  readonly created: Ref.Ref<number>
}>()("test/CodingAgent/Fakes") {}

const FakesLive = Layer.effect(
  Fakes,
  Effect.gen(function*() {
    return {
      events: yield* Queue.make<OpenCodeEvent>(),
      session,
      gone: yield* Ref.make<ReadonlyArray<SandboxIdType>>([]),
      paused: yield* Ref.make<ReadonlyArray<SandboxIdType>>([]),
      created: yield* Ref.make(0)
    }
  })
)

const SandboxesFake = Layer.effect(
  Sandboxes,
  Effect.gen(function*() {
    const fakes = yield* Fakes
    return {
      create: () =>
        Effect.gen(function*() {
          const n = yield* Ref.updateAndGet(fakes.created, (n) => n + 1)
          const id = SandboxId.make(`sb-${n}`)
          return { id, host: hostOf(id) }
        }),
      connect: (id: SandboxIdType) =>
        Effect.flatMap(
          Ref.get(fakes.gone),
          (gone) => gone.includes(id) ? Effect.fail(new SandboxGone({ sandboxId: id })) : Effect.succeed({ id, host: hostOf(id) })
        ),
      pause: (id: SandboxIdType) => Ref.update(fakes.paused, (all) => [...all, id]),
      kill: (id: SandboxIdType) => Ref.update(fakes.gone, (all) => [...all, id]),
      list: Effect.succeed([])
    }
  })
)

const OpenCodeFake = Layer.effect(
  OpenCode,
  Effect.gen(function*() {
    const fakes = yield* Fakes
    const client: OpenCodeClient = {
      createSession: Effect.succeed(fakes.session),
      prompt: () => Effect.void, // promptAsync: the answer arrives on `events`
      abort: () => Effect.void,
      events: Stream.fromQueue(fakes.events)
    }
    return { connect: (_host: string) => client }
  })
)

const Edges = Layer.mergeAll(SandboxesFake, OpenCodeFake).pipe(Layer.provideMerge(FakesLive))

const principal = { userId: UserId.make("u1"), orgId: OrgId.make("o1"), roles: ["member"] as const }

const TestLive = Layer.mergeAll(CodingAgentLive, CodingAgentReads).pipe(
  Layer.provideMerge(Edges),
  Layer.provideMerge(ActorTest.layer({ as: principal }))
)

/** what OpenCode does when a turn ends: some deltas, then idle */
const streamReply = (fakes: Fakes["Service"], chunks: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    for (const text of chunks) yield* Queue.offer(fakes.events, { _tag: "Delta", sessionId: fakes.session, text })
    yield* Queue.offer(fakes.events, { _tag: "Idle", sessionId: fakes.session })
  })

it.layer(TestLive)("CodingAgent", (it) => {
  /** Start + run the held StartSandbox so the executor reports SandboxReady: the agent is booted and idle. */
  const booted = Effect.gen(function*() {
    const test = yield* ActorTest
    const agent = yield* test.create(CodingAgent) // minted id: nothing is written until Start commits
    yield* agent.handle.Start({ repo: "github.com/acme/app" })
    yield* test.effects.run
    yield* test.settle
    return agent
  })

  it.effect("a command before the creating command fails NotCreated; Start only queues the sandbox boot", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const agent = yield* test.create(CodingAgent)

      // Lifecycle.createdBy(Start): NotCreated is a framework reason, not a declared error
      const notCreated = yield* agent.handle.Prompt({ text: "hi" }).pipe(
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e)),
        Effect.flip
      )
      expect(notCreated._tag).toBe("ActorError")
      expect(notCreated.reason._tag).toBe("NotCreated")
      expect((yield* agent.inspect).exists).toBe(false)

      yield* agent.handle.Start({ repo: "github.com/acme/app" })
      const state = yield* agent.inspect
      expect(state.exists).toBe(true)
      // effects are held: the boot is a committed outbox row, nothing ran
      expect(state.outbox.map((o) => o.effect._tag)).toEqual(["StartSandbox"])
      // SandboxStarted is emitted by SandboxReady, never by Start
      expect(state.events).toEqual([])
    }))

  it.effect("boot, prompt, deltas and reply: one turn per durable fact, the turnId is the commandId", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const fakes = yield* Fakes
      const agent = yield* booted

      const afterBoot = yield* agent.inspect
      expect(afterBoot.events.map((e) => e.event._tag)).toEqual(["SandboxStarted"])
      // no turn pending when the sandbox came up: the 15-minute idle timer is armed instead
      expect(afterBoot.timers.map((t) => t.key)).toEqual(["idle"])

      const turnId = yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      expect(turnId).toBe("t1") // ctx.commandId is the turn id: a retried Prompt is the same turn

      const prompted = yield* agent.inspect
      expect(prompted.timers).toEqual([]) // a running turn is not idle
      const performed = prompted.outbox.map((o) => o.effect)
      expect(performed.map((e) => e._tag)).toEqual(["RunPrompt"])
      const run = performed[0]
      if (run?._tag === "RunPrompt") {
        expect(run.turnId).toBe("t1")
        expect(run.sessionId).toBe(session) // the session lives in state; RunPrompt never creates one
      }

      // the Live connection is ephemeral: deltas while the turn runs, Done when it finishes
      const live = yield* agent.handle.Live()
      const frames = yield* live.frames.pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped)

      yield* test.effects.run // RunPrompt: queues the prompt with OpenCode
      yield* streamReply(fakes, ["he", "llo"])
      expect(yield* Fiber.join(frames)).toEqual([
        new Delta({ turnId: "t1", text: "he" }),
        new Delta({ turnId: "t1", text: "llo" }),
        new Done({ turnId: "t1" })
      ])

      const done = yield* agent.next()
      expect(done.command).toBe("TurnDone")
      const replied = yield* agent.inspect
      expect(replied.events.map((e) => e.event._tag)).toEqual(["SandboxStarted", "Prompted", "Replied"])
      const last = replied.events[2]?.event
      if (last?._tag === "Replied") {
        expect(last.turnId).toBe("t1")
        expect(last.text).toBe("hello")
      }
      const rows = yield* agent.rows(agentTurns)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe("replied")
      expect(rows[0]?.reply).toBe("hello")
      expect(replied.timers.map((t) => t.key)).toEqual(["idle"]) // re-armed by TurnDone
    }))

  it.effect("a Prompt whose reply was lost is not a second turn: the receipt is replayed", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const agent = yield* booted

      yield* agent.crash({ at: "after-commit", command: "Prompt" })
      const turnId = yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      expect(turnId).toBe("t1")

      const prompts = (yield* agent.turns).filter((t) => t.command === "Prompt")
      expect(prompts.map((t) => [t.trigger, t.replayed])).toEqual([["call", false], ["redelivery", true]])
      const state = yield* agent.inspect
      expect(state.events.filter((e) => e.event._tag === "Prompted")).toHaveLength(1)
      expect(yield* agent.rows(agentTurns)).toHaveLength(1)

      // same commandId, different text: the receipt does not match
      const conflict = yield* agent.handle.Prompt({ text: "something else" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e)),
        Effect.flip
      )
      expect(conflict.reason._tag).toBe("CommandConflict")
      expect(yield* agent.rows(agentTurns)).toHaveLength(1)
    }))

  it.effect("one turn at a time: a second Prompt fails TurnInProgress, and a reply for an aborted turn is ignored", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const fakes = yield* Fakes
      const agent = yield* booted

      yield* agent.handle.Prompt({ text: "long job" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      // TurnInProgress is a declared error: it is never wrapped in an ActorError
      const busy = yield* agent.handle.Prompt({ text: "me too" }).pipe(
        Effect.catchTag("ActorError", (e) => Effect.die(e)),
        Effect.flip
      )
      expect(busy._tag).toBe("TurnInProgress")
      expect(busy.turnId).toBe("t1")

      yield* test.effects.run // RunPrompt is out, the run loop is following the session
      yield* agent.handle.Abort()
      const aborted = yield* agent.inspect
      expect(aborted.events.filter((e) => e.event._tag === "Aborted")).toHaveLength(1)
      expect(aborted.outbox.map((o) => o.effect._tag)).toEqual(["AbortPrompt"])
      expect((yield* agent.rows(agentTurns))[0]?.status).toBe("aborted")

      // OpenCode goes idle anyway: TurnDone arrives for a turn that is no longer active and changes nothing
      yield* streamReply(fakes, ["too", " late"])
      yield* test.settle
      // and the same internal command delivered directly, as the run loop of a later activation might: still ignored
      yield* agent.system.TurnDone({ turnId: "t1", text: "too late" })
      const after = yield* agent.inspect
      expect(Option.map(after.state, (s) => Option.isNone(s.activeTurn))).toEqual(Option.some(true))
      expect(after.events.filter((e) => e.event._tag === "Aborted")).toHaveLength(1)
      expect(after.events.filter((e) => e.event._tag === "Replied")).toEqual([])
      expect((yield* agent.rows(agentTurns))[0]?.status).toBe("aborted")
    }))

  it.effect("idle pauses the sandbox, hibernation drops the activation, and the transcript answers from rows", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const fakes = yield* Fakes
      const agent = yield* booted

      yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      yield* test.effects.run
      yield* streamReply(fakes, ["hello"])
      yield* agent.next()

      yield* test.clock.advance("15 minutes") // the idle timer fires
      yield* test.settle
      const paused = yield* agent.inspect
      expect(paused.outbox.map((o) => o.effect._tag)).toEqual(["PauseSandbox"])
      expect(paused.events.filter((e) => e.event._tag === "SandboxPaused")).toHaveLength(1)
      expect(paused.timers).toEqual([]) // Idle does not re-arm itself

      yield* test.clock.advance("5 minutes") // Hibernate.after("5 minutes")
      expect((yield* agent.inspect).resident).toBe(false)

      // a query never touches the entity: no activation, same committed rows
      const transcript = yield* agent.handle.Transcript({ limit: 10 })
      expect(transcript.map((t) => [t.turnId, t.status])).toEqual([["t1", "replied"]])
      expect((yield* agent.inspect).resident).toBe(false)
    }))

  it.effect("an effect that keeps failing is dead-lettered, and onEffectFailed fails the turn inside a turn", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const actors = yield* Actors
      const agent = yield* booted

      yield* test.effects.fail(
        CodingAgent,
        RunPrompt,
        Cause.fail(new OpenCodeError({ op: "prompt", reason: "boom" })),
        { times: "always" }
      )
      yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      yield* test.effects.drain // five exponential retries, then the dead letter

      const state = yield* agent.inspect
      expect(state.outbox).toEqual([])
      expect(state.deadLetters.map((d) => d.effect._tag)).toEqual(["RunPrompt"])
      // the hook ran inside a turn and wrote: the active turn is failed, not left running
      const last = state.events[state.events.length - 1]?.event
      expect(last?._tag).toBe("Aborted")
      if (last?._tag === "Aborted") expect(last.reason).toBe("RunPrompt failed")
      expect((yield* agent.rows(agentTurns))[0]?.status).toBe("failed")

      const letters = yield* actors.deadLetters.list({ ref: agent.ref })
      expect(letters.map((d) => d.effect._tag)).toEqual(["RunPrompt"])
      const letter = letters[0]
      if (letter === undefined) return
      yield* actors.deadLetters.retry(letter.id)
      expect((yield* agent.inspect).outbox.map((o) => [o.effect._tag, o.attempt])).toEqual([["RunPrompt", 0]])
    }))

  it.effect("a sandbox that is gone is not retried: the actor drops it and boots a new one for the pending turn", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const fakes = yield* Fakes
      const agent = yield* booted

      const boot = (yield* agent.inspect).events[0]?.event
      if (boot?._tag !== "SandboxStarted") return
      yield* Ref.update(fakes.gone, (all) => [...all, boot.sandboxId])

      yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      yield* test.effects.run // RunPrompt sees SandboxGone and reports SandboxLost as an intent
      yield* test.settle

      expect((yield* agent.turns).map((t) => t.command)).toContain("SandboxLost")
      const state = yield* agent.inspect
      // the sandbox and session are forgotten, the turn is still pending, so the agent starts over
      expect(Option.map(state.state, (s) => [Option.isNone(s.sandboxId), Option.isNone(s.sessionId), Option.isSome(s.activeTurn)])).toEqual(Option.some([true, true, true]))
      expect(state.outbox.map((o) => o.effect._tag)).toEqual(["StartSandbox"])
      expect((yield* agent.rows(agentTurns))[0]?.status).toBe("running")
      expect(state.events.filter((e) => e.event._tag === "SandboxStarted")).toHaveLength(1)
    }))

  it.effect("the Ship workflow survives an activity crash: the replayed activity does not prompt twice", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const fakes = yield* Fakes
      const agent = yield* booted
      const ship = agent.workflow(Ship, { key: "pr-1" })

      // afterBodyBeforeResult: the Prompt was sent, the result was not recorded; the retry replays the receipt
      // keyed `${executionId}:implement`
      yield* ship.crashActivity("implement", { at: "afterBodyBeforeResult" })
      const run = yield* agent.handle.Ship.start({ task: "add tests" }, { key: "pr-1" })

      // two turns: implement, then verify. Each is Prompt + RunPrompt + the run loop's deltas.
      for (const chunks of [["did", " it"], ["tests", " pass"]]) {
        yield* test.settle
        yield* test.effects.run
        yield* streamReply(fakes, chunks)
        yield* test.settle
      }

      const result = yield* run.result
      expect(result.turns).toBe(2)
      expect(result.summary).toBe("tests pass")

      const state = yield* agent.inspect
      expect(state.events.filter((e) => e.event._tag === "Prompted")).toHaveLength(2)
      expect(state.events.filter((e) => e.event._tag === "Replied")).toHaveLength(2)
      expect(yield* agent.rows(agentTurns)).toHaveLength(2)
      // the activity's commandId was used once: the second attempt replayed its receipt
      const prompts = state.receipts.filter((r) => r.command === "Prompt")
      expect(prompts).toHaveLength(2)
      expect(new Set(prompts.map((r) => r.commandId)).size).toBe(2)

      const settled = yield* ship.settled()
      expect(settled.status).toBe("completed")
      expect(settled.activities.map((a) => [a.name, a.attempts])).toEqual([["implement", 2], ["verify", 1]])
    }))

  it.effect("a V1 state row left by an older deployment is upcast by `migrations` on the next turn, once", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const agent = yield* test.create(CodingAgent)
      yield* agent.handle.Start({ repo: "github.com/acme/app" })
      // what the V1 deployment persisted: no `model` key (StateV1), a sandbox already booted
      yield* agent.seed({ state: { repo: "github.com/acme/app", sandboxId: "sb-old", sessionId: "session-old" } })

      // `inspect` decodes through the migration chain without waking the actor: the V2 default is visible
      const seeded = yield* agent.inspect
      expect(Option.map(seeded.state, (s) => s.model)).toEqual(Option.some("anthropic/claude-sonnet-4"))
      expect(Option.map(seeded.state, (s) => Option.getOrUndefined(s.sandboxId))).toEqual(Option.some("sb-old"))

      // the next turn loads V1 through `migrations`, so the handler sees `model` and keeps the seeded sandbox
      const turnId = yield* agent.handle.Prompt({ text: "still here?" }).pipe(
        Actor.commandId("t1"),
        Effect.catchTag("TurnInProgress", (e) => Effect.die(e))
      )
      expect(turnId).toBe("t1")
      const after = yield* agent.inspect
      // the handler ran RunPrompt against the seeded sandbox and session: the migration preserved V1's keys
      expect(after.outbox.map((o) => o.effect._tag === "RunPrompt" ? [o.effect.sandboxId, o.effect.sessionId] : o.effect._tag)).toEqual([["sb-old", "session-old"]])
      expect(Option.map(after.state, (s) => s.model)).toEqual(Option.some("anthropic/claude-sonnet-4"))
      // the migrated shape is what handlers are typed with
      type Ctx = CommandContext<typeof CodingAgent>
      const modelIsString: Ctx["state"]["model"] extends string ? true : false = true
      expect(modelIsString).toBe(true)
    }))
})

// ---------------------------------------------------------------------------------------------------
// Two runners, one storage, real serialization: a turn interrupted by runner death is applied once.
// ---------------------------------------------------------------------------------------------------

const ClusterLive = Layer.mergeAll(CodingAgentLive, CodingAgentReads).pipe(
  Layer.provideMerge(Edges),
  Layer.provideMerge(ActorTest.layer({ as: principal, runners: 2 }))
)

it.layer(ClusterLive)("CodingAgent (cluster)", (it) => {
  it.effect("killing the runner mid-Prompt rolls its transaction back; the survivor applies the turn once", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const agent = yield* test.create(CodingAgent)
      yield* agent.handle.Start({ repo: "github.com/acme/app" })
      yield* test.effects.run
      yield* test.settle

      const host = yield* test.cluster.runnerOf(CodingAgent, agent.id)
      expect(Option.isSome(host)).toBe(true)
      if (Option.isNone(host)) return

      const paused = yield* agent.pause({ at: "before-commit", command: "Prompt" })
      const inFlight = yield* agent.handle.Prompt({ text: "say hello" }).pipe(
        Actor.commandId("t1"),
        Effect.exit,
        Effect.forkScoped
      )
      yield* paused.reached
      yield* test.cluster.kill(host.value)

      yield* test.clock.advance("20 seconds") // shardLockExpiration is 35s: no takeover yet
      expect((yield* agent.inspect).events.filter((e) => e.event._tag === "Prompted")).toEqual([])

      yield* test.clock.advance("20 seconds")
      yield* test.settle

      const prompts = (yield* agent.turns).filter((t) => t.command === "Prompt")
      expect(prompts.map((t) => [t.trigger, t.exit._tag])).toEqual([["call", "Failure"], ["redelivery", "Success"]])
      const state = yield* agent.inspect
      expect(state.events.filter((e) => e.event._tag === "Prompted")).toHaveLength(1)
      expect(yield* agent.rows(agentTurns)).toHaveLength(1)
      expect((yield* Fiber.join(inFlight))._tag).toBe("Success")
    }))
})
