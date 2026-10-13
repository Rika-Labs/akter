---
title: "Lists and find"
description: "Page-backed list fields and id-only queries over durable scalar state."
---

# Lists and find

Use `Actor.list` for data that can grow without bound. Use `X.find` to discover actor ids by their top-level scalar state. Neither is a relational table or a SQL query interface.

## Lists

```ts
import { Schema } from "effect"
import { Actor } from "@rikalabs/akter"

const Message = Schema.Struct({ id: Schema.String, at: Schema.Number, body: Schema.String })

const Room = Actor.make("Room", {
  state: Schema.Struct({ messages: Actor.list(Message, { key: "id", by: "at" }) }),
  actions: { post: Actor.action(Schema.String) },
})

const RoomLive = Room.toLayer({
  post: (room, body, { id, now }) => {
    room.messages.put({ id: id(), at: now(), body })
  },
})
```

The key and order fields must be strings or numbers. When `key` is omitted, it defaults to `by`. `put` inserts or replaces by key, `get` reads one item, `delete` removes it, and `deleteBefore(by)` removes items before an order value. `range({ from, to, limit, reverse })` is inclusive at `from` and exclusive at `to`; equal order values are ordered by key.

List writes are part of the action draft and disappear with a discarded action. Pages are loaded outside the synchronous handler. A missing cached page causes the handler to rerun with the same recorded inputs after loading, not to leak partial changes. Clients use `handle.messages.range(...)` for reads and `handle.messages.watch(...)` for live windows; lists do not appear in `handle.state`.

The page-backed list, cache, history, and GC guarantees belong to E6. A schema or in-memory range test alone does not establish interrupted page-upload, fork, or GC safety. See the [storage contract](../contracts/06-storage.md) for the target and its promotion status.

## Find

```ts
const ids = yield * Room.find({ limit: 100 })
```

`find` returns ids only. A type with scalar state can use `where: { title: "Support", count: { gte: 2 } }` and `orderBy: { field: "count", direction: "desc" }`; equality uses the value directly, and bounds use `eq`, `gt`, `gte`, `lt`, `lte`, or `in`. `limit` accepts 0–1,000. Lists, arrays, records, and nested structs are not query fields. No explicit `index` declaration exists. Equal ordered values are tied stably by actor id.

Owners update their indexes only from durable states, persist them at checkpoints, and recover them with the tail. The gateway queries every shard and merges the results. Each shard answers at its own durable point; there is no cross-shard snapshot or `after` token. A completed action is visible to a subsequent query, but a concurrent action can appear in one shard's answer and not another's.

The 0.2 target truncates indexed strings to a 64-byte UTF-8 prefix, so strings sharing a prefix compare equal in the index. `find` performs tenant-scoped access with request kind `find`; it does not authorize subsequent reads of returned ids. Hosted tenant isolation and production-provider index evidence require their own verification.
