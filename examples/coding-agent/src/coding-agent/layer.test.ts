import { BunCrypto } from "@effect/platform-bun"
import { type ActorRef } from "@durable-actors/core"
import { ActorTest, testDatabase } from "@durable-actors/core/testing"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Predicate, Schema, Stream } from "effect"
import { afterAll, expect, it } from "vitest"
import { AgentId, CodingAgent, Delta, Ended, NoActiveTurn, TurnInProgress } from "./contract.ts"
import { CodingAgentLive } from "./layer.ts"
import { fakeLayer, fakeSandboxes } from "./sandbox.ts"

const fake = fakeSandboxes()

const live = Layer.unwrap(
  Effect.gen(function* () {
    return CodingAgentLive.pipe(
      Layer.provide(fakeLayer(fake)),
      Layer.provideMerge(ActorTest.layer({ database: yield* testDatabase })),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof live>>) =>
  runtime.runPromise(effect)

/** Starts an agent and waits until its sandbox is ready. */
const started = Effect.fnUntraced(function* (id: string) {
  const test = yield* ActorTest
  const agent = yield* CodingAgent.get(AgentId.make(id))
  yield* agent.Start({ repo: "github.com/acme/app" })
  yield* test.advance(0)

  return agent
})

/** The agent's sandbox as the provider sees it. */
const sandboxOf = Effect.fnUntraced(function* (ref: ActorRef) {
  const { state } = yield* (yield* ActorTest).inspect(ref)
  const sandboxId = (state as { readonly sandboxId?: string }).sandboxId

  return sandboxId === undefined ? undefined : fake.sandboxes.get(sandboxId)
})

it("runs a prompt in the sandbox, streams progress, and records the reply", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g1")
      fake.paceMs = 100
      const turnId = yield* agent.Prompt({ text: "hello" })

      const streamed = yield* agent.Streaming({ turnId }).pipe(Stream.runCollect, Effect.forkChild)

      yield* Effect.sleep("200 millis")
      yield* test.advance(0)

      expect(yield* agent.Transcript({ limit: 10 })).toEqual([
        { turnId, prompt: "hello", reply: "Done: hello", status: "replied" },
      ])
      expect(yield* test.inspect(agent.ref)).toMatchObject({
        rows: { agent_turns: 1 },
        events: 3,
        state: { sandboxId: expect.any(String) },
      })

      const frames = (yield* test.progress).flatMap((record) =>
        Predicate.isTagged(record, "Progress") && record.ref.id === "g1" && !record.dropped
          ? [new TextDecoder().decode(record.frame)]
          : [],
      )

      expect(frames.length).toBeGreaterThan(0)
      expect(frames.every((frame) => frame.includes(turnId))).toBe(true)

      const elements = [...(yield* Fiber.join(streamed).pipe(Effect.timeout("10 seconds")))]
      const deltas = elements.filter((element) => Schema.is(Delta)(element))
      expect(deltas.length).toBeGreaterThan(0)
      expect(deltas.every(({ text }) => ["Done: ", "hello"].includes(text))).toBe(true)
      expect(elements.at(-1)).toEqual(Ended.make({ outcome: "replied", text: "Done: hello" }))
      fake.paceMs = 0
    }),
  ))

it("streams a finished turn's end to a subscriber that arrives after it", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g7")
      const turnId = yield* agent.Prompt({ text: "late" })
      yield* test.advance(0)

      const elements = yield* agent
        .Streaming({ turnId })
        .pipe(Stream.runCollect, Effect.timeout("10 seconds"))

      expect([...elements]).toEqual([Ended.make({ outcome: "replied", text: "Done: late" })])
    }),
  ))

it("starts one sandbox however many times Start is sent", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g6")
      const first = yield* agent.Sandbox()
      yield* agent.Start({ repo: "github.com/acme/other" })
      yield* test.advance(0)

      expect(yield* agent.Sandbox()).toBe(first)
      expect(
        [...fake.sandboxes.values()].filter(({ owner }) => owner.agentId === "g6"),
      ).toHaveLength(1)
      expect(yield* test.receiptsFor(agent.ref, "SandboxReady")).toBe(1)
    }),
  ))

it("refuses a second prompt while a turn runs, and drops the reply of an aborted turn", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g2")
      const gate = yield* Deferred.make<void>()
      fake.gate = gate

      const turnId = yield* agent.Prompt({ text: "slow" })
      expect(yield* agent.Prompt({ text: "again" }).pipe(Effect.flip)).toEqual(
        TurnInProgress.make({ turnId }),
      )

      yield* agent.Abort()
      expect(yield* agent.Abort().pipe(Effect.flip)).toEqual(NoActiveTurn.make({}))

      yield* Deferred.succeed(gate, undefined)
      yield* test.advance(0)
      expect(yield* test.receiptsFor(agent.ref, "Replied")).toBe(1)
      expect(yield* agent.Transcript({ limit: 10 })).toEqual([
        { turnId, prompt: "slow", reply: "", status: "aborted" },
      ])
    }),
  ))

it("records a reply once when the executor's result is lost and the prompt runs again", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g3")
      const before = new Set(fake.prompts.keys())

      yield* test.crashNext("afterExecute")
      yield* agent.Prompt({ text: "retry me" })

      yield* test.advance(0)
      expect([...fake.prompts].flatMap(([key, n]) => (before.has(key) ? [] : [n]))).toEqual([1])
      expect(yield* test.receiptsFor(agent.ref, "Replied")).toBe(0)

      yield* test.advance("2 minutes")

      expect([...fake.prompts].flatMap(([key, n]) => (before.has(key) ? [] : [n]))).toEqual([2])
      expect(yield* test.receiptsFor(agent.ref, "Replied")).toBe(1)
      expect(yield* agent.Transcript({ limit: 10 })).toMatchObject([
        { prompt: "retry me", reply: "Done: retry me", status: "replied" },
      ])
    }),
  ))

it("ships a task through two durable turns", () =>
  run(
    Effect.gen(function* () {
      const agent = yield* started("g4")
      const ship = yield* agent.Ship({ task: "add a --dry-run flag" })

      expect(yield* ship.result).toEqual({
        turns: 2,
        summary: "Done: Run the test suite, fix what broke, commit, and summarise what you did.",
      })
      expect((yield* agent.Transcript({ limit: 10 })).map(({ status }) => status)).toEqual([
        "replied",
        "replied",
      ])
    }),
  ))

it("pauses an idle sandbox and resumes it on the next prompt", () =>
  run(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const agent = yield* started("g5")
      yield* agent.Prompt({ text: "one" })
      yield* test.advance(0)

      yield* test.advance("15 minutes")
      expect((yield* sandboxOf(agent.ref))?.paused).toBe(true)
      expect(yield* test.receiptsFor(agent.ref, "Idle")).toBe(1)

      yield* agent.Prompt({ text: "two" })
      yield* test.advance(0)
      expect((yield* sandboxOf(agent.ref))?.paused).toBe(false)
      expect((yield* agent.Transcript({ limit: 1 }))[0]).toMatchObject({ reply: "Done: two" })
    }),
  ))
