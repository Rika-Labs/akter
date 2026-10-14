---
title: "TypeScript SDK"
description: "The Effect client over the single /rpc endpoint, derived from actor contracts."
---

# TypeScript SDK

The only client is the Effect client exported by `@rikalabs/akter/client`. It is not a Promise, React, Python, OpenAPI, SSE, or MCP facade.

```ts
import { Effect, Stream } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Room } from "./room.ts"

const program = Effect.gen(function* () {
  const room = yield* Room.client("room-1")
  yield* room.rename("new title")
  return yield* Stream.runCollect(room.state.pipe(Stream.take(1)))
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

`X.client(id)` is scoped. Action calls are Effects with typed success and declared failures. `state` and views are Streams that begin with a full frame and then JSON patches. Lists provide range reads and watches. Events are live Streams and are not stored. `join(presence)` opens a presence session and runs `connect` and `disconnect`.

Use an `https:` URL for HTTP NDJSON requests or `wss:` for JSON WebSocket sessions. The client retries retryable transport failures with the same command id for ten minutes, and resubscribes streams with a fresh full frame.

`X.find({ where, orderBy, limit })` is static and returns ids only. It is tenant-scoped and reflects each shard's durable prefix at the time that shard answers; it is not a cross-shard snapshot.
