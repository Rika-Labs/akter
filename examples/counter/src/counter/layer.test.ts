import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@durable-actors/core/testing"
import { Config, Crypto, Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { Pool } from "pg"
import { afterAll, expect, it } from "vitest"
import { Counter } from "./contract.ts"
import { CounterLive } from "./layer.ts"

const live = Layer.unwrap(
  Effect.gen(function* () {
    const database = new URL(yield* Config.String("TEST_DATABASE_URL"))
    const name = `counter_${(yield* (yield* Crypto.Crypto).randomUUIDv4).replaceAll("-", "")}`

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: database.href })),
      (db) => Effect.promise(() => db.end()),
    )

    yield* Effect.acquireRelease(
      Effect.promise(() => pool.query(`CREATE DATABASE "${name}"`)),
      () => Effect.promise(() => pool.query(`DROP DATABASE "${name}" WITH (FORCE)`)),
    )
    database.pathname = `/${name}`

    return CounterLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database: Redacted.make(database.href) })),
    )
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
