---
title: "Server API"
description: "Declare actors, bind handlers, choose a store, and serve an app with Akter.serve."
---

# Server API

This page covers the server side of Akter: declaring an actor, binding its handlers, and serving it. The actor contract is safe to import in a browser. Only the server layer needs a store.

## Declare an actor

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

const Message = Schema.Struct({ id: Schema.String, body: Schema.String, at: Schema.Number })

export const Room = Actor.make("Room", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    messages: Actor.list(Message, { key: "id", by: "at" }),
  }),
  actions: {
    rename: Actor.action(Schema.String),
    post: Actor.action(Schema.String),
    count: Actor.action({ success: Schema.Number }),
  },
  views: { title: Actor.view(Schema.String) },
})
```

`Actor.make` requires `state` and `actions`. `views`, `events`, `jobs`, `presence`, and `access` are optional.

- Every state field that is not a list needs `Schema.withDecodingDefault(...)` or `Schema.optional(...)`. The initial state is the decoded value of `{}`. There is no `initial` or `migrate` member.
- State without lists is limited to 256 KiB. Lists are stored in pages and are not limited this way.
- An action with no payload takes an options object, as in `Actor.action({ success: Schema.Number })`.

## Bind handlers

```ts
export const RoomLive = Room.toLayer({
  rename: (room, title) => {
    room.title = title
  },
  post: (room, body, { id, now }) => {
    room.messages.put({ id: id(), body, at: now() })
  },
  count: (room) => room.messages.range().length,
  title: (room) => room.title,
})
```

An action handler receives `(draft, payload, ctx)` and is synchronous. Returning a declared failure discards the draft and everything staged. The context `ctx` provides `caller`, `self`, `id()`, `now()`, `random()`, `send`, `schedule`, `start`, and `emit`. See [Context capabilities](./02-context.md).

A view handler reads durable state and returns a value synchronously. A job handler returns an Effect and is the only place for I/O. See [Jobs](./jobs.md). If you declare `presence`, you must implement both `connect` and `disconnect`.

## Serve

```ts
import { Layer } from "effect"
import { Akter, App, Auth, Store } from "@rikalabs/akter/server"
import { Room, RoomLive } from "./room.ts"

const app = App.make({ actors: [Room], layer: RoomLive })

const served = Akter.serve({
  app,
  auth: Auth.jwt({
    issuer: "https://login.example.com",
    audience: "my-app",
    jwks: new URL("https://login.example.com/.well-known/jwks.json"),
    tenant: () => "default",
  }),
}).pipe(Layer.provide(Store.s3({ bucket: "my-akter-store", region: "us-east-1" })))
```

Provide exactly one store:

| Store                                                             | Use                            |
| ----------------------------------------------------------------- | ------------------------------ |
| `Store.s3({ bucket, endpoint?, region?, credentials?, prefix? })` | A durable S3-compatible bucket |
| `Store.fileSystem(directory)`                                     | Local development on one host  |
| `Store.memory()`                                                  | Tests only; not durable        |

The framework has no Postgres, PGlite, Drizzle, or migration layer.

### Server options

| Option             | Default    | Meaning                                                  |
| ------------------ | ---------- | -------------------------------------------------------- |
| `app`              | required   | The actors and their handler layer                       |
| `auth`             | required   | How each request is authenticated                        |
| `port`             | `8080`     | `0` picks a free port                                    |
| `hostname`         | `0.0.0.0`  | The address to listen on                                 |
| `basePath`         | none       | A prefix for `/rpc`, `/ready`, and the key refresh route |
| `origins`          | none       | Browser origins allowed besides the server's own         |
| `reauthorizeEvery` | 60 seconds | How often a live session reruns `auth` and `access`      |
| `runner`           | none       | Multi-runner configuration; see below                    |
| `operatorAuth`     | none       | Enables the separate operator endpoint                   |
| `prometheus`       | `false`    | Serves `/metrics`                                        |

### Authentication

Choose a provider with `Auth`: `Auth.jwt` verifies bearer tokens against a JWKS, `Auth.make` runs your own function, and `Auth.none` treats every request as `Anonymous`. `Auth.assertion` verifies signed assertions from a hosted edge.

An actor's default `access` admits `User` and `System` callers only. To serve a public actor, set `access` to admit `Anonymous` explicitly.

<Warning>
`Akter.serve` refuses every tenant except `default`. Return `"default"` as the tenant until tenant-scoped addresses are supported.
</Warning>

## Store retention

A store keeps history for seven days unless you say otherwise. `StoreOptions.retention` sets the value for a new store only. Reopening an existing store with a different value does not change it, and does not fail.

```ts
import { Store, type OperatorGrant } from "@rikalabs/akter/server"

