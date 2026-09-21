# Server API

**Responsibility:** define actor declarations and server composition.  
**Authority:** API design.  
**Owner role:** API/Effect.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The Effect-native server API is one package, `durable-actors`. Its root entry exports `Actor`, policies, errors, identity, `Actors`, `Actor.serve`, and `Actor.auth`. Runtime construction is imported separately as `Actors.layer` from `durable-actors/runtime`.

## Definitions and identity

`Actor.make(name, members)` is the only actor constructor. Members may include commands, internal commands, queries, streams, connections, workflows, events, effects, tables, blobs, state, activation-local `vars`, migrations, and lifecycle policies.

Actor identity has three modes:

- omitted `id`: minted; use `X.create()`, the branded `X.id` schema, or `Actors.mint(X)`;
- `id: Schema`: named; use `X.get(id)`;
- `singleton: true`: cluster-wide singleton; use `X.get()`.

Resolving or creating a handle writes nothing. The first turn creates durable rows.

`Actor.command(tag, { input, output, errors })` uses the same PascalCase tag for the declaration, handler key, and handle method. A single input schema gives a positional argument, schema fields give an object argument, and omitted input gives a zero-argument command. Errors are explicitly declared yieldable tagged-error schemas, not inferred into a public contract from handler code. `internal` commands are excluded from public handles and transports.

Server code implements commands and workflow bodies together with `X.toLayer`. Query handlers use `X.toQueryLayer`. A workflow is declared with `Actor.workflow(tag, ...)`, listed in `workflows`, and started outside a turn with `x.Ship.start(input, { key })`. Inside a turn it is started as a durable intent with `ctx.self.Ship.start(input)`.

Handlers take `(ctx, input)`; executors take `(ctx, effect)`. Server-only `X.toLayer` options hold `hooks`, `effects`, `run`, `shardGroup`, and `spanAttributes`; contract `lifecycle` holds serializable policies. The Effect form of `toLayer` can build activation-scoped resources and return `X.of(handlers, options)`. Actor files use `<actor>/contract.ts`, `layer.ts`, and `queries.ts`, with workflow/effect role folders as needed.

`state` declares small schema-decoded JSONB values; `vars` declares non-durable activation values. Missing state and initial vars decode from an empty object, so keys need decoding defaults or optional schemas. `Actor.blob` in `blobs` declares database-backed `bytea` chunks; `ctx.blob` writes only in turns and exposes read-only access off-turn. `Actor.migration` upcasts keyed state; relational tables migrate separately.

An outside workflow start returns a `WorkflowRun` with `id`, `key`, `result`, `poll`, and `interrupt`; `x.Ship.run(key)` rehydrates it. `Lifecycle.createdBy(Command)` can require an explicit creating command before others run. Neither workflow execution nor handle acquisition retains an actor turn.

`Cron.every(expression, Command, { skipIfOlderThan })` is a lifecycle policy on a zero-input command of the same actor. On a singleton it runs once cluster-wide. A singleton may also provide a cluster-wide `run` loop.

## Composition

Applications run actors in three forms:

- **embedded:** provide `Actors.layer` and call actor handles as Effects;
- **served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI;
- **hosted:** run the same layers on managed runners with Neki.

`Actor.serve` requires authentication; `Actor.auth.none` is the explicit public opt-out. Authentication sets `CurrentCaller` at the edge. Inside turns, code reads `ctx.caller` and `ctx.principal`.

The API uses runtime schemas at every transport and persistence boundary, preserves the client-minted command identity across retries, and rejects request/reply calls made from inside a command turn.
