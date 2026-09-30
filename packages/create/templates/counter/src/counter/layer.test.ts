import { BunCrypto } from "@effect/platform-bun"
import { Actors, Database } from "@durable-actors/core/runtime"
import { ActorTest } from "@durable-actors/core/testing"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Config, Effect, Layer, ManagedRuntime, Option } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Counter } from "./contract.ts"
import { CounterLive } from "./layer.ts"

/**
 * Postgres when DATABASE_URL is set, as in the app; otherwise a throwaway
 * PGlite directory.
 */
const url = Effect.runSync(
  Effect.gen(function* () {
    return yield* Config.option(Config.Redacted("DATABASE_URL"))
  }),
)
const dataDir = mkdtempSync(join(tmpdir(), "counter-"))
const database = Option.getOrElse(url, () => ({ dataDir }))

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

/** A runtime over the real turn path, with fault injection and inspection. */
const harness = () =>
  ManagedRuntime.make(
    CounterLive.pipe(
      Layer.provideMerge(ActorTest.layer({ database })),
      Layer.provide(BunCrypto.layer),
    ),
  )

/** The same wiring as `src/main.ts`, built fresh to model a process restart. */
/**
 * Opening a new PGlite directory runs initdb inside WebAssembly (about 2 s on a
 * laptop, over 5 s on a busy CI runner) and applies the framework's migrations,
 * so `beforeAll` opens it once and no test's own timeout pays for it.
 */
const app = () =>
  ManagedRuntime.make(
    CounterLive.pipe(
      Layer.provideMerge(Actors.layer()),
      Layer.provide(
        Option.match(url, {
          onNone: () => Database.pglite({ dataDir }),
          onSome: (value) => Database.postgres({ url: value }),
        }),
      ),
      Layer.provide(BunCrypto.layer),
    ),
  )

const key = crypto.randomUUID()

beforeAll(async () => {
  const runtime = app()
  await runtime.runPromise(Effect.void)
  await runtime.dispose()
}, 60_000)

test("a retried command replays its receipt instead of counting twice", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const counter = yield* Counter.get("retry")
      const call = counter.Increment(2)

      expect(yield* call).toBe(2)
      expect(yield* call).toBe(2)
      expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 2 }, receipts: 1 })
    }),
  )
  await runtime.dispose()
})

test("a crash before or after commit leaves exactly one increment", async () => {
  const runtime = harness()

  await runtime.runPromise(
    Effect.gen(function* () {
      const test = yield* ActorTest
      const counter = yield* Counter.get("crash")

      yield* test.crashNext("beforeCommit")
      const first = counter.Increment(7)
      expect(yield* first).toBe(7)

      yield* test.crashNext("afterCommit")
      const second = counter.Increment(3)
      expect(yield* second).toBe(10)
      expect(yield* second).toBe(10)

      expect(yield* test.inspect(counter.ref)).toMatchObject({ state: { count: 10 }, receipts: 2 })
    }),
  )
  await runtime.dispose()
})

test("the count survives a restart", async () => {
  const increment = Effect.gen(function* () {
    const counter = yield* Counter.get(key)

    return yield* counter.Increment(1)
  })

  for (const expected of [1, 2]) {
    const runtime = app()
    expect(await runtime.runPromise(increment)).toBe(expected)
    await runtime.dispose()
  }
})
