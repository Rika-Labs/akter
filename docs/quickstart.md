---
title: "Quickstart"
description: "Go from an empty directory to a running, tested actor app on embedded Postgres."
---

# Quickstart

**Responsibility:** take a developer from an empty directory to a running, tested actor app.  
**Authority:** operational.  
**Owner role:** API / SDK.  
**Change policy:** change with the public API; run every command here against a freshly packed tarball before a release.

You need [Bun](https://bun.sh) 1.4.2 or later. No Docker and no database server: the app stores its data with [PGlite](https://pglite.dev), an embedded Postgres, in `./.data`.

## 1. Install

```sh
mkdir my-app && cd my-app && bun init -y
bun add @rikalabs/akter@alpha effect@4.0.0 @effect/platform-bun@4.0.0 @effect/sql-pg@4.0.0 @effect/sql-pglite@4.0.0 drizzle-orm@1.0.0-rc.5-5935859
```

Effect, the Effect SQL drivers and Drizzle are peer dependencies pinned to the exact versions the framework is tested against.

## 2. Declare an actor

`src/counter/contract.ts` is the actor's public shape. Clients import only this file.

```ts title="src/counter/contract.ts"
import { Actor } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

export const Increment = Actor.command("Increment", { payload: Schema.Int, success: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: Schema.NonEmptyString,
  state: Actor.state({ count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Increment },
})
```

`src/counter/layer.ts` implements it. The handler runs inside the turn's transaction.

```ts title="src/counter/layer.ts"
import { Effect } from "effect"
import { Counter } from "./contract.ts"

export const CounterLive = Counter.toLayer({
  Increment: Effect.fn(function* (amount) {
    const turn = yield* Counter.Turn
    yield* turn.state.set({ count: turn.state.count + amount })

    return turn.state.count
  }),
})
```

## 3. Run it

```ts title="src/main.ts"
import { BunCrypto, BunRuntime } from "@effect/platform-bun"
import { Actors, Database } from "@rikalabs/akter/runtime"
import { Console, Effect, Layer } from "effect"
import { Counter } from "./counter/contract.ts"
import { CounterLive } from "./counter/layer.ts"

const live = CounterLive.pipe(
  Layer.provideMerge(Actors.layer()),
  Layer.provide(Database.pglite({ dataDir: "./.data" })),
  Layer.provide(BunCrypto.layer),
)

const program = Effect.gen(function* () {
  const counter = yield* Counter.get("visits")

  yield* Console.log(`visits: ${yield* counter.Increment(1)}`)
})

Layer.effectDiscard(program).pipe(
  Layer.provide(live),
  Layer.build,
  Effect.scoped,
  BunRuntime.runMain,
)
```

```sh
bun src/main.ts   # visits: 1
bun src/main.ts   # visits: 2
```

Each run is a new process. The count survives because the turn that incremented it committed to the database files in `./.data` before the reply. Delete `./.data` to start again.

## 4. Test it

`ActorTest` from `@rikalabs/akter/testing` runs the real turn path against a throwaway database, with fault injection and inspection.

```ts title="src/counter/layer.test.ts"
import { BunCrypto } from "@effect/platform-bun"
import { ActorTest } from "@rikalabs/akter/testing"
import { afterAll, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Counter } from "./contract.ts"
import { CounterLive } from "./layer.ts"

const dataDir = mkdtempSync(join(tmpdir(), "counter-"))

afterAll(() => rmSync(dataDir, { recursive: true, force: true }))

const runtime = ManagedRuntime.make(
  CounterLive.pipe(
    Layer.provideMerge(ActorTest.layer({ database: { dataDir } })),
    Layer.provide(BunCrypto.layer),
  ),
)

test("a retried command replays its receipt instead of counting twice", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const actors = yield* ActorTest
      const counter = yield* Counter.get("retry")
      const call = counter.Increment(2)

      expect(yield* call).toBe(2)
      expect(yield* call).toBe(2)
      expect(yield* actors.inspect(counter.ref)).toMatchObject({ state: { count: 2 }, receipts: 1 })
    }),
  )
}, 60_000)

test("a crash before or after commit leaves exactly one increment", async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const actors = yield* ActorTest
      const counter = yield* Counter.get("crash")

      yield* actors.crashNext("beforeCommit")
      expect(yield* counter.Increment(7)).toBe(7)

      yield* actors.crashNext("afterCommit")
      const second = counter.Increment(3)
      expect(yield* second).toBe(10)
      expect(yield* second).toBe(10)
    }),
  )
}, 60_000)
```

```sh
bun test
```

The first test opens a new PGlite directory, which runs `initdb` inside WebAssembly and applies the framework's migrations, so it takes a few seconds. The injected `afterCommit` crash is logged as an entity defect; that log line is expected.

## 5. Switch to Postgres

Replace `Database.pglite({ dataDir: "./.data" })` with `Database.postgres({ url })`, where `url` is a `Redacted` connection string such as `Redacted.make(process.env.DATABASE_URL!)`. In tests, pass `{ url }` as `ActorTest.layer({ database })`. Startup creates the framework tables. Use a database for this app alone.

## What PGlite is for

PGlite has one connection and belongs to the one process that opened its data directory, so:

- run one process against a data directory; a second process opening it at the same time is refused;
- nothing on PGlite proves lock contention, independent connections, multi-runner relay, or process-kill recovery, which the framework verifies on Postgres only;
- file-backed PGlite is a production backend for one process per data directory, within the limits of [ADR 0035](decisions/0035-pglite-embedded-production-backend.md): the data directory is locked to one process, a process crash recovers to the last commit (power loss is not claimed), backups are stopped copies, and there are no replicas or multiple runners. Move to Postgres when those limits bind; see the [support matrix](operations/support-matrix.md).

On Postgres the alpha is single-runner: run one runtime process per database.
