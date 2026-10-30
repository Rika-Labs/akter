# Actors

An actor is one thing your app keeps state for: a chat room, an order, a shopping cart. Each actor has a type (`Room`), an id (`"lobby"`) and its own state. Akter keeps every actor's state in your bucket and runs its commands one at a time.

## Declare an actor

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Room = Actor.make("Room", {
  state: Schema.Struct({
    title: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("Untitled"))),
    closed: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    topic: Schema.optional(Schema.String),
  }),
  commands: {
    rename: Actor.command(Schema.String),
    close: Actor.command(),
  },
})
```

`Actor.make` takes a name and a definition. Only `state` and `commands` are required:

| Option       | What it declares                                             |
| ------------ | ------------------------------------------------------------ |
| `state`      | The actor's data, as an Effect `Schema.Struct`               |
| `commands`   | The [commands](commands.md) that change it                   |
| `jobs`       | [Jobs](jobs.md) that do I/O                                  |
| `views`      | Values [derived from the state](realtime.md#views)           |
| `broadcasts` | Live [messages to listening clients](realtime.md#broadcasts) |
| `presence`   | Who is [connected right now](realtime.md#presence)           |
| `access`     | [Who may call](access.md) what                               |
| `key`        | The type of the actor's id; a string if you leave it out     |

The declaration holds schemas and no server code. The server and the client both build their wire format from it, so they can't drift apart, and it's safe to import from browser code.

## State

State is a `Schema.Struct`. A new actor's state is the decoded value of `{}`, so every field must be able to decode from nothing. Give it a default with `Schema.withDecodingDefault`, make it optional with `Schema.optional`, or make it an [`Actor.list`](lists.md). `Actor.make` throws if a field has none of these.

State without its lists can be at most 256 KiB. A command that would grow it past that fails. Put data that grows without limit, such as messages or line items, in a [list](lists.md), which is stored separately and has no size limit.

## Ids

Callers reach an actor by its type and id, as in `Room.client("lobby")`. Ids are strings unless you declare a `key` schema:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Table = Actor.make("Table", {
  key: Schema.Number,
  state: Schema.Struct({
    seats: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  }),
  commands: { resize: Actor.command(Schema.Number) },
})
```

There's no create or delete step. An actor exists as soon as something calls it, and starts with its default state.

## Implement it

`toLayer` takes one handler per command, view and job, plus `connect` and `disconnect` if the actor declares presence. TypeScript checks that every member has a handler of the right type.

```ts
export const RoomLive = Room.toLayer({
  rename: (room, title) => {
    room.title = title
  },
  close: (room) => {
    room.closed = true
  },
})
```

The result is an Effect `Layer`. When a job handler needs a service, such as a mailer, that service appears in the layer's requirements and you provide it like any other Effect service.

## Serve it

An app lists the actors a server runs and the layers that implement them:

```ts
import { Layer } from "effect"
import { App } from "@rikalabs/akter/server"
import { Room, RoomLive } from "./room.ts"
import { Table, TableLive } from "./table.ts"

export default App.make({
  actors: [Room, Table],
  layer: Layer.mergeAll(RoomLive, TableLive),
})
```

If an actor in `actors` has no implementation in `layer`, `App.make` doesn't compile, and the error names the missing actor. Run the app locally with [`akter dev`](../reference/cli.md#akter-dev), or serve it yourself with [`Akter.serve`](../reference/server.md).

## One command at a time

Commands to one actor run one after another, never at the same time, so a handler always sees the result of the command before it. Commands to different actors run in parallel.

That makes the actor your unit of consistency. If two pieces of data must change together, like a room and its member list, keep them in one actor. If they change independently, like two different rooms, keep them apart so they don't wait on each other.

## Names

Name an actor type after the thing it models, in PascalCase: `Room`, `Order`. Dots group a domain: `Billing.Invoice`. The type name is part of every actor's address in the store, so if you rename a type, its existing actors aren't found under the new name. Choose names you can keep.
