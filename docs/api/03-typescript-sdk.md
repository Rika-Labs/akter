---
title: "TypeScript SDK"
description: "The Effect client over /rpc, derived from your actor contracts."
---

# TypeScript SDK

**Responsibility:** define the client experience over the served wire.  
**Authority:** API design.  
**Owner role:** SDK.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

On `rewrite/0.2` the only client is the Effect client. There is no Promise facade, React package or generated client ([ADR 0128](../decisions/0128-constrained-actor-api.md)); the 0.1 Promise client this page used to describe was removed with the 0.1 runtime ([0.1 retirement](../verification/0.1-retirement.md)).

## Calling a served app

The handles are the ones an actor contract derives everywhere: `X.client(id)` for one actor and `X.find(query)` for the type. `@rikalabs/akter/client` exports `AkterClient.layer(options)`, which provides the `Client` those handles call through, over the server's one RPC group at `/rpc` ([protocol](../contracts/protocol.md)).

```ts
import { AkterClient } from "@rikalabs/akter/client"
import { Effect, Stream } from "effect"
import { Room } from "./contracts"

const program = Effect.gen(function* () {
  const room = yield* Room.client("lobby")
  yield* room.post("hello")
  yield* room.state.pipe(Stream.take(3), Stream.runForEach(Effect.log))
}).pipe(
  Effect.scoped,
  Effect.provide(
    AkterClient.layer({
      url: "wss://example.com/rpc",
      actors: [Room],
      authorization: Effect.sync(() => `Bearer ${currentToken()}`),
    }),
  ),
)
```

`ClientOptions`:

- `url`: the server's `/rpc` URL. `ws:` and `wss:` hold one WebSocket session carrying JSON frames; `http:` and `https:` send each call as its own `POST` with NDJSON.
- `actors`: the contracts the client calls; their members form the group it speaks.
- `headers`: sent on every HTTP request and each WebSocket upgrade. Browsers cannot set upgrade headers, so a browser's WebSocket session authenticates with cookies.
- `authorization`: an effect read for every HTTP request and each upgrade, and sent as `$reauthenticate` every `reauthenticateEvery` (default 30 seconds) to keep a WebSocket session within the server's reauthorization bound. A fresh credential for the same caller keeps the session; one for another caller ends it.

The `@rikalabs/akter/client` entry imports no server, store, engine or platform module; [`pack.test.ts`](../../.github/src/pack.test.ts) checks its bundle for Bun and Node.

## Retries and streams

- **Actions.** Each call mints a command id from the client's clock and retries with that same id after a lost connection or a retryable error, until the id expires: it waits the error's own `retryAfter` (100 ms after a lost connection), doubling up to the greater of 500 ms and that first wait, each wait jittered by ±50%. The server runs the action at most once and answers a retry with the stored outcome. A declared failure arrives as its own class; framework failures are `ActorError` with `reason`, `isRetryable` and `retryAfter` ([error model](../contracts/error-model.md)). A response that never arrived as an envelope is `TransportError`: `network` (retry-safe) or `decode` (not).
- **State, lists and views.** `handle.state`, a list's `watch` and every view are streams that start with the full value and then apply patches. After a lost connection or a retryable end the client resubscribes; the server starts again with a full value, resetting its patch baseline even when the new owner's version is lower. The client suppresses values equal by the decoded state schema's equivalence, including equal resubscription baselines.
- **Events.** An event stream delivers events emitted after it subscribed; a resubscription does not replay missed ones.
- **Presence.** `handle.join(params)` is scoped: acquiring it runs `connect` as the session's caller, and releasing it, or losing the connection, runs `disconnect`.
- **Sessions.** A WebSocket session that is revoked ends its streams and refuses its calls with `Unauthorized` `access_denied`. One that lapses at its reauthorization bound (`reauthorization_unavailable`) is replaced: the client closes the socket and reconnects with fresh headers, and its retried calls and resubscriptions continue on the new session.
- **Refusals before the handler.** A `401`, `403`, `429` or `503` from the server's gate reaches an HTTP call as the envelope's `ActorError`, never as a transport failure.

A client is never trusted: the server's `auth` turns each request or session into a `User` or `Anonymous` caller, and the actor's `access` decides what it may do ([security](../contracts/10-security.md)).
