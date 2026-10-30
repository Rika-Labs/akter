# Realtime

Clients don't poll Akter. A handle's state, views and lists are Streams that send the current value, then a new one each time it changes. Broadcasts push short-lived messages, and presence tracks who is connected.

This page uses one actor throughout:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Room = Actor.make("Room", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
    online: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
  }),
  commands: {
    rename: Actor.command(Schema.String),
    announce: Actor.command(Schema.String),
  },
  views: {
    people: Actor.view(Schema.Array(Schema.String)),
  },
  broadcasts: {
    announced: Actor.broadcast(Schema.String),
  },
  presence: Schema.Struct({ name: Schema.String }),
})

export const RoomLive = Room.toLayer({
  rename: (room, title) => {
    room.title = title
  },
  announce: (_room, text, { broadcast }) => {
    broadcast.announced(text)
  },
  people: (room) => Object.values(room.online).sort(),
  connect: (room, { name }, { connection }) => {
    room.online[connection] = name
  },
  disconnect: (room, _presence, { connection }) => {
    delete room.online[connection]
  },
})
```

## Live state

`handle.state` is a Stream of the actor's state, without its lists:

```ts
const room = yield * Room.client("lobby")
yield * Stream.runForEach(room.state, (state) => Console.log(state.title))
```

The first value is the current state. After that, the stream sends a new value whenever a command changes it. Under the hood the server sends only the changes, as JSON patches, and the client applies them.

Every value comes from stored state. A client never sees a change that could still be lost. If a client's own command has completed, every read it makes afterward includes that command's change.

To read once instead of watching, take the first value: `Stream.runHead(room.state)`.

## Views

A view is a value computed from the state. Use one to send a client less than the whole state, or something shaped differently:

```ts
yield * Stream.runForEach(room.people(), (people) => Console.log(people.join(", ")))
```

A view handler is synchronous and gets the stored state, plus parameters if the view declares them with `Actor.view(Schema.String, { params: Schema.Number })`. Like `state`, a view is a Stream that sends a new value only when the result changes.

Views are also how you hide fields. [Access](access.md) can allow a caller to read a view while denying the full state.

## Broadcasts

A broadcast is a message for whoever is listening right now. It isn't stored, so a client that subscribes later never sees it.

```ts
yield * Stream.runForEach(room.announced, (text) => Console.log(`Announcement: ${text}`))
```

A command sends one with `broadcast.announced(text)`. It goes out after the command is stored, and not at all if the command fails.

A [job](jobs.md#progress) can send broadcasts too, which suits progress updates like tokens from a model. A job's broadcast goes out immediately, and a retried job may send it again.

If something must not be missed, put it in state or a [list](lists.md), not only in a broadcast.

## Presence

Presence tracks which clients are connected to an actor. A client joins with a value that describes it:

```ts
const program = Effect.gen(function* () {
  const room = yield* Room.client("lobby")
  yield* room.join({ name: "Ada" })
  yield* Stream.runForEach(room.people(), (people) => Console.log(people.join(", ")))
}).pipe(Effect.scoped)
```

`join` runs the actor's `connect` handler, and closing the scope runs `disconnect`. Both are ordinary commands with an extra `connection` id in their context. Akter guarantees one `disconnect` for every `connect`, even when a server or the client's connection dies: the server that next owns the actor runs `disconnect` for every connection it finds open.

An actor that declares `presence` must implement both handlers.

## Reconnects and slow clients

If a connection drops or the actor moves to another server, the client subscribes again and the stream continues from a fresh full value. A value equal to the last one isn't sent twice.

A client that reads a state, view or list stream too slowly gets the newest value instead of every value in between. Broadcasts can't be merged that way: a client that falls 64 broadcasts behind is cut off, subscribes again, and misses the ones in between.
