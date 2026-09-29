import { BunCrypto } from "@effect/platform-bun"
import { User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, DateTime, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { fakeLayer, fakeSandboxes } from "../coding-agent/sandbox.ts"
import { AgentId, CodingAgent } from "../coding-agent/contract.ts"
import { CodingAgentLive } from "../coding-agent/layer.ts"
import { SandboxReaper } from "./contract.ts"
import { SandboxReaperLive } from "./layer.ts"

const fake = fakeSandboxes()

const HOUR = 3_600_000

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("CODING_AGENT_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `reaper_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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
    return Layer.mergeAll(SandboxReaperLive, CodingAgentLive).pipe(
      Layer.provide(fakeLayer(fake)),
      Layer.provideMerge(
        ActorTest.layer({ database: yield* database, as: User.make({ subject: "ops" }) }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

it("sweeps on the hour, kills old sandboxes no agent uses, keeps the ones in use, and records a rerun sweep once", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const hours = (n: number) => now - n * 3_600_000

      // A live agent whose sandbox is more than a day old.
      const agent = yield* CodingAgent.get(AgentId.make("owner"))
      yield* agent.Start({ repo: "r" })
      yield* test.advance(0)
      const live = (yield* agent.Sandbox())!
      fake.sandboxes.set(live, { ...fake.sandboxes.get(live)!, startedAt: hours(30) })

      const sandbox = (sandboxId: string, agentId: string, startedAt: number) =>
        fake.sandboxes.set(sandboxId, {
          sandboxId,
          owner: { tenant: test.tenant, agentId },
          repo: "r",
          startedAt,
          paused: false,
        })

      sandbox("replaced", "owner", hours(26)) // its agent moved on to another sandbox
      sandbox("never-ready", "ghost", hours(25)) // its agent never recorded it
      sandbox("fresh", "ghost", hours(1))

      // The hourly tick's sweep kills the orphans, then loses its result, so the relay runs it again.
      yield* test.crashNext("afterExecute")
      const reaper = yield* SandboxReaper.get()
      const at = (yield* test.now).epochMilliseconds
      yield* test.advance(Math.ceil((at + 1) / HOUR) * HOUR - at)
      expect(yield* test.receiptsFor(reaper.ref, "Sweep")).toBe(1)

      // The advance waited for the attempt, so it has crashed and its lease has not moved.
      expect(fake.sandboxes.has("never-ready")).toBe(false)
      expect(yield* test.receiptsFor(reaper.ref, "Swept")).toBe(0)
      yield* test.advance("2 minutes")

      expect([...fake.sandboxes.keys()].sort()).toEqual(["fresh", live].sort())
      expect(yield* test.receiptsFor(reaper.ref, "Swept")).toBe(1)
      expect((yield* test.inspect(reaper.ref)).state).toMatchObject({ sweeps: 1 })
    }),
  ))
