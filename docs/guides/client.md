# Calling actors

Any TypeScript program can call actors with the client in `@rikalabs/akter/client`: a browser app, another backend, a script, a test. The client is an Effect layer, and every call is an Effect or a Stream typed by the actor's declaration.

## Connect

```ts
import { Console, Effect } from "effect"
import { AkterClient } from "@rikalabs/akter/client"
import { Counter } from "./counter.ts"

const program = Effect.gen(function* () {
  const counter = yield* Counter.client("main")
  const count = yield* counter.add(1)
  yield* Console.log(count)
})

Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(
      AkterClient.layer({
        url: "wss://api.example.com/rpc",
        actors: [Counter],
      }),
    ),
  ),
)
```

`AkterClient.layer` takes the server's `/rpc` URL and the actors you'll call. The URL's scheme picks the transport:

- `ws://` or `wss://` opens one WebSocket and sends everything over it. Use it for streams and for anything that makes many calls.
- `http://` or `https://` sends each call as its own `POST`. Use it for one-off calls from a server or a script.

`X.client(id)` needs a `Scope`, because the handle's streams and presence live as long as the scope does. Wrap your program in `Effect.scoped`.

## Send credentials

Pass static headers with `headers`, or a token that changes with `authorization`:

```ts
AkterClient.layer({
  url: "wss://api.example.com/rpc",
  actors: [Counter],
  authorization: Effect.sync(() => `Bearer ${currentToken()}`),
})
```

`authorization` is read for every HTTP request and every new WebSocket, and a WebSocket session sends a fresh one every 30 seconds, so a long-lived session keeps working as tokens rotate. Browsers can't set headers on a WebSocket, so in a browser, authenticate WebSocket sessions with a [cookie](../core/access.md#cookies).

## The handle

`Counter.client(id)` returns a handle with one member per public part of the actor:

| Member           | Type                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| A command        | A function returning an Effect of the reply                          |
| `state`          | A Stream of the state, without lists                                 |
| A view           | A function returning a Stream of the view's value                    |
| A list           | `range(options)`, an Effect of items, and `watch(options)`, a Stream |
| A broadcast      | A Stream of broadcast values                                         |
| `join(presence)` | Joins the actor's presence for the life of the scope                 |

Internal commands aren't on the handle. [Realtime](../core/realtime.md) covers the streams in detail.

## Errors

A command's Effect can fail in two ways.

**The command's declared error.** If `withdraw` declares `fails: InsufficientFunds`, the Effect can fail with `InsufficientFunds`, as that same class. Handle it with `Effect.catchTag("InsufficientFunds", ...)`.

**An `ActorError`.** Everything else (the caller isn't allowed, the payload doesn't match the schema, the server is unreachable) is an `ActorError` with a `reason`. See [Errors](../reference/errors.md) for the list.

A handler that throws reaches the client as a `CommandDefect`, which is a defect in the Effect sense: it isn't in the error channel, because nothing in your code should expect it.

## Retries

The client retries on its own when a failure is safe to retry: a dropped connection, a server shutting down, an actor moving between servers, a full queue. It keeps the command id across retries and gives up after ten minutes. Because Akter answers a repeated id with the stored outcome, a retry never applies a command twice.

When the error says nothing about whether the command ran (a `Timeout`, say), retrying is still the right move. The retry tells you the actual outcome.

Streams retry too. After a dropped connection a stream subscribes again and starts from a fresh full value.

## Find

`Counter.find({ where, orderBy, limit })` looks up actor ids by state. See [Finding actors](../core/find.md).

## Other languages

There's no client for other languages. The `/rpc` protocol is JSON over WebSocket or newline-delimited JSON over HTTP, generated from the actor declarations, and any language can speak it. The [protocol contract](../internals/contracts/protocol.md) describes the wire format.
