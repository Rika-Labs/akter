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
import { Actor } from "@durable-actors/core"

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

There is one package, `@durable-actors/core`, with four entries:

- `@durable-actors/core` for `Actor.make`, members, `Intent`, `Fleet`, identity, `ActorError`, `Actor.serve`, and auth;
- `@durable-actors/core/runtime` for `Actors.layer`, topology, database, and migrations;
- `@durable-actors/core/client` for the browser-safe Promise client;
- `@durable-actors/core/testing` for `ActorTest`.

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

`examples/counter`, `examples/chat`, and `examples/coding-agent` are reserved for the runnable end-to-end corpus but currently contain scaffold entrypoints. Future published examples must be copied from tested implementations. The coding-agent example stays as a showcase: it will demonstrate that an agent is an ordinary actor. It is not a design driver, and nothing enters the framework only because an agent needs it; external tool generators consume `/openapi.json` without adding an AI-specific framework API.

The post-foundation client boundary may additionally derive MCP and non-Effect language clients from the same contract. This does not make the framework AI-specific: MCP is a transport. A durable agent runtime is a separate product, Outlast, built on the published package and compiling to ordinary actors ([ADR 0017](../decisions/0017-m1-record-corrections.md)).

The developer experience must also support brownfield adoption. Existing Postgres tables should be adoptable through explicit ownership mappings and an observe-then-enforce migration path; automatic scoping is only a guarantee after the enforcement gate passes.
