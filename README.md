# Akter

Durable actors for TypeScript, built on [Effect](https://effect.website).

[![npm](https://img.shields.io/npm/v/@rikalabs/akter)](https://www.npmjs.com/package/@rikalabs/akter)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[Getting started](docs/getting-started.md) · [Documentation](docs/README.md) · [Why Akter](docs/why-akter.md) · [Changelog](packages/akter/CHANGELOG.md)

---

Akter is a framework for backends that hold state: chat rooms, orders, shared documents, game lobbies, AI agent sessions. You model each one as an **actor**, with a typed state, the commands that change it, and the jobs that talk to the outside world. Akter keeps every actor in a single S3-compatible bucket, so there's no database to run.

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

Every counter has an id. A client gets a typed handle to one, calls its commands, and can watch its state change:

```ts
import { Console, Effect, Stream } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.gen(function* () {
  const visits = yield* Counter.client("visits")
  yield* visits.add(1)
  yield* Stream.runForEach(visits.state, (state) => Console.log(state.count))
})

Effect.runFork(
  program.pipe(
    Effect.scoped,
    Effect.provide(AkterClient.layer({ url: "ws://localhost:8080/rpc", actors: [Counter] })),
  ),
)
```

[Getting started](docs/getting-started.md) puts the two together with a server and a test, in about ten minutes.

## How it works

**Commands are plain functions.** A command handler gets a draft of the actor's state, changes it, and returns a reply. It's synchronous: no `await`, no network. Akter writes the change to the bucket before the reply goes out, so a change the caller has seen survives a crash. If the handler fails, the whole change is thrown away, along with any messages, timers or jobs it asked for.

**I/O goes in jobs.** A command can start a job, an Effect that sends the email or calls the API. Each named step in a job is recorded when it finishes, so when the job retries after an error or a crash, the finished steps don't run again.

**Clients are typed end to end.** The actor's declaration is shared by the server and the client. Commands are Effects with typed replies and errors, and state is a Stream. A call that times out is retried with the same command id, and Akter answers a repeated id with the stored reply instead of running the command again.

**One bucket per environment.** The command log, actor state, timers, pending jobs and indexes all live in one S3-compatible bucket. Several Bun or Node processes can share one bucket; they divide the actors between them and hand them over when one stops. For local development, a directory works the same way.

## What's included

- [Commands](docs/core/commands.md) that run one at a time per actor, can message other actors, set timers, or run on a cron schedule.
- [Jobs](docs/core/jobs.md) with recorded steps, retries, timeouts and sleeps that survive a restart.
- [Lists](docs/core/lists.md) for data that grows without limit, like a room's messages.
- [Realtime](docs/core/realtime.md) state, views, broadcasts and presence over WebSocket.
- [Access](docs/core/access.md) control with JWT or your own authentication.
- [Testing](docs/guides/testing.md) with `Story` for single handlers and `Simulation`, which runs the real engine through seeded crashes and lost writes.
- [Operator tools](docs/guides/operating.md) to inspect actors, read the log, replay a shard or fork an actor's history.

## Install

```sh
bun add @rikalabs/akter effect@~4.0.3 @effect/platform-bun@~4.0.3 @effect/platform-node-shared@~4.0.3
bun add -d @rikalabs/akter-cli
```

Akter runs on Bun 1.4.2 or later and Node 24 or later. On Node, install `@effect/platform-node@~4.0.3` in place of `@effect/platform-bun`. Akter 0.3 needs Effect 4.0.x, which is why the versions are pinned; without the `@effect/platform-node-shared` pin, the platform package pulls in a 4.1 release that doesn't load with Effect 4.0.

## Documentation

- [Getting started](docs/getting-started.md): build, run, call and test a counter.
- [Why Akter](docs/why-akter.md): the problem it solves and what it costs.
- [Core concepts](docs/README.md#core-concepts): actors, commands, jobs, lists, realtime and access.
- [Guides](docs/README.md#guides): calling actors, testing, operating and changing state.
- [Deploying](docs/deploy/overview.md): Cloudflare, AWS, Google Cloud, Azure, Fly.io, Railway, Render, DigitalOcean, Kubernetes or your own server.
- [Reference](docs/README.md#reference): the CLI, the server, errors, and guarantees and limits.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repository, and [docs/internals](docs/internals/README.md) for how Akter is built and tested. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE), © Rika Labs.

## Breaking changes

Akter isn't 1.0 yet, and minor versions can break your code. Read the [changelog](packages/akter/CHANGELOG.md) before you upgrade.

- **0.3** renamed actions to commands and events to broadcasts (`Actor.action` → `Actor.command`, `Actor.event` → `Actor.broadcast`, `ctx.emit` → `ctx.broadcast`), and moved job `retry` and `timeout` to `Job.retry` and `Job.timeout`. It requires Effect 4.0.x. Stores written by 0.2 open unchanged.
- **0.2** replaced the Postgres engine with object storage. Data from 0.1 can't be opened by 0.2 or later.
