---
title: "Lists and find"
description: "Store unbounded collections with Actor.list, and find actor ids by their scalar state."
---

# Lists and find

Use `Actor.list` for data that can grow without bound. Use `X.find` to discover actor ids by their top-level scalar state. Neither is a relational table or a SQL interface.

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

- `key` and `by` name item fields that are strings or numbers. If you omit `key`, it defaults to `by`.
- Items are ordered by `by`. Items with equal `by` values are ordered by key.
- In an action: `put` inserts or replaces by key, `get` reads one item, `delete` removes one, and `deleteBefore(by)` removes items before an order value. `range({ from, to, limit, reverse })` includes `from` and excludes `to`.
- List writes belong to the action's draft and disappear if the action is discarded.
- Lists are stored in content-addressed pages outside the 256 KiB state limit.

If an action reads a page that is not cached, the engine loads it and runs the action again with the same recorded inputs.

Clients read a list with `handle.messages.range(...)` and watch a live window with `handle.messages.watch(...)`. Lists are not part of `handle.state`.

The page-backed lists, retained history, and GC have local test evidence only. Production-provider and 50 GB measurements are not established. See the [evidence](https://github.com/Rika-Labs/akter/blob/main/docs/verification/e6-pages-history.md).

## Find

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

const Ticket = Actor.make("Ticket", {
  state: Schema.Struct({
    queue: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    replies: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  actions: { reply: Actor.action() },
})

const busiest = Ticket.find({
  where: { queue: "support", replies: { gte: 2 } },
  orderBy: { field: "replies", direction: "desc" },
  limit: 50,
})
```

`find` returns an Effect of actor ids, never state.

- **Fields.** Only top-level scalar fields are queryable. Lists, arrays, records, and nested structs are not. You do not declare an index.
- **Conditions.** A bare value means equality. A condition object can use `eq`, `gt`, `gte`, `lt`, `lte`, and `in`. Conditions combine with AND.
- **Limit.** `limit` is from 0 to 1,000, and 1,000 when omitted.
- **Order.** Equal values are ordered by actor id.
- **Strings.** An index keeps the first 64 UTF-8 bytes of a string, so strings that share a 64-byte prefix cannot be told apart.

Each shard answers from its own durable state, and the gateway merges the answers. There is no cross-shard snapshot and no `after` token. A completed action is visible to a later query, but an action running at the same time may appear in one shard's answer and not another's.

`find` checks access with request kind `find`. It does not authorize reading the returned ids. The server serves only the `default` tenant.
