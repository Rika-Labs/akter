---
title: "Quickstart"
description: "Create, serve, call, and test a bucket-backed Akter 0.2 actor."
---

# Quickstart

This tutorial creates a counter actor, serves it over `/rpc`, calls it with the Effect client, and runs a seeded test. Local development uses a filesystem store; no Postgres, PGlite, Drizzle, React, Python client, or migration command is involved.

## 1. Create a project

```sh
mkdir akter-counter && cd akter-counter
bun init -y
bun add @rikalabs/akter effect @effect/platform-bun
bun add -d @rikalabs/akter-cli
```

Both packages release together at one version, starting with 0.2.0. Keep them matched and commit the lockfile; do not deploy from moving dist-tags. Node 24+ works too: install `@effect/platform-node` and use `NodeRuntime`/`NodeServices` instead of the Bun imports below.

## 2. Declare the actor

Create `src/counter.ts`:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: {
    add: Actor.action(Schema.Number, { success: Schema.Number }),
  },
})

export const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    return counter.count
  },
})
```

State is decoded from `{}`. Every non-list field needs a decoding default or `Schema.optional`; there is no `initial` or `migrate` member. `add` is synchronous and deterministic. It does not return an Effect or perform I/O.

## 3. Serve locally

Create `src/server.ts`:

```ts
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { User } from "@rikalabs/akter"
import { Akter, App, Auth, RuntimeControl, Store } from "@rikalabs/akter/server"
import { Counter, CounterLive } from "./counter.ts"

const app = App.make({ actors: [Counter], layer: CounterLive })

const server = Akter.serve({
  app,
  auth: Auth.make(() =>
    Effect.succeed({
      caller: User.make({ subject: "quickstart" }),
      tenant: "default",
    }),
  ),
}).pipe(Layer.provide(Store.fileSystem("./.data")))

const main = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(server)
    yield* RuntimeControl.waitForSignal({ deadline: "15 seconds" }).pipe(
      Effect.provideContext(context),
    )
  }),
).pipe(Effect.provide(BunServices.layer))

BunRuntime.runMain(main)
```

Run it with `bun run src/server.ts`, then call `GET /ready`. The server creates `.data` using the same create-once protocol as a durable bucket, but this local adapter is a one-host development store. The fixed user is only for the tutorial.

The server exposes one RPC group at `http://127.0.0.1:8080/rpc`: HTTP POST uses NDJSON. Change the client URL to `ws://.../rpc` for a JSON WebSocket session.

## 4. Call it

Create `src/call.ts`:

```ts
import { Effect } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.gen(function* () {
  const counter = yield* Counter.client("main")
  console.log(yield* counter.add(2))
  console.log(yield* counter.add(3))
}).pipe(
  Effect.scoped,
  Effect.provide(
    AkterClient.layer({
      url: "http://127.0.0.1:8080/rpc",
      actors: [Counter],
    }),
  ),
)

await Effect.runPromise(program)
```

`X.client(id)` returns a scoped handle. Action methods are Effects; `state` is a Stream beginning with a full frame; list ranges and views are reads; events are live and non-persisted. The client retries a lost response with the same command id for ten minutes, so the second delivery returns the stored outcome instead of adding twice.

## 5. Test the durable boundary

Create `src/counter.test.ts`:

```ts
import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import { Simulation } from "@rikalabs/akter/testing"
import { Counter, CounterLive } from "./counter.ts"

test("adds once and exposes durable state", async () => {
  await Simulation.run(
    { actors: [Counter], seed: 7 },
    Effect.gen(function* () {
      const counter = yield* Counter.client("test")
      assert.equal(yield* counter.add(2), 2)
      yield* Simulation.settle
      assert.equal((yield* Simulation.state(Counter, "test")).count, 2)
    }).pipe(Effect.scoped),
    CounterLive,
  )
})
```

Run `bun test` or `node --test src/counter.test.ts`. This smoke rejects an action that fails to persist its result, but does not test retry identity. For failure evidence, add a lost append, a declared failure, a page miss, restart, or same-id retry and assert the final durable state and obligations. The simulator is not provider evidence.

## 6. Check a durable bucket

```sh
bunx akter storage check --directory ./.data --json
bunx akter storage check --bucket my-akter-store --endpoint https://s3.example --region us-east-1
```

Use `AKTER_STORAGE_*` environment variables for credentials. The check writes only under `check/<run>/`, creates no store descriptor, and exits 1 when a required bucket property fails. Passing locally does not certify the hosted provider; save provider-specific output in the support matrix.

## Next

Read [actions and jobs](guides/actions-and-jobs.md), [lists and find](api/lists-and-find.md), [deployment](guides/deploy.md), and [self-host operations](operations/self-host.md). 0.2 starts empty and has no migration path from the 0.1 relational runtime.
