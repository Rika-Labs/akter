# Server API

**Responsibility:** define actor declarations and server composition.  
**Authority:** API design.  
**Owner role:** API/Effect.
**Change policy:** a change requires compatibility review against docs/api/versioning.md.

The Effect-native server API is one package, `durable-actors`. Its root entry exports `Actor`, `Intent`, `Fleet`, errors, and identity; `Actor.serve` and `Actor.auth` are target APIs and are not exported yet. Runtime construction is imported separately as `Actors.layer` from `durable-actors/runtime`.

## Implemented foundation subset

The executable slice is embedded and single-runner on Postgres or PGlite. It predates [ADR 0010](../decisions/0010-one-way-effect-native-api.md) and [ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md): its `Actor.make` options, `(ctx, input)` handlers, `Actors.mint`, `get` options, and persisted Cluster command messages are the current code, not the target. Migrating it is M1 work. The rest of this document is the target API.

- `Actor.command(tag, { input?, output?, errors? })` accepts service-free schemas. Omitted input/output is `void`; JSON codecs preserve it through persistence. Declared errors must be yieldable tagged errors.
- `Actor.make(name, { commands, internal?, state?, id?, singleton?, lifecycle? })` implements all three identity modes. Omitted `id` mints UUIDv7s through the branded `X.id` schema and `Actors.mint(X)`; `Actors.mint` rejects named and singleton definitions in types. A named `id` schema gives `get(id)`; `singleton: true` gives `get()` and registers through `Sharding.registerSingleton` on the single embedded runner. `create` exists only on minted actors — typed `never` otherwise and a runtime defect if invoked. `internal` commands never appear on public handles or definitions; `ActorTest.actor` obtains their handle through a package-internal registry. `lifecycle` accepts `Commands.timeout`/`lockWait`, `Delivery.timeout`, `State.maxBytes`, `Hibernate.after`, `Mailbox.capacity`, and `Lifecycle.createdBy`; defaults are 30 s, 2 s, 30 s, 65,536 bytes of the complete encoded state object, 60 s, unbounded, and none. Values are positive integers to 2^31 − 1; duplicate policies and `createdBy` commands from another actor are rejected at `Actor.make`. See [ADR 0008](../decisions/0008-foundation-completion.md) for policy rationale.
- `ctx` supplies `ref`, `caller`, `principal` (an `Option`), `commandId`, and schema-decoded state with `state.set(patch)`. State changes become visible only after commit. Captured request/reply handles cannot run in turns; escaped state setters die. The command deadline covers the whole turn transaction plus transaction-local `statement_timeout`/`lock_timeout`; expiry redelivers the same envelope, and an uncertain commit never resolves to a terminal result. `Delivery.timeout` only stops the caller waiting — the durable message continues. `Lifecycle.createdBy` fails non-creating commands `NotCreated` without a receipt until the creating command commits; adding the policy to actors with pre-existing rows requires an application migration. No owned SQL adapter, events, timers, intents, or external side-effect capability is provided yet. Handlers must remain short and must not call providers or perform independent database writes.
- Constructing a command Effect creates one operation. Its first execution mints an ID using the database clock; rerunning that same Effect reuses it. A new method call creates a new operation. To retry across processes, save an ID from `(yield* Actors).mintCommandId` and apply `call.pipe(Actor.commandId(id))` before its first execution. This is not `Effect` memoization: every external retry rechecks access and expiry.
- `/runtime` exports `Actors.layer({ authorize, retryWindowMs? })`, `Database.postgres({ url: Redacted.make(url), ... })`, and `Database.pglite(config?)`. Supply a platform `Crypto` layer, such as `BunCrypto.layer`. The required authorization callback receives the captured `caller`, `ref`, and `command` at admission and before returning an outcome. `User.make({ subject })` and `System({ source, ref?, onBehalfOf? })` are application-trusted attribution, not authentication. Default `Anonymous` is one shared logical identity; default tenant is `"default"`. `Actor.as(caller)` scopes `CurrentCaller` while acquiring handles.
- `Database.pglite` creates a fresh owned instance per layer build; a supplied `liveClient` config keeps its own methods and lifetime. Owned instances drain tracked queries before closing — the pinned driver deadlocks when closed mid-exchange. Cluster runner bookkeeping uses in-memory storage on PGlite because `SqlRunnerStorage` would reserve the sole connection; this confers no independent-connection or concurrent-ownership guarantee. `Database.postgres` includes a scoped `regclass` codec for the pinned rc.116 driver restart bug; it does not modify global driver configuration.
- The retry window defaults to 86,400,000 ms, accepts 1–2,592,000,000 ms, and is recorded in the database. A different setting fails startup. State, receipt, creation-marker, and Cluster migrations run at startup, so use a disposable database for the example. Protocol/ID v1 is unchanged; no rolling mixed-version support is claimed.
- `/testing` exports `ActorTest.layer({ database?, as?, authorize?, retryWindowMs? })`, with a fresh tenant per build, committed `inspect(ref)`, `crashNext(point)`, `pauseNext(point)`, and `invalidate(ref)`. `database` defaults to a fresh in-memory PGlite; a `dataDir` config persists across builds and a `Redacted` URL uses Postgres. `test.actor(X, id?)` returns `{ system, inspect }` where `system` reaches every command including internal ones with a `System` caller that inherits the configured principal. Fault points are `beforeHandler`, `beforeCommit`, and `afterCommit`. These use real Cluster SQL storage, not a fake handler context. `TurnHooks` is available only through the testing entry for process-level faults. `/testing` also exports the framework-neutral `conformance` cases and `describeConformance`; the same named cases run on PGlite and Postgres, and cases needing a second connection are reported skipped on PGlite.

