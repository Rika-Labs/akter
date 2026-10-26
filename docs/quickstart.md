---
title: "Quickstart"
description: "Build a counter actor, serve it on your machine, call it from an Effect client, and test it."
---

# Quickstart

In this tutorial you build a counter actor, serve it locally, call it with the Effect client, and test it with a seeded simulation. You need Bun 1.4.2 or later, or Node 24 or later.

## Create a project

```sh
mkdir akter-counter && cd akter-counter
bun init -y
bun add @rikalabs/akter effect @effect/platform-bun
bun add -d @rikalabs/akter-cli
```

<Note>
`@rikalabs/akter` and `@rikalabs/akter-cli` release together at the same version. Keep them matched and commit your lockfile. On Node, install `@effect/platform-node` instead of `@effect/platform-bun`.
</Note>

## Declare the actor

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

A new actor starts from the decoded value of `{}`, so every field that is not a list needs a decoding default or `Schema.optional`. An action is a plain synchronous function: it edits a draft of the state and returns the reply. It does not return an Effect or perform I/O.

## Serve it

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
  hostname: "127.0.0.1",
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

Start it and check that it is ready:

```sh
bun run src/server.ts
curl http://127.0.0.1:8080/ready
```

`/ready` answers `200` with `{"ready":true}`. The server listens on port 8080 and serves one RPC endpoint at `/rpc`. Press Ctrl+C to stop it: the runner finishes in-flight work and prints a `DRAINED` report before it exits.

<Warning>
This tutorial authenticates every request as the same user, and `Akter.serve` listens on all interfaces unless you set `hostname`. Use a real credential check before you expose a server. See [Server API](api/01-server-api.md#serve).
</Warning>

`Store.fileSystem` keeps the data in `./.data`. It is for local development and tests, on one host.

## Call it

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

With the server running, `bun run src/call.ts` prints `2` and then `5`.

`Counter.client("main")` returns a scoped handle for the actor with id `main`. Its actions are Effects. The client keeps the same command id for a call across retries, so if a reply is lost, the retry returns the stored result instead of adding twice. Use a `ws://` or `wss://` URL to open a WebSocket session instead of HTTP requests.

## Test it

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

Run it with `bun test` or `node --test src/counter.test.ts`. `Simulation` runs the real engine over an in-memory bucket with a seeded scheduler, so the test is repeatable. To test failures, see [Testing](guides/testing.md).

## Next steps

- Learn how actions and jobs divide work in [Actions and jobs](guides/actions-and-jobs.md).
- Store unbounded data with [lists](api/lists-and-find.md).
- Move to a real bucket with [Deploy](guides/deploy.md), or run on [Akter Cloud](cloud/get-started.md).
