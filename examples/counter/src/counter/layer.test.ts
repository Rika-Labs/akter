import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { Pool } from "pg"
import { SqlClient } from "effect/unstable/sql"
import { afterAll, expect, it } from "vitest"
import { Counter, Snapshot } from "./contract.ts"
import { CounterLive } from "./layer.ts"

// The same cases run on PGlite (`test`) and on a fresh Postgres database (`test:integration`).
const database = Effect.gen(function* () {
  if ((yield* Config.String("COUNTER_BACKEND")) === "pglite") return undefined

  const base = new URL(yield* Config.String("TEST_DATABASE_URL"))
  const name = `counter_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

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
    return CounterLive.pipe(Layer.provideMerge(ActorTest.layer({ database: yield* database })))
  }),
).pipe(Layer.provide(BunCrypto.layer), Layer.orDie)

const runtime = ManagedRuntime.make(live)

afterAll(() => runtime.dispose())

it("recovers the runnable counter across pre-commit and post-commit faults", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const counter = yield* Counter.get("example")

      for (const point of ["beforeCommit", "afterCommit"] as const) {
        yield* test.crashNext(point)
        const call = counter.Increment(point === "beforeCommit" ? 7 : 3)
        expect(yield* call).toBe(point === "beforeCommit" ? 7 : 10)
        expect(yield* call).toBe(point === "beforeCommit" ? 7 : 10)
      }

      expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 10 }, receipts: 2 })
    }),
  ))

it("resumes a sleeping workflow on the framework clock and replays its result", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const sql = yield* SqlClient.SqlClient
      const counter = yield* Counter.get("workflow")
      const run = yield* counter.Double({ value: 21 })

      // The pause's due time is recorded when the body reaches it, so advance only after it suspends.
      yield* sql<{ status: string }>`SELECT status FROM actor_workflow_executions
        WHERE execution_id = ${run.executionId}`.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (rows) => rows[0]?.status === "suspended",
        }),
      )
      yield* test.advance("61 seconds")
      expect(yield* run.result).toBe(42)
      const again = yield* counter.Double({ value: 21 })
      expect(again.executionId).toBe(run.executionId)
      expect(yield* again.result).toBe(42)
    }),
  ))

it("mints the same snapshot id when a checkpoint turn is retried after a crash", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const counter = yield* Counter.get("checkpointed")
      yield* counter.Increment(4)
      yield* test.crashNext("beforeCommit")
      const call = counter.Checkpoint()
      const id = yield* call

      expect(yield* call).toBe(id)
      yield* test.advance(0)

      const snapshot = yield* Snapshot.get(id as Parameters<typeof Snapshot.get>[0])
      expect(yield* snapshot.Recorded()).toBe(4)
      expect(yield* test.receiptsFor(snapshot.ref, "Record")).toBe(1)
    }),
  ))
