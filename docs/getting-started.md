# Getting started

In this tutorial you'll build a counter, run it on your machine, call it from a script, watch it change live, and test it. It takes about ten minutes.

You need [Bun](https://bun.sh) 1.4.2 or later. Node 24 or later works too; the differences are noted along the way.

## Create a project

```sh
mkdir counter && cd counter
bun init -y
bun add @rikalabs/akter effect@~4.0.3 @effect/platform-bun@~4.0.3 @effect/platform-node-shared@~4.0.3
bun add -d @rikalabs/akter-cli
```

`@rikalabs/akter` is the framework and `@rikalabs/akter-cli` is the `akter` command. They're released together, so keep their versions the same. Akter 0.3 needs Effect 4.0.x, so the Effect packages are pinned to it. On Node, use `npm install` and add `@effect/platform-node@~4.0.3` instead of `@effect/platform-bun`.

## Write an actor

An actor is one thing your app keeps state for. Create `src/counter.ts`:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: {
    add: Actor.command(Schema.Number, { success: Schema.Number }),
  },
  access: () => true,
})

export const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    return counter.count
  },
})
```

The file has two halves.

`Actor.make` is the contract. It says what a counter's state looks like and which commands a caller can send. It holds schemas and nothing else, so clients import it too.

`Counter.toLayer` is the implementation. The `add` handler gets a draft of one counter's state and the number that was sent. It changes the draft and returns the reply. When it returns, Akter saves the new state, and only then sends the reply.

Two details are worth knowing now. A new counter starts as the decoded value of `{}`, so `count` needs a default. And `access: () => true` lets anyone call a counter. That's fine on your laptop; [Access](core/access.md) shows how to require a signed-in user.

## Run it

Create `src/app.ts`, which lists the actors your app serves along with their implementations:

```ts
import { App } from "@rikalabs/akter/server"
import { Counter, CounterLive } from "./counter.ts"

export default App.make({ actors: [Counter], layer: CounterLive })
```

Start the development server:

```sh
bunx akter dev
```

```text
Akter dev on http://127.0.0.1:8080; filesystem store .akter/store; operator access disabled.
```

`akter dev` serves `src/app.ts` on port 8080 and keeps its data in `.akter/store`. It doesn't ask who's calling, so every request arrives as an anonymous caller. That's why the counter needed `access`.

## Call it

Leave the server running and create `src/call.ts`:

```ts
import { Console, Effect } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.gen(function* () {
  const counter = yield* Counter.client("main")
  yield* Console.log(yield* counter.add(2))
  yield* Console.log(yield* counter.add(3))
})

Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(AkterClient.layer({ url: "http://127.0.0.1:8080/rpc", actors: [Counter] })),
  ),
)
```

Run it in a second terminal:

```sh
bun src/call.ts
```

It prints `2`, then `5`. Run it again and you get `7` and `10`, because the counter called `main` kept its count. Stop the server with Ctrl+C, start it again, and the count is still there.

`Counter.client("main")` is a handle to the counter whose id is `main`. There's no step to create it: an actor exists as soon as something calls it. Each command on the handle is an Effect typed by the contract, so `counter.add("two")` won't compile.

## Watch it change

A handle can also stream an actor's state. Create `src/watch.ts`:

```ts
import { Console, Effect, Stream } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.gen(function* () {
  const counter = yield* Counter.client("main")
  yield* Stream.runForEach(counter.state, (state) => Console.log(`count: ${state.count}`))
})

Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(AkterClient.layer({ url: "ws://127.0.0.1:8080/rpc", actors: [Counter] })),
  ),
)
```

Run `bun src/watch.ts` in one terminal and `bun src/call.ts` in another. The watcher prints the current count, then one line for every `add`.

This client uses a `ws://` URL. It keeps one WebSocket open, which suits streams. An `http://` URL sends each call as its own request. Both reach the same `/rpc` endpoint.

## Test it

`@rikalabs/akter/testing` has two tools. `Story` runs a handler as a plain function, with no server. `Simulation` runs the real engine against an in-memory bucket. Create `src/counter.test.ts`:

```ts
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Simulation, Story } from "@rikalabs/akter/testing"
import { Counter, CounterLive } from "./counter.ts"

test("add returns the new count", () => {
  Story.run(
    Counter,
    CounterLive,
    Story.given({ count: 1 }),
    Story.command("add", 2),
    Story.expectReply(3),
    Story.state((state) => expect(state.count).toBe(3)),
  )
})

test("the count is stored", async () => {
  await Simulation.run(
    { actors: [Counter], seed: 1 },
    Effect.gen(function* () {
      const counter = yield* Counter.client("test")
      yield* counter.add(2)
      yield* counter.add(3)
      yield* Simulation.settle
      const state = yield* Simulation.state(Counter, "test")
      expect(state.count).toBe(5)
    }).pipe(Effect.scoped),
    CounterLive,
  )
})
```

```sh
bun test
```

The story checks one decision on its own. The simulation goes through the client, the engine and the bucket, and `Simulation.state` reads back what was stored. [Testing](guides/testing.md) shows how to make the simulation crash servers and lose writes on purpose.

## Next

- [Commands](core/commands.md): failing safely, time and ids, and messaging other actors.
- [Jobs](core/jobs.md): sending email, calling APIs, anything with I/O.
- [Deploying](deploy/overview.md): moving from `.akter/store` to a bucket, and running on Cloudflare, AWS, Fly.io, Railway and more.
