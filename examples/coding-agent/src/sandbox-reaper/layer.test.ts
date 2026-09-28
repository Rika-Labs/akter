import { BunCrypto } from "@effect/platform-bun"
import { User } from "@durable-actors/core"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, DateTime, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { fakeLayer, fakeSandboxes } from "../coding-agent/sandbox.ts"
import { SandboxReaper } from "./contract.ts"
import { SandboxReaperLive } from "./layer.ts"

const fake = fakeSandboxes()

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
    return SandboxReaperLive.pipe(
      Layer.provide(fakeLayer(fake)),
      Layer.provideMerge(
        ActorTest.layer({ database: yield* database, as: User.make({ subject: "ops" }) }),
      ),
    )
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

it("kills only sandboxes older than a day, and records a rerun sweep once", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const hours = (n: number) => now - n * 3_600_000

      for (const [sandboxId, startedAt] of [
        ["old", hours(25)],
        ["fresh", hours(1)],
      ] as const)
        fake.sandboxes.set(sandboxId, { sandboxId, repo: "r", startedAt, paused: false })

      // The first sweep's result is lost after it killed the sandbox, so the relay runs it again.
      yield* test.crashNext("afterExecute")
      const reaper = yield* SandboxReaper.get()
      yield* reaper.Sweep()

      while (fake.sandboxes.has("old")) yield* Effect.sleep("20 millis")
      yield* test.advance("2 minutes")

      expect([...fake.sandboxes.keys()]).toEqual(["fresh"])
      expect(yield* test.receiptsFor(reaper.ref, "Swept")).toBe(1)
      expect((yield* test.inspect(reaper.ref)).state).toMatchObject({ sweeps: 1 })
    }),
  ))
