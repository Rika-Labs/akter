---
title: "TypeScript SDK"
description: "Call actors from TypeScript with the Effect client over the single /rpc endpoint."
---

# TypeScript SDK

The only client is the Effect client in `@rikalabs/akter/client`. There is no Promise, React, Python, OpenAPI, SSE, or MCP client.

## Connect and call

```ts
import { Effect, Stream } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Room } from "./room.ts"

const program = Effect.gen(function* () {
  const room = yield* Room.client("room-1")
  yield* room.rename("Support")
  yield* room.post("Hello")
  const latest = yield* room.messages.range({ limit: 10, reverse: true })
  const first = yield* Stream.runCollect(room.state.pipe(Stream.take(1)))
  const ids = yield* Room.find({ where: { title: "Support" }, limit: 100 })
  return { latest, first, ids }
}).pipe(
  Effect.scoped,
  Effect.provide(
    AkterClient.layer({
      url: "wss://example.test/rpc",
      actors: [Room],
    }),
  ),
)
```

Use an `https:` URL for HTTP NDJSON requests, or `wss:` for a JSON WebSocket session.

## The handle

`X.client(id)` is scoped and returns a handle:

| Member           | Type                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| An action        | A function returning an Effect with the typed success and declared failures                    |
| `state`          | A Stream: a full frame first, then JSON patches                                                |
| A view           | A function returning a Stream, which also starts with a full value                             |
| A list           | `range(options)` for one read and `watch(options)` for a live window; lists are not in `state` |
| An event         | A live Stream; events are not stored                                                           |
| `join(presence)` | Opens a presence session; the server runs your `connect` and `disconnect` handlers             |

Internal actions are not on the handle.

## Retries

The client retries retryable transport failures with the same command id for ten minutes. A retry after a lost reply returns the stored outcome instead of running the action again. Streams resubscribe after a retryable end and begin with a fresh full value.

## Find

`X.find({ where, orderBy, limit })` is static and returns ids only. It is tenant-scoped, and each shard answers from its own durable point, so it is not a cross-shard snapshot. See [Lists and find](./lists-and-find.md).