const current = Store.retention
const widen = (grant: OperatorGrant) =>
  Store.setRetention("30 days", { grant, reason: "paid plan" })
```

`Store.retention` reads the effective retention in milliseconds. `Store.setRetention(duration, { grant, reason })` changes it. The duration must be from 1 to 365 days. The `OperatorGrant` must hold `retention.set` for tenant `*`, with no actor or command restriction. No application caller converts into that grant.

The call returns `{ retentionMillis, revision, audit }`. It fails with:

- `RetentionRefused`, with `reason: "scope"` or `"range"`.
- `RetentionConflict`, when another writer changed the record first.
- `StorageUnavailable` or `CorruptSegment`, when the record is unavailable or corrupt.

The new value and its audit record become durable together. GC reads the value once per pass, so a running pass finishes with the old value. Widening keeps history that has not yet been trimmed, but it cannot restore history that is gone. See [History retention and GC](../operations/retention.md).

## Several runners and graceful shutdown (0.2)

Omit `runner` to run one process. For several runners, set `runner: { address, listenAddress?, peering: { deployment, credentials } }`. Peer addresses must be directly reachable. The credentials supply a CA, a certificate, and a redacted private key. The peering identity is shared across authorized releases of one store, not across stores, and it adds no write authority beyond the bucket credential. See [Self-host with Docker Compose](../operations/self-host.md#several-runners).

Bucket coordination defaults are:

| Option                       | Default          |
| ---------------------------- | ---------------- |
| `shardLockExpiration`        | 3 seconds        |
| `refreshAssignmentsInterval` | 250 milliseconds |
| `shardLockRefreshInterval`   | 2 seconds        |
| `requestTimeout`             | 10 seconds       |

You can override them, but shorter timings tolerate less bucket latency and fewer event-loop pauses, and a longer expiration lengthens crash failover. Liveness uses heartbeat changes and local monotonic time, not synchronized clocks. A lock never authorizes a log write.

Keep the server and store scope alive while `RuntimeControl.waitForSignal({ deadline: "15 seconds" })` waits for SIGTERM or SIGINT. It makes the runner unready, drains, and prints `DRAINED` with the final durable offsets and `nextDue`. Your host must persist that report and arrange the next wake-up; the engine cannot wake a stopped process.

### Runner usage

`Telemetry.usage` reads cumulative per-runner counters from inside the live runtime. It needs `RuntimeControl`, which `Akter.serve` provides. Read it before the scope closes, including after a drain.

```ts
import { Effect } from "effect"
import { Telemetry } from "@rikalabs/akter/server"

const actions = Effect.gen(function* () {
  const snapshot = yield* Telemetry.usage
  return snapshot.actions
})
```

A `UsageSnapshot` is `{ actions, jobSeconds, actors: [{ actorType, actions, jobSeconds }] }`. Every declared actor type appears, even with zero totals. Counts only go up, start when that runner opens, survive shard recovery and release, and never include another runner's work.

- Only successful, durable actions count. Replays, duplicate answers, page-miss reruns, failures, and defects do not.
- Job seconds round each durably admitted attempt up independently, including failures, timeouts, and interruptions. Active attempts count when they settle. Retry backoff and queue time do not count.

The `DrainReport` carries the same totals as optional `actions` and `jobSeconds`. Older reports without them decode, and missing counters mean unknown, not zero. Hosts compute deltas by their own runner-incarnation identity. These are attribution counters to reconcile with your own observations, not billing authority. A hard process death can leave an interval unreported.

## RPC and operator endpoints

The server exposes one RPC group at `/rpc`. WebSocket clients exchange JSON and keep a session. HTTP clients `POST` newline-delimited JSON. Authentication runs before RPC handling.

Operators use a separate `POST /operator` endpoint, enabled by `operatorAuth`. Each inspect, log, snapshot, and replay operation has its own capability and audit record. [Forks](./forks.md) use a different, directly granted interface.

```ts
import { Redacted } from "effect"
import { OperatorAuth } from "@rikalabs/akter/server"

const operatorAuth = OperatorAuth.tokens([
  {
    token: Redacted.make(process.env.OPERATOR_TOKEN!),
    grant: { operator: "ops", capabilities: [{ action: "inspect", tenant: "default" }] },
  },
])
```

`prometheus: true` serves `/metrics`. `Telemetry.layer` exports traces and metrics over OTLP and to DevTools; there is no OTLP logs exporter. See [Observability](../operations/03-observability.md).

## Client and queries

`X.client(id)` is scoped and returns a handle. Actions are Effects, `state` and views are Streams, lists expose `range` and `watch`, events are Streams, and presence exposes `join`. `X.find({ where, orderBy, limit })` is static and returns actor ids only, from top-level scalar state fields. See [TypeScript SDK](./03-typescript-sdk.md) and [Lists and find](./lists-and-find.md).
