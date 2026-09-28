# Effect all the way into the commit

**Responsibility:** show how a command handler is an ordinary Effect that runs inside the turn's transaction, and how Effect's types keep each capability in the phase where it is safe.  
**Authority:** operational.  
**Owner role:** API / SDK.  
**Change policy:** change with the [context capabilities](../api/02-context.md) and [command turns](../contracts/02-command-turns.md) when a phase, capability, or rollback rule changes.

A Durable Actors command handler is an Effect, and that Effect runs inside the database transaction that commits the turn. The same values that describe the handler's work (its typed errors, its required services, its composition) decide what commits, and there is no separate save step.

This guide follows one command through that path, using the chat room from the quickstart's `chat` template.

## The handler is the transaction

```ts
export const Post = Actor.command("Post", {
  input: Schema.Struct({ body: Schema.String }),
  output: Schema.String,
  errors: [RoomClosed],
})

export const RoomCommands = Room.toLayer(
  Effect.succeed({
    Post: Effect.fnUntraced(function* ({ body }) {
      const turn = yield* Room.Turn
      const id = turn.commandId

      const author = Option.match(turn.principal, {
        onNone: () => "anonymous",
        onSome: ({ subject }) => subject,
      })

      const seq = turn.state.posted + 1

      yield* turn.state.set({
        closed: turn.state.closed,
        reactions: turn.state.reactions,
        posted: seq,
      })
      yield* turn
        .rows(messages)
        .insert({ id, seq, author, body, sentAt: DateTime.toDate(yield* DateTime.now) })
      yield* turn.emit(MessagePosted.make({ id, author, body }))

      // A declared failure rolls back the state, row, and event written above.
      if (turn.state.closed) return yield* RoomClosed.make({})

      return id
    }),
  }),
)
```

When `Post` arrives, the runtime opens one transaction, checks the generation fence, records the receipt for the command id, decodes the room's state, and then runs this Effect with `Room.Turn` provided. `turn.state.set`, `turn.rows(messages).insert`, and `turn.emit` write through that transaction. When the Effect succeeds, the runtime writes the receipt's result and commits once. Nothing is visible to other readers until then.

There is no save step to remember and no window where state is written but the event is not. A crash anywhere before `COMMIT` leaves nothing; a crash after it leaves everything, and the caller's retry finds the receipt. See [command turns](../contracts/02-command-turns.md) and [transactions](../contracts/03-transactions.md).

## Typed errors decide what commits

`Post` declares `errors: [RoomClosed]`, and the handler's error channel must be that union: a handler that can fail with anything else does not type-check. When the Effect fails with `RoomClosed`:

- the state change, the inserted row, and the event are rolled back;
- the receipt commits with the encoded `RoomClosed`, in the same transaction as the fence;
- the caller gets `RoomClosed` as a typed failure, and a retry with the same command id gets it again without running the handler.

Catching an error is ordinary Effect code. If the handler recovers with `Effect.catchTag` and then succeeds, the turn commits normally with whatever it wrote. A rejection that should be stored with the turn's writes belongs in the output schema, not in `errors`.

A defect (a thrown exception, `Effect.die`, a state over `maxStateBytes`, an undeclared value in the error channel at runtime) is different: the turn rolls back, no receipt is written, and the caller sees `Die`. The same command id can run again once the cause is fixed.

## Services say where code may run

Each phase is a service on the actor definition: `X.Turn` in command handlers, `X.Read` in queries, `X.Executor` in effect executors, `X.Workflow` in workflow bodies. A helper that needs the turn says so in its type, so it can only be called from a command handler:

```ts
const requireOpen: Effect.Effect<void, RoomClosed, Room.Turn> = Effect.gen(function* () {
  const turn = yield* Room.Turn
  if (turn.state.closed) return yield* RoomClosed.make({})
})
```

The type system also rules out the calls that would break the transaction:

- **No request/reply inside a turn.** Acquiring a handle with `X.get` inside a command handler makes `X.toLayer` fail to compile with `Request/reply inside a turn: use X.intents(id)`. Waiting on another actor while holding this actor's lock and a database connection is how deadlocks and long transactions start.
- **Intents only inside a turn.** `X.intents(id)` requires `Actor.InTurn`, which command turns provide and nothing else does. The intent is written to the outbox in this commit and delivered after it.
- **No database in executors.** An effect layer whose executors require `SqlClient`, `PgClient`, or `PgliteClient` does not compile. External calls happen after the commit, never inside it.

The runtime still checks what types cannot: a capability captured and used after its turn ends dies with an "escaped its turn" defect, and so does a captured request/reply handle. See [context capabilities](../api/02-context.md).

## Work outside the transaction is staged, not run

A turn stages what should happen after it commits, and the stage is part of the commit. Inside `Post`, with a `SendDigest` effect declared on the room (the template's room declares none):

```ts
const later = yield * Room.intents(turn.id)
yield * later.Close().pipe(Intent.after("1 day"), Intent.key("idle"))
yield * turn.perform(SendDigest.make({ room: turn.id }))
```

The intent and the effect are rows in `actor_outbox`, written in the same transaction as the state and the receipt. If the turn fails, neither exists. If it commits, the relay delivers the intent as a command whose receipt removes duplicates, and an executor runs the effect with retries and reports its result back to the actor as a new turn. See [messaging](../contracts/05-messaging.md) and [background work](../contracts/08-background-work.md).

## What to keep out of a handler

The handler runs while the transaction is open, so everything it does adds to the time the actor is locked:

- **No external I/O.** HTTP calls, emails, and model calls are effects.
- **No concurrency on turn capabilities.** The turn has one connection. `Effect.all` with concurrency, `Effect.race`, or `Effect.timeout` around `turn.rows`, `turn.group`, or `turn.blob` is a defect; compose them sequentially. `state.set` and intents only stage values, so they are not bound to the turn's fiber.
- **One clock per turn.** `DateTime.now` inside a turn is pinned to one value, so every read in the turn sees the same time. Due times for intents use the database clock.
- **Activation-local values are not rolled back.** A `Ref` in the layer's build closure survives a declared failure. Keep durable facts in state, rows, or events.

`policy.commandTimeout` (30 seconds by default) bounds the whole transaction. A turn that runs past it is interrupted, rolled back, and retried by the caller with the same command id.

## Testing the commit

`ActorTest` runs this same path, so you can crash a turn at a named point and check what committed. See [testing](testing.md).
