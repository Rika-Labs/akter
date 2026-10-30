# Lists

An actor's state is loaded in full whenever the actor runs, and it's capped at 256 KiB. Data that keeps growing, like a room's messages or an order's events, belongs in a list. A list is stored in pages outside the state, Akter loads only the pages a command touches, and there's no size limit.

## Declare a list

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

const Message = Schema.Struct({
  id: Schema.String,
  at: Schema.Number,
  body: Schema.String,
})

export const Room = Actor.make("Room", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    messages: Actor.list(Message, { key: "id", by: "at" }),
  }),
  commands: {
    post: Actor.command(Schema.String, { success: Schema.String }),
    remove: Actor.command(Schema.String),
    prune: Actor.command(Schema.Number, { success: Schema.Number }),
  },
})
```

`Actor.list(Item, { key, by })` names two fields of the item, each a string or a number. `key` identifies an item, and `by` orders the list. Items with the same `by` value are ordered by key. If you leave out `key`, it's the same as `by`.

## Change it

In a command, a list field has methods instead of being an array:

```ts
export const RoomLive = Room.toLayer({
  post: (room, body, { id, now }) => {
    const message = { id: id(), at: now(), body }
    room.messages.put(message)
    return message.id
  },
  remove: (room, messageId) => {
    room.messages.delete(messageId)
  },
  prune: (room, before) => room.messages.deleteBefore(before),
})
```

| Method                                | What it does                                                       |
| ------------------------------------- | ------------------------------------------------------------------ |
| `put(item)`                           | Adds the item, or replaces the one with the same key               |
| `get(key)`                            | Returns one item, or `undefined`                                   |
| `delete(key)`                         | Removes one item and returns whether it was there                  |
| `deleteBefore(by)`                    | Removes every item ordered before `by` and returns how many        |
| `range({ from, to, limit, reverse })` | Returns a window of items in order; `from` is included, `to` isn't |

List changes are part of the command's draft. If the command fails, they're thrown away with everything else.

When a command touches a page that isn't in memory, Akter stops the command, loads the page and runs the command again from the start. You don't see this, except that it's one more reason commands must be [deterministic](commands.md#stay-deterministic).

## Read it from a client

Lists aren't part of `handle.state`. A client reads a window with `range`, or watches one with `watch`:

```ts
const room = yield * Room.client("lobby")
const latest = yield * room.messages.range({ limit: 50, reverse: true })
yield *
  Stream.runForEach(room.messages.watch({ limit: 50, reverse: true }), (messages) =>
    Console.log(`${messages.length} recent messages`),
  )
```

`watch` emits the whole window first, then again each time it changes. See [Realtime](realtime.md).

## Read it in a test

`Simulation.state` and `Story.state` return each list as a plain array in `by` order, so you can assert on it directly. See [Testing](../guides/testing.md).
