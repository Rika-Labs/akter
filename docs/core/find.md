# Finding actors

You usually reach an actor by an id you already know. When you don't, `find` looks up the ids of actors of one type by the values in their state.

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@rikalabs/akter"

export const Ticket = Actor.make("Ticket", {
  state: Schema.Struct({
    queue: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("general"))),
    open: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
    replies: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  }),
  commands: { reply: Actor.command(Schema.String) },
})

export const busiest = Ticket.find({
  where: { queue: "billing", open: true, replies: { gte: 3 } },
  orderBy: { field: "replies", direction: "desc" },
  limit: 20,
})
```

`find` returns an Effect of ids. To read the actors, call `Ticket.client(id)` for each one.

## What you can query

Every top-level field whose value is a single string, number, boolean or literal is indexed automatically. You don't declare indexes. Lists, arrays, records and nested structs aren't indexed.

- `where` matches fields. A plain value means equals. An object can use `eq`, `gt`, `gte`, `lt`, `lte` and `in`. All conditions must hold.
- `orderBy` sorts by one field. Ties are ordered by actor id.
- `limit` is at most 1,000, and 1,000 if you leave it out.

Strings are indexed by their first 64 bytes, so two strings that share those bytes compare as equal.

## What it isn't

`find` is a lookup, not a query language. There are no joins, no counts, no text search and no paging cursor. Each part of the store answers from its own stored state, so the result isn't a single snapshot taken at one instant. A command that finished before you called `find` is always reflected; one that's running at the same time may or may not be.

If you need more than this, keep a separate actor that maintains the list you need, or copy the data to a database from a job.

Commands can't call `find`. Access checks it with request kind `find`.
