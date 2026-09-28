import { BunCrypto } from "@effect/platform-bun"
import { type ActorRef, User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import {
  Config,
  Crypto,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Predicate,
  Redacted,
} from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { AgentId, CodingAgent, NoActiveTurn, TurnInProgress } from "./contract.ts"
import { CodingAgentLive } from "./layer.ts"
import { fakeLayer, fakeSandboxes } from "./sandbox.ts"

const fake = fakeSandboxes()

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("CODING_AGENT_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `agent_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

  const admin = yield* Effect.acquireRelease(
    Effect.sync(() => new Pool({ connectionString: base.href })),
    (pool) => Effect.promise(() => pool.end()),
  )

  yield* Effect.acquireRelease(
    Effect.promise(() => admin.query(`CREATE DATABASE "${name}"`)),
    () => Effect.promise(() => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
  )
  base.pathname = `/${name}`

  return Redacted.make(base.href)
})

const live = Layer.unwrap(
  Effect.gen(function* () {
    return CodingAgentLive.pipe(
      Layer.provide(fakeLayer(fake)),
      Layer.provideMerge(
        ActorTest.layer({ database: yield* database, as: User.make({ subject: "ada" }) }),
      ),
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
      const turnId = yield* agent.Prompt({ text: "hello" })
      yield* test.advance(0)

      expect(yield* agent.Transcript({ limit: 10 })).toEqual([
        { turnId, prompt: "hello", reply: "Done: hello", status: "replied" },
      ])
      expect(yield* test.inspect(agent.ref)).toMatchObject({
        rows: { agent_turns: 1 },
        events: 3,
        state: { sandboxId: expect.any(String) },
      })

      // The reply's deltas left the executor as progress frames; none are stored.
      const frames = (yield* test.progress).flatMap((record) =>
        Predicate.isTagged(record, "Progress") && record.ref.id === "g1" && !record.dropped
          ? [new TextDecoder().decode(record.frame)]
          : [],
      )

      expect(frames.length).toBeGreaterThan(0)
      expect(frames.every((frame) => frame.includes(turnId))).toBe(true)
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

      // The sandbox answers after the abort; the late reply finds no running turn.
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

      // The crashed attempt keeps its lease; the relay runs it again once the lease has passed.
      while (![...fake.prompts.keys()].some((key) => !before.has(key)))
        yield* Effect.sleep("20 millis")
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
