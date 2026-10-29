# @rikalabs/akter

The Effect-native framework for durable actors, realtime state, background jobs and agents.

## Install

```sh
bun add @rikalabs/akter effect
```

Use Bun 1.4.2+ or Node 24+. The runtime needs the matching `@effect/platform-bun` or `@effect/platform-node` package. Stores use an S3-compatible bucket (`Store.s3`) or a directory (`Store.fileSystem`); no SQL driver is required by the framework.

## Declare and implement an actor

```ts
import { Actor } from "@rikalabs/akter"
import { Effect, Schema } from "effect"

export const Counter = Actor.make("Counter", {
  state: Schema.Struct({
    value: Schema.Finite.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    labels: Actor.list(Schema.Struct({ id: Schema.String, value: Schema.String }), {
      key: "id",
      by: "id",
    }),
  }),
  commands: { add: Actor.command(Schema.Finite, { success: Schema.Finite }) },
})

export const CounterLive = Counter.toLayer({
  add: (counter, amount) => {
    counter.value += amount
    return counter.value
  },
})
```

Commands are synchronous and deterministic. They publish no reply, broadcast, send, timer or job until their bucket-log segment is durable. Jobs are the only place for I/O.

## Client and server

```ts
import { Akter, App, Auth, Store } from "@rikalabs/akter/server"

const app = App.make({ actors: [Counter], layer: CounterLive })
const server = Akter.serve({ app, auth: Auth.none })
```

Provide `Store.fileSystem(".akter/store")` for local development or `Store.s3({ bucket, credentials })` for an S3-compatible store. The single Effect client is `Counter.client(id)`. Its commands are Effects, state and views are Streams, lists expose `range` and watch, and static `Counter.find({ where, orderBy, limit })` returns ids only.

The one RPC group is `/rpc`: WebSocket JSON and HTTP NDJSON. The server can opt into `/metrics` with `prometheus: true`; `Telemetry.layer` composes OTLP traces/metrics and Effect DevTools without an OTLP logs exporter.

## Entry points

| Entry                     | Use                                                          |
| ------------------------- | ------------------------------------------------------------ |
| `@rikalabs/akter`         | Browser-safe contracts, callers, errors and actor types      |
| `@rikalabs/akter/server`  | `Akter.serve`, `App`, `Store`, operator grants and telemetry |
| `@rikalabs/akter/client`  | The same Effect client transport                             |
| `@rikalabs/akter/testing` | Seeded simulation and failure evidence                       |

See the [0.2 documentation](https://docs.akter.dev) for contracts, storage layout, operator commands and verification limits.
