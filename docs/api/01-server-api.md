# Server API

**Responsibility:** define actor declarations and server composition.  
**Authority:** API design.  
**Owner role:** API/Effect.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The Effect-native server API is one package, `durable-actors`. Its root entry exports `Actor`, policies, errors, identity, `Actors`, `Actor.serve`, and `Actor.auth`. Runtime construction is imported separately as `Actors.layer` from `durable-actors/runtime`.

## Implemented foundation subset

The first executable slice is embedded and single-runner on Postgres. The rest of this document remains the target API.

- `Actor.command(tag, { input?, output?, errors? })` accepts service-free schemas. Omitted input/output is `void`; JSON codecs preserve it through persistence. Declared errors must be yieldable tagged errors.
- `Actor.make(name, { id?, commands, state })` supplies `get(id, { as?, tenant? })`, minted `create({ as?, tenant? })` when `id` is omitted, and `toLayer(handlers)`. `get` captures caller and tenant. Handle acquisition does not write actor rows. Singleton identities, branded per-actor ID helpers, migrations, and lifecycle policies are not exposed yet.
- `ctx` supplies `ref`, `caller`, `commandId`, and schema-decoded state with `state.set(patch)`. State changes become visible only after commit. Captured request/reply handles cannot run in turns; escaped state setters die. No owned SQL adapter, external side-effect capability, or turn deadline is provided yet. Handlers must remain short and must not call providers or perform independent database writes.
- Constructing a command Effect creates one operation. Its first execution mints an ID using the database clock; rerunning that same Effect reuses it. A new method call creates a new operation. To retry across processes, save an ID from `(yield* Actors).mintCommandId` and apply `call.pipe(Actor.commandId(id))` before its first execution. This is not `Effect` memoization: every external retry rechecks access and expiry.
- `/runtime` exports `Actors.layer({ authorize, retryWindowMs? })` and `Database.postgres({ url: Redacted.make(url), ... })`. Supply a platform `Crypto` layer, such as `BunCrypto.layer`. The required authorization callback receives the captured `caller`, `ref`, and `command` at admission and before returning an outcome. `User.make({ subject })` is application-trusted attribution, not authentication. Default `Anonymous` is one shared logical identity; default tenant is `"default"`.
- The retry window defaults to 86,400,000 ms, accepts 1–2,592,000,000 ms, and is recorded in the database. A different setting fails startup. State, receipt, and Cluster migrations run at startup, so use a disposable database for the example. `Database.postgres` includes a scoped `regclass` codec for the pinned rc.116 driver restart bug; it does not modify global driver configuration.
- `/testing` exports `ActorTest.layer({ database, as?, authorize?, retryWindowMs? })`, with a fresh tenant per build, committed `inspect(ref)`, `crashNext(point)`, `pauseNext(point)`, and `invalidate(ref)`. Fault points are `beforeHandler`, `beforeCommit`, and `afterCommit`. These use real Cluster SQL storage, not a fake handler context. `TurnHooks` is available only through the testing entry for process-level faults. PGlite and shared `conformance`/`describeConformance` exports remain pending.

See the runnable [counter](../../examples/counter/src/main.ts), [protocol decision](../decisions/0005-foundation-command-protocol.md), and [test evidence](../verification/01-conformance.md#foundation-postgres-evidence). This subset is not a production-support claim.

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
