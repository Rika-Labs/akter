# 06 — Developer experience

**Responsibility:** define the developer experience and API shape.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable Actors should feel like Effect application development, not infrastructure assembly. One contract derives handles, contexts, runtime registration, Promise clients, HTTP routes, WebSocket and SSE surfaces, OpenAPI, and the test harness.

## The API ladder

The following is accepted design notation, not a runnable example of the current scaffolded package:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "durable-actors"

export const Reset = Actor.command("Reset", { description: "Reset the counter." })

export const Counter = Actor.make("Counter", {
  state: Actor.state({ value: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))) }),
  api: { Reset },
  policy: { hibernateAfter: "1 minute" },
})

export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Reset: Effect.fn(function* () {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ value: 0 })
    }),
  }),
)
```

There is one package, `durable-actors`, with four entries:

- `durable-actors` for `Actor.make`, members, `Intent`, `Fleet`, identity, `ActorError`, `Actor.serve`, and auth;
- `durable-actors/runtime` for `Actors.layer`, topology, database, and migrations;
- `durable-actors/client` for the browser-safe Promise client;
- `durable-actors/testing` for `ActorTest`.

## Defaults that guide correct code

- `CurrentCaller` is ambient and defaults to anonymous; edges, scripts, and tests bind it once. Handle acquisition captures it, with `{ as }` as a per-handle override; methods do not re-read it on each call.
- There is one way to do each task: one constructor, one definition shape, one way to call, one context service per phase. A second way exists only when it changes outcomes materially.
- Omitting `key` creates a minted-id actor; an id schema creates a named actor; `Actor.singleton` creates a singleton.
- Handlers take only their input; `yield* X.Turn` (or `X.Read`, ...) supplies the phase's capabilities, so wrong-phase use is a type error.
- Public methods have typed inputs, outputs, declared failures, and narrowed `ActorError` reasons.
- Workflows live beside the actor handlers that own them.
- Activation-local values are ordinary Effect values in the layer's build closure; committed state is read through `X.Read`.

## Testing

The intended `ActorTest` exercises the real turn, storage, serialization, receipts, and fault boundaries. PGlite is the fast-test target subject to compatibility checks; real Postgres must prove locking and multi-connection behavior, and the same conformance suite gates Neki support. The designed harness includes callers, virtual time, crashes, pauses, stale generations, effects, workflows, seeded old state, and inspection without inventing a fake handler runtime. Those capabilities still require implementation and evidence.

`examples/counter`, `examples/chat`, and `examples/coding-agent` are reserved for the runnable end-to-end corpus but currently contain scaffold entrypoints. Future published examples must be copied from tested implementations. The coding-agent example will demonstrate that an agent is an actor; external tool generators consume `/openapi.json` without adding an AI-specific framework API.
