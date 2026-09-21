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

Server code implements commands and workflow bodies together with `X.toLayer`. Query handlers use `X.toQueryLayer`. A workflow is declared with `Actor.workflow(tag, ...)`, listed in `workflows`, and started outside a turn with `x.Ship.start(input, { key })`. Inside a turn it is started as a durable intent with `ctx.self.Ship.start(input)`.

`Cron.every(expression, Command, { skipIfOlderThan })` is a lifecycle policy on a zero-input command of the same actor. On a singleton it runs once cluster-wide. A singleton may also provide a cluster-wide `run` loop.

## Composition

Applications run actors in three forms:

- **embedded:** provide `Actors.layer` and call actor handles as Effects;
- **served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI;
- **hosted:** run the same layers on managed runners with Neki.

`Actor.serve` requires authentication; `Actor.auth.none` is the explicit public opt-out. Authentication sets `CurrentCaller` at the edge. Inside turns, code reads `ctx.caller` and `ctx.principal`.

The API uses runtime schemas at every transport and persistence boundary, preserves the client-minted command identity across retries, and rejects request/reply calls made from inside a command turn.
