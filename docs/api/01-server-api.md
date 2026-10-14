---
title: "Server API"
description: "Actor declarations, handlers, stores, and serving in Akter 0.2."
---

# Server API

Akter 0.2 separates a browser-safe actor contract from the server layer that binds its handlers. The contract requires only `state` and `actions`; views, events, jobs, lists, and presence are added only when used.

## Declare an actor

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Room = Actor.make("Room", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    messages: Actor.list(
      Schema.Struct({
        id: Schema.String,
        body: Schema.String,
        at: Schema.Number,
      }),
      { key: "id", by: "at" },
    ),
  }),
  actions: {
    rename: Actor.action(Schema.String),
    count: Actor.action({ success: Schema.Number }),
  },
})
```

Every non-list state field needs `Schema.withDecodingDefault(...)` or `Schema.optional(...)`. The initial state is the decode of `{}`; there is no `initial` or `migrate` member. State without lists is limited to 256 KiB. Lists are unbounded content-addressed pages.

Actions are synchronous copy-on-write functions: `(draft, payload, ctx) => void | declaredFailure | success`. Returning a declared failure discards state and every staged send, timer, job, or event. `ctx` supplies `caller`, `self`, `id()`, `now()`, `random()`, `send`, `schedule`, `start`, and `emit`. Actions and views do not perform I/O or use `Promise`, `await`, clocks, randomness, or process globals directly.

## Bind handlers

```ts
export const RoomLive = Room.toLayer({
  rename: (room, title) => {
    room.title = title
  },
  count: (room) => room.messages.range().length,
})
```

Views are synchronous reads of durable state. Jobs are the only I/O boundary and return an Effect; use `step(name, effect)` so a completed step never runs again. `onFailure` names an internal action receiving `Actor.JobFailure`. Presence requires both `connect` and `disconnect`.

## Serve

```ts
import { Layer } from "effect"
import { User } from "@rikalabs/akter"
import { Akter, App, Auth, Store } from "@rikalabs/akter/server"

