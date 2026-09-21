# 06 — Developer experience

**Responsibility:** define the developer experience and API shape.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable Actors should feel like Effect application development, not infrastructure assembly. One contract derives handles, contexts, runtime registration, Promise clients, HTTP routes, WebSocket and SSE surfaces, OpenAPI, and the test harness.

## The API ladder

```ts
const Reset = Actor.command("Reset", {
  description: "Reset the counter.",
})

const Counter = Actor.make("Counter", {
  commands: [Reset],
  state: { value: Schema.Number },
  lifecycle: [Hibernate.after("1 minute")],
})
```

There is one package, `durable-actors`, with four entries:

- `durable-actors` for `Actor.make`, members, policies, identity, `ActorError`, `Actors`, `Actor.serve`, and auth;
- `durable-actors/runtime` for `Actors.layer`, topology, database, and migrations;
- `durable-actors/client` for the browser-safe Promise client;
- `durable-actors/testing` for `ActorTest`.

## Defaults that guide correct code

- `CurrentCaller` is ambient and defaults to anonymous; edges, scripts, and tests bind it once.
- Omitting `id` creates a minted-id actor; declaring an id creates a named actor; `singleton: true` creates a singleton.
- Handler contexts expose only capabilities valid in their phase.
- Public methods have typed inputs, outputs, declared failures, and narrowed `ActorError` reasons.
- Workflows live beside the actor handlers that own them.
- `vars` clearly means activation-local state; `StateSnapshot` clearly means committed state outside a turn.

## Testing

`ActorTest` exercises the real turn, storage, serialization, receipts, and fault boundaries. PGlite gives fast default tests; real Postgres covers locking and multi-connection behavior; the same conformance suite gates Neki support. The harness supports callers, virtual time, crashes, pauses, stale generations, effects, workflows, seeded old state, and inspection without inventing a fake handler runtime.

The examples in `examples/counter`, `examples/chat`, and `examples/coding-agent` are the end-to-end corpus. The coding agent demonstrates the principle that an agent is an actor; external tool generators consume `/openapi.json`.