See the runnable [counter](../../examples/counter/src/main.ts), the [protocol](../decisions/0007-foundation-command-protocol.md) and [foundation completion](../decisions/0008-foundation-completion.md) decisions, and the [conformance ledger](../verification/01-conformance.md#foundation-evidence). This subset is not a production-support claim; singleton registration does not imply multi-runner residency or migration.

## Definitions

`Actor.make(name, definition)` is the only way to make an actor, and the definition is its only shape: there is no piping or later configuration. Every section is data; code lives in layers. See [ADR 0010](../decisions/0010-one-way-effect-native-api.md).

```ts
import { Effect, Result, Schema } from "effect"
import { Actor } from "durable-actors"

export const CounterId = Schema.String.pipe(Schema.brand("CounterId"))
export class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { max: Schema.Int }) {}
export class CountChanged extends Actor.Event<CountChanged>()("CountChanged", {
  count: Schema.Int,
}) {}

export const CounterState = Actor.state({
  count: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})

export const Increment = Actor.reducer("Increment", {
  description: "Add `amount`. Fails with Overflow above 1000.",
  state: CounterState,
  input: Schema.Int,
  errors: [Overflow],
  reduce: (state, amount) =>
    state.count + amount > 1_000
      ? Result.fail(new Overflow({ max: 1_000 }))
      : Result.succeed({ count: state.count + amount }),
})
export const Reset = Actor.command("Reset", { description: "Set to zero and announce it." })
export const GetCount = Actor.query("GetCount", { output: Schema.Int })

export const Counter = Actor.make("Counter", {
  key: CounterId,
  state: CounterState,
  events: [CountChanged],
  api: { Increment, Reset, GetCount },
  policy: { hibernateAfter: "30 seconds", cron: { "0 * * * *": Reset } },
})
```

| Section     | Content                                                                                                                                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`       | id schema (named, `X.get(id)`), `Actor.singleton` (`X.get()`), or omitted (minted, `X.create()`)                                                                                                                                                            |
| `placement` | `"tenant"` (default), `"actor"`, or a parent actor definition                                                                                                                                                                                               |
| `state`     | one `Actor.state(fields, { migrations })`; missing keys decode from defaults                                                                                                                                                                                |
| `tables`    | `Actor.table` Drizzle tables with framework ownership columns                                                                                                                                                                                               |
| `blobs`     | `Actor.blob` database-backed `bytea` chunks                                                                                                                                                                                                                 |
| `events`    | `Actor.Event` classes                                                                                                                                                                                                                                       |
| `effects`   | `Actor.effect` classes, executed after commit                                                                                                                                                                                                               |
| `api`       | public commands, reducers, queries, streams, connections, and workflows; each key equals its member's tag                                                                                                                                                   |
| `internal`  | commands callable only by System callers: outbox intents, effect routes, and cron                                                                                                                                                                           |
| `policy`    | `hibernateAfter`, `commandTimeout`, `lockWait`, `deliveryTimeout`, `maxStateBytes`, `mailboxCapacity`, `createdBy`, `keepReceipts`, `keepEvents`, `effects` (per-effect `retry`, `onSuccess`, `onDeadLetter`), `connections`, `cron`, `cronSkipIfOlderThan` |

Members:

- `Actor.command(tag, { input?, output?, errors? })` runs an effectful server handler. A single input schema gives a positional argument, struct fields an object argument, and omitted input a zero-argument call. Listing it under `internal` instead of `api` removes it from public handles and transports.
- `Actor.reducer(tag, { state, input, errors?, reduce, commutative? })` is a pure transition with no server handler. It runs optimistically in browser handles; with `commutative: { combine }` it may merge across runners, returns `void`, and declares no errors.
- `Actor.query`, `Actor.stream`, `Actor.connection`, and `Actor.workflow` declare reads, live streams, typed sessions, and durable workflows.

Type checks replace lists that must agree: an `api` or `internal` key must equal its tag; `cron`, `createdBy`, and effect routes must name a command in `api` or `internal`; cron targets take no input; and an effect's `onSuccess` command input must match its executor's return type. The tag, `api` key, handler key, and handle method are the same PascalCase name.

## Layers

```ts
export const CounterLive = Counter.toLayer(
  Effect.succeed({
    Reset: Effect.fn(function* () {
      const turn = yield* Counter.Turn
      yield* turn.state.set({ count: 0 })
      yield* turn.emit(new CountChanged({ count: 0 }))
    }),
  }),
)

export const CounterReads = Counter.toQueryLayer(
  Effect.succeed({
    GetCount: Effect.fn(function* () {
      const read = yield* Counter.Read
      return read.state.count
    }),
  }),
)
```

- `X.toLayer(build)` implements commands (public and internal), streams, connections, and workflows. Reducers have no entry. The build Effect runs once per activation: it replaces wake hooks; `Effect.addFinalizer` replaces sleep hooks; `Effect.forkScoped` replaces `run` on singletons; a `Ref` replaces `vars`. There is no defect hook: deterministic defects are recorded in the turn span ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)).
- `X.toQueryLayer(build)` implements queries against committed data.
- `X.toEffectLayer(build)` implements effect executors and may run on separate processes. An executor returns the value routed to its `onSuccess` command (or `void`); the framework delivers it through the outbox with the effect id as the command id, and delivers `onDeadLetter` with `Actor.DeadLetter(Effect)` input when retries are exhausted.

Each takes the Effect form only; there is no options object. Handlers take only their input. Context is a typed service per phase (`X.Turn`, `X.Read`, `X.Connection`, `X.Workflow`, `X.Executor`); see [context](02-context.md). Actor files use `<actor>/contract.ts`, `layer.ts`, `queries.ts`, and `effects.ts`, with a `workflows/` folder as needed. Workflow bodies use Effect's `Activity` and `DurableClock` on the framework's own `WorkflowEngine`, which stores steps on the owner's shard ([ADR 0012](../decisions/0012-workflows-internals-effects-defects-merging-regions.md)).

## Calling actors

```ts
const counter = yield * Counter.get(id)
const state = yield * counter.Increment(5) // request/reply

const later = yield * Counter.intents(id) // inside a turn only
yield * later.Increment(1) // commits with the turn, delivered after
yield * later.Reset().pipe(Intent.after("1 hour"), Intent.key("idle"))
yield * Intent.cancel("idle")
```

Outside a turn, every call is request/reply and direct: the command runs in its owner's turn, and the committed receipt is its only durable admission record ([ADR 0011](../decisions/0011-direct-commands-outbox-and-performance.md)). The handle retries retryable failures with the same command id. Work that must survive a caller crash is an intent written by a turn, or a workflow.

Inside a turn, `X.intents(id)` returns the same method shape as durable intents. They are committed with the turn, delivered after commit, and deduplicated by the receiver's receipt. Self-intents use `X.intents(turn.id)`. Calling `X.get` inside a turn is a type error, and a captured handle dies at runtime. Workflows start as `later.Ship(input)` inside a turn and `counter.Ship(input)` outside; outside calls return a `WorkflowRun`.

Caller and tenant are ambient: the edge sets them per request, `ActorTest.layer` per test, and `Actor.as(caller)` and `Actor.tenant(tenant)` around an Effect. `get` takes no options. `Actor.commandId(id)` supplies an explicit command id. Acquiring a handle writes nothing; the first turn creates durable rows.

## Composition

Applications run actors in three forms:

- **embedded:** provide the layers and `Actors.layer`, and call handles as Effects;
- **served:** add `Actor.serve` for HTTP, WebSocket, SSE, and OpenAPI;
- **hosted:** run the same layers on managed runners with Neki.

`Actor.serve` requires authentication; `Actor.auth.none` is the explicit public opt-out. Authentication sets `CurrentCaller` at the edge. The API uses runtime schemas at every transport and persistence boundary and preserves the command identity across retries.
