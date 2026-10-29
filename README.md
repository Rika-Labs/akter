# Akter

Akter is a typed framework for durable actors, deterministic commands, journaled Effect jobs, and realtime state. Version 0.2 runs the framework on one S3-compatible store per environment; local development uses a filesystem store.

## The model

An actor owns schema state and optional page-backed lists. Its commands are synchronous copy-on-write functions. A declared failure, defect, or lost segment discards the draft and every staged consequence. A command that touches a list page not in memory is rerun after the page loads; discarding everything the stopped run staged is the contract's target and is not yet covered by a test. The runner publishes a reply, send, timer, job start, or broadcast only after the shard's create-once segment is durable.

External I/O belongs in jobs. Named `step` results never rerun after they are durable; ambiguous provider effects still require provider idempotency keys.

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

The same contract serves the server and the single Effect client: `Counter.client(id)` returns a scoped handle and `Counter.find(...)` is a static id-only query. The server exposes one `/rpc` group with JSON WebSocket and NDJSON HTTP POST transports.

## Install

```sh
bun add @rikalabs/akter effect @effect/platform-bun
bun add -d @rikalabs/akter-cli
# Node: use @effect/platform-node instead of @effect/platform-bun
```

The framework and CLI release together at one version; keep them matched and commit the lockfile before deploying. Supported runtime floors are Bun 1.4.2 and Node 24. The public package entries are `@rikalabs/akter`, `@rikalabs/akter/server`, `@rikalabs/akter/client`, and `@rikalabs/akter/testing`; the client entry is the same Effect client, not a Promise facade.

## Run and deploy

```sh
bunx akter storage check --directory ./.data
bunx akter login
bunx akter deploy --project PROJECT_ID --env production
```

`Store.fileSystem` is the `akter dev` adapter. A durable deployment uses `Store.s3({ bucket })`, one bucket per environment. The bucket contains log, fencing epochs, checkpoints, pages, index, leases, and audits. The framework has no Postgres, PGlite, Drizzle, `Database.postgres`, `Actor.table`, `toJobLayer`, `X.self`, or migration command.

## What this repository contains

- Contracts and implementation for actor state, lists, synchronous commands, jobs, timers, views, broadcasts, presence, and the Effect client; [milestone evidence](docs/operations/support-matrix.md) bounds which guarantees have landed.
- Store protocol adapters for S3-compatible buckets, local filesystem development, and non-durable memory tests.
- Seeded `Simulation`, local MinIO integration evidence, and CLI `storage check`; local evidence does not certify R2, Tigris, AWS S3, or another provider.
- Cloud client commands and the public cloud API contract; hosted edge, control plane, billing, and rollout orchestration live in a private repository.

## Documentation

- [Quickstart](docs/quickstart.md)
- [Concepts](docs/guides/concepts.md)
- [Commands and jobs](docs/guides/actions-and-jobs.md)
- [API reference](docs/api/README.md)
- [Architecture](docs/architecture/README.md)
- [Operations](docs/operations/README.md)
- [Runtime contracts](docs/contracts/README.md)
- [Support matrix](docs/operations/support-matrix.md)

0.2 begins with fresh stores. Historical ADRs and dated verification pages describe the decisions and evidence of their time; they are not promises of current support.

## Akter Cloud

Akter Cloud consumes published `@rikalabs/akter` and `@rikalabs/akter-cli` packages. Its 0.2 design provisions an isolated store bucket per environment incarnation and does not require `DATABASE_URL`; hosted provider, pricing, quota, and deletion evidence remain separate release gates.

## License

[Apache-2.0](LICENSE), copyright Rika Labs.
