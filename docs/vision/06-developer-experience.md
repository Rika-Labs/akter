# 06 — Developer experience

**Responsibility:** define the developer experience and API shape.  
**Authority:** product intent.  
**Owner role:** product direction.  
**Change policy:** a change requires product sign-off and a matching contract update when a promise shifts.

## Vision

Durable Actors should feel like Effect application development, not infrastructure assembly. One contract derives handles, contexts, runtime registration, Promise clients, HTTP routes, WebSocket and SSE surfaces, OpenAPI, and the test harness.

## The API ladder

An actor is one definition and one layer of handlers:

```ts
import { Effect, Schema } from "effect"
import { Actor } from "@durable-actors/core"

export const Reset = Actor.command("Reset")

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

- `@durable-actors/core` for browser-safe declarations: `Actor.make`, members, `Intent`, identity, and `ActorError` (and `Fleet`, once [ADR 0056](../decisions/0056-fleet-views.md) is built);
- `@durable-actors/core/runtime` for `Actors.layer`, `Actors.serve`, `Auth`, topology, database, and migrations;
- `@durable-actors/core/client` for the browser-safe Promise client;
- `@durable-actors/core/testing` for `ActorTest`.

## Defaults that guide correct code

- `CurrentCaller` is ambient and defaults to anonymous; edges, scripts, and tests bind it once. Handle acquisition captures it, with `Actor.as(caller)` around the acquisition as the per-handle override; methods do not re-read it on each call.
- There is one way to do each task: one constructor, one definition shape, one way to call, one context service per phase. A second way exists only when it changes outcomes materially.
- Omitting `key` creates a minted-id actor; an id schema creates a named actor; `Actor.singleton` creates a singleton.
- Handlers take only their input; `yield* X.Turn` (or `X.Read`, ...) supplies the phase's capabilities, so wrong-phase use is a type error.
- Public methods have typed inputs, outputs, declared failures, and narrowed `ActorError` reasons.
- Workflows live beside the actor handlers that own them.
- Activation-local values are ordinary Effect values in the layer's build closure; committed state is read through `X.Read`.

## First five minutes

`bun create @durable-actors` scaffolds a counter or chat app that runs, restarts with its state, and passes its own retry and crash tests on file-backed PGlite with no Docker; `DATABASE_URL` moves the same code to Postgres. The [quickstart](../quickstart.md) is the path, and a CI smoke keeps it runnable. PGlite there is for development, and for one-process production within the limits of [ADR 0035](../decisions/0035-pglite-embedded-production-backend.md).

## Testing

`ActorTest` exercises the real turn, storage, serialization, receipts, and fault boundaries. In-memory PGlite is its fast default; real Postgres must prove locking and multi-connection behavior, and the same conformance suite gates Neki support. The harness includes callers, virtual time, crashes, pauses, stale generations, jobs, workflows, seeded old state, and inspection without inventing a fake handler runtime; the conformance ledger records the evidence for each.

The same contract also derives an MCP endpoint and a generated Python client ([generating clients](../api/05-generated-clients.md)). This does not make the framework AI-specific: MCP is a transport. A durable agent runtime is a separate product, Outlast, built on the published package and compiling to ordinary actors ([ADR 0017](../decisions/0017-m1-record-corrections.md)).

The developer experience must also support brownfield adoption. Existing Postgres tables should be adoptable through explicit ownership mappings and an observe-then-enforce migration path; automatic scoping is only a guarantee after the enforcement gate passes.
