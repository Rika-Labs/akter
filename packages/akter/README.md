# @rikalabs/akter

Durable actors for TypeScript, built on [Effect](https://effect.website).

Akter is a framework for backends that hold state. You model each thing your app keeps state for, like a chat room, an order or an agent session, as an actor with a typed state, the commands that change it, and the jobs that talk to the outside world. Akter keeps every actor in one S3-compatible bucket, so there's no database to run.

## Install

```sh
bun add @rikalabs/akter effect@~4.0.3 @effect/platform-bun@~4.0.3 @effect/platform-node-shared@~4.0.3
bun add -d @rikalabs/akter-cli
```

Akter runs on Bun 1.4.2 or later and Node 24 or later. On Node, install `@effect/platform-node@~4.0.3` in place of `@effect/platform-bun`. This release needs Effect 4.0.x; the `@effect/platform-node-shared` pin keeps a 4.1 release of it out of your install.

## An actor

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
})

export const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.count += amount
    return counter.count
  },
})
```

A command handler is a synchronous function that changes a draft of the state and returns a reply. Akter stores the change before the reply goes out, and throws the whole change away if the handler fails. I/O goes in jobs, which record each step so a retry never repeats finished work.

## Entry points

| Entry                     | What's in it                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `@rikalabs/akter`         | `Actor`, callers and errors. Safe to import in a browser.             |
| `@rikalabs/akter/server`  | `Akter.serve`, `App`, `Auth`, `Store`, `Telemetry` and operator tools |
| `@rikalabs/akter/client`  | `AkterClient`, the Effect client                                      |
| `@rikalabs/akter/testing` | `Story` and `Simulation`                                              |

## Documentation

- [Getting started](https://github.com/Rika-Labs/akter/blob/main/docs/getting-started.md)
- [Documentation](https://github.com/Rika-Labs/akter/blob/main/docs/README.md)
- [Changelog](https://github.com/Rika-Labs/akter/blob/main/packages/akter/CHANGELOG.md)

## License

Apache-2.0