const app = App.make({ actors: [Room], layer: RoomLive })
const served = Akter.serve({
  app,
  auth: Auth.make(() =>
    Effect.succeed({
      caller: User.make({ subject: "local-development" }),
      tenant: "default",
    }),
  ),
}).pipe(Layer.provide(Store.fileSystem("./.data")))
```

Provide exactly one store: `Store.s3({ bucket })` for a durable bucket or `Store.fileSystem(dir)` for local development. `Store.memory()` is non-durable test infrastructure. The framework has no Postgres, PGlite, Drizzle, or migration layer.

### Store retention

`StoreOptions.retention` seeds only a new store (default seven days); reopening with another value does not change policy or defect. Read `Store.retention` for the effective duration in milliseconds. Change it with `Store.setRetention(duration, { grant, reason })` from `@rikalabs/akter/server`, or `store.setRetention` on the provided service. The duration is `Duration.Input`, bounded to one through 365 days inclusive. The separate authenticated `OperatorGrant` must include `{ action: "retention.set", tenant: "*" }` without actor or command restrictions. No application caller converts to it.

The operation returns `{ retentionMillis, revision, audit }`. `RetentionRefused` carries `reason: "scope" | "range"`; concurrent writers receive `RetentionConflict` (the revision they tried to replace). An unavailable or corrupt record returns `StorageUnavailable` or `CorruptSegment`. The effective value and audit become durable together at `meta/retention` through compare-and-swap; the initial `meta/store` value is never overwritten. A previous embedded audit is archived before replacement, and `store.audits` includes the current one.

GC captures one value per collection pass; an already-running pass finishes under that value, and changes apply on the next pass. Segment trim reads once per request. Widening can preserve still-stored history but cannot restore history already trimmed. Fork and history/log admission use the value at request time. `store.history.read(shard, 0n)` lists in-window segments; an explicit expired start fails with `HistoryExpired`. Older checkpoints remain visible only as reconstruction anchors/newest recovery images; their visibility does not authorize an expired fork. `store.read` is the lower-level recovery-chain read, not a public history authorization boundary.

The example's fixed user is for local development only. Production must authenticate a real credential with `Auth.make`, `Auth.jwt`, or the hosted assertion provider. `Auth.none` authenticates `Anonymous`; an actor's default `access` admits only `User` and `System`, so a public actor must explicitly admit anonymous requests. The current server refuses tenants other than `default` until tenant-scoped actor addresses have their own evidence.

### Several runners and graceful shutdown (0.2)

Omit `runner` for one process. A multi-runner `runner` has `address`, optional `listenAddress`, and `peering: { deployment, credentials }`. Peer addresses must be directly reachable; credential material supplies a CA, certificate, and redacted key. The store-scoped identity is shared across authorized releases, not across stores; it adds no write authority beyond the store bucket credential. See the [self-host configuration](../operations/self-host.md#stop) and [E3 security limits](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e3-cluster.md).

Bucket coordination defaults are `shardLockExpiration: "3 seconds"`, `refreshAssignmentsInterval: "250 millis"` and `shardLockRefreshInterval: "2 seconds"`. Effect caps lock refresh at one third of expiration, and the adapter's 1.5-second heartbeat-write floor normally produces one write every two seconds. Liveness uses heartbeat ETags and local monotonic time, not synchronized clocks. Durable release wakes peers immediately over mTLS; periodic refresh covers lost notifications. These options can be overridden, but shorter timings reduce tolerance for bucket latency and event-loop pauses, while longer expiration increases crash failover time. The advisory lock never authorizes a log write.

Keep the server/store scope alive while `RuntimeControl.waitForSignal({ deadline: "15 seconds" })` waits for SIGTERM or SIGINT and drains. It makes the runner unready before release and prints `DRAINED` with final durable offsets and `nextDue`. The host must persist that report and arrange future wake-ups; the engine cannot wake a stopped process.

### Runner usage

`Telemetry.usage` is an `Effect<UsageSnapshot, never, RuntimeControl>` from `@rikalabs/akter/server`. `Akter.serve` provides its runner's context; read it inside that live context, including after drain but before scope close:

```ts
const snapshot = yield * Telemetry.usage
```

`UsageSnapshot` contains `{ actions, jobSeconds, actors: [{ actorType, actions, jobSeconds }] }`. Every declared actor type appears, including zero totals. Each read is detached from later updates and never resets or seals totals. Counts are monotonic since that runner opened, survive its shard recovery and release, and never include another runner's work. Only successful, confirmed durable actions count; replays, duplicate answers, page-miss reruns, failures and defects do not. Job seconds round local elapsed time up independently for each durably admitted attempt or resumed local interval, including success, failure, defect, timeout and interruption. Active attempts enter totals when they settle; retry backoff and admission queues do not count.

The `DrainReport` wire adds optional top-level `actions` and `jobSeconds`, with the same cumulative runner-wide meaning, including work on shards already released or lost. Legacy reports still decode; absent counters mean unknown, not zero. Current producers include totals after settling interrupted attempts on both clean and timed-out drains. Hosts compute interval deltas using their own runner-incarnation identity; the framework neither seals reports nor signs them. These counters are attribution to reconcile with platform observations, not billing authority. Hard process death can leave an unreported interval; replay does not count it again.

## RPC

The served app exposes one RPC group at `/rpc`. WebSocket clients exchange JSON and keep a session; HTTP clients use `POST` with newline-delimited JSON. Authentication runs before RPC handling and each session is rebound or reauthorized according to the server options.

Operator requests use a separate `POST /operator` endpoint and never share the application RPC group. `operatorAuth` accepts `OperatorAuth.tokens([{ token: Redacted.make(token), grant: { operator, capabilities } }])` from the server entry. Each inspect, log, snapshot, and replay operation has its own capability and audit boundary. [Actor forks](./forks.md) use the separately granted server/CLI interface; they are not served by `POST /operator`. `prometheus: true` exposes `/metrics`. `Telemetry.layer` sends OTLP traces/metrics and DevTools data, but there is no OTLP logs exporter.

## Client and queries

`X.client(id)` is scoped and returns a handle whose actions are Effects, state and views are Streams, lists expose `range` and watch operations, events are Streams, and presence exposes `join`. `X.find({ where, orderBy, limit })` is static and returns actor ids only. It filters top-level scalar state fields; lists, records, arrays, and nested structs are not indexed.
