# Research v4 — Effect-native actor API (2026-09-21)

Predecessor: [v3](../v3/README.md) (feature specification). v4 does not change the v3 architecture
(single relational database, transactional turns, Cluster-backed placement). It replaces the v3
`Actor.define` sketch in [01-actor-context](../v3/features/01-actor-context/README.md) with a surface
that is verified against Effect `4.0.0-rc.116` types, and records which Effect primitives each piece
compiles down to.

Everything in this folder typechecks:

```
bunx tsc --noEmit -p research/v4/tsconfig.json
```

[typecheck.ts](typecheck.ts) holds strict type equalities (`any` never satisfies them) and
`@ts-expect-error` negatives, so a regression in the sketch fails the command.

Every product decision behind this surface, with the Effect primitive it compiles down to and its
status, is in [DECISIONS.md](DECISIONS.md).

## Files

| File | Role |
| --- | --- |
| [framework/Actor.ts](framework/Actor.ts) | The proposed `Actor` module: `command`, `query`, `stream`, `make`, `workflow`, `cron`, `table`, policies, `Actors` service, `Actor.layer({ principal, topology })`, `Actor.serve`, `Actor.auth`. Runtime internals (`turn`, `makeHandle`) are `declare`d, not implemented. |
| [example/Principal.ts](example/Principal.ts) | The app's subject: a branded `UserId`, the module augmentation that fills in `Principal`, and the schema `Actor.layer` decodes with. |
| [example/Counter.ts](example/Counter.ts), [example/Chat.ts](example/Chat.ts) | Contract files. Clients import these. Positional input, zero-arg, struct input, branded ids, events, effects, streams, `Actor.table`. |
| [example/Counter.server.ts](example/Counter.server.ts), [example/Chat.server.ts](example/Chat.server.ts) | Server files: `X.toLayer(...)`. Object form and Effect form (services *and* per-activation state captured in a closure), plus hooks and effect executors. |
| [example/Chat.queries.ts](example/Chat.queries.ts) | The query layer: `Chat.queries(...)` requires `Database`, never `Actors`. |
| [example/Onboard.ts](example/Onboard.ts), [example/Onboard.server.ts](example/Onboard.server.ts) | A workflow contract and its implementation (activities, durable sleep, `ctx.waitFor`, full actor handles). |
| [example/Nightly.ts](example/Nightly.ts), [example/Nightly.server.ts](example/Nightly.server.ts) | A cluster-wide cron job: `Actor.cron(name, { cron })`, one run per schedule. |
| [example/AgentSession.ts](example/AgentSession.ts), [example/AgentSession.server.ts](example/AgentSession.server.ts), [example/AgentSession.client.ts](example/AgentSession.client.ts) | The reference program: a coding-agent session (prompts, token stream, tool calls, model/tool effects whose results return as intents, browser client). |
| [example/usage.ts](example/usage.ts) | Client program, Promise client, and the server layer graph. |
| [framework/Testing.ts](framework/Testing.ts) | The `durable-actors/testing` subpath: `ActorTest` service and `ActorTest.layer(...)`, typed turn log, durable-state inspection, held effects, fault injection, in-process multi-runner cluster, workflow inspection, in-process HTTP server, model-based checks, `Scripts.arbitrary`, conformance suite. Runtime `declare`d. |
| [example/Counter.test.ts](example/Counter.test.ts), [example/Chat.test.ts](example/Chat.test.ts), [example/AgentSession.test.ts](example/AgentSession.test.ts), [example/Onboard.test.ts](example/Onboard.test.ts), [example/cluster.test.ts](example/cluster.test.ts), [example/sdk.test.ts](example/sdk.test.ts) | Test files written against that surface (typecheck-only; root `vitest.config.ts` does not include `research/`). Exactly-once under crashes, receipts, timers on virtual time, held/failed/overridden effects, event replay, workflow activity retries, rebalance without double apply, Promise SDK over a test server, PGlite/Postgres/Neki conformance. |

## The surface

```ts
// Principal.ts (the app's subject; the framework's `Principal` is empty and augmented)
declare module "../framework/Actor.ts" {
  interface Principal { readonly userId: UserId; readonly roles: ReadonlyArray<"member" | "admin"> }
}

// Chat.ts (contract)
export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))
export const messages = Actor.table("chat_messages", { id: "text", body: "text" })

export const SendMessage = Actor.command("SendMessage", {
  input: { id: Schema.String, body: Schema.String },
  output: Message,
  errors: [InvalidMessage, NotAMember]
})
export const Recent = Actor.query("Recent", { input: { limit: Schema.Number }, output: Schema.Array(Message), errors: [NotAMember] })
export const Transcript = Actor.stream("Transcript", { output: Message, errors: [NotAMember] })

export const Chat = Actor.make("Chat", {
  id: RoomId,
  commands: [SendMessage],
  queries: [Recent],
  streams: [Transcript],
  events: [MessageAdded],
  effects: [SendEmail],
  tables: [messages],
  lifecycle: [Hibernate.after("5 minutes"), Events.keep("30 days"), Delivery.retry(Schedule.exponential("100 millis"))]
})

// Chat.server.ts (handlers, hooks, effect executors; per-activation state is a closure)
export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    const typing = yield* Ref.make(new Set<string>())
    return Chat.of({
      SendMessage: Effect.fn(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.address)          // ctx.caller: Caller
        ...
        yield* ctx.emit(new MessageAdded({ message }))                // after commit
        yield* ctx.perform(new SendEmail({ to, body }))               // outbox, at least once
        yield* ctx.actors.get(Counter, CounterId.make("sent")).Increment.send(1) // durable intent
        return message
      }),
      Transcript: (ctx) => ...   // Stream, forked past the mailbox, live only
    }, {
      lifecycle: [Chat.onWake(() => Ref.set(typing, new Set())), Chat.onEffectFailed((ctx, effect, cause) => ...)],
      effects: { SendEmail: (effect, ctx) => mailer.send(effect.to, effect.body) }
    })
  })
)

// Chat.queries.ts (reads; Database only, no entity hop)
export const ChatReads = Chat.queries({ Recent: (ctx, input) => ... })

// anywhere: every call from outside a turn names its caller
const room = yield* Chat.get(RoomId.make("room-1"), { tenant: TenantId.make("acme") })
const msg = yield* room.SendMessage({ id: "m1", body: "hi" }).pipe(Actor.as(principal))
const counter = yield* Counter.get(CounterId.make("counter-123"))
yield* counter.Increment(5).pipe(Actor.commandId("idempotency-key-from-http"), Actor.as(principal))
yield* counter.Reset().pipe(Actor.anonymous)
const stream = room.Transcript()                     // Stream<Message, NotAMember | ActorUnavailable, CurrentCaller>
const ticks = counter.events(CountChanged, { from: 0 }) // Stream<ActorEvent<CountChanged>, never, Scope>

// cluster-wide cron: the framework's caller is System("cron")
export const NightlyLive = Actor.cron("nightly-reset", { cron: "0 3 * * *" }).toLayer(resetEverything)

// non-Effect callers
const chat = Chat.client({ baseUrl: "https://actors.example.com" })
await chat.get(RoomId.make("room-1")).SendMessage({ id: "m1", body: "hi" })

// server graph
Layer.mergeAll(CounterLive, ChatLive, ChatReads, OnboardLive, NightlyLive, AgentSessionLive).pipe(
  Layer.provide(Actor.layer({ principal: PrincipalSchema, topology: Topology.http({ listen, advertise }) })),
  Layer.provide(Database.layer({ url, migrate: "auto" }))
)
```

## Decisions recorded in this iteration

| Decision | Choice | Why |
| --- | --- | --- |
| Handle acquisition | `const counter = yield* Counter.get(id)` — one yield, then methods are plain Effects with `R = CurrentCaller` | The runtime is captured at `get`; no `(yield* Svc).method()` at call sites. `Counter.get` is sugar over `Actors.get(Counter, id)`. |
| Identity | `id` is a branded schema (`CounterId`); `Counter.get("c1")` does not compile | Ids from different actors can never be swapped, and the brand documents which table column an id belongs to. |
| Command naming | Tag, handler key, and handle method are the same PascalCase name (`SendMessage`), 1:1 with `Rpc.make` / `RpcClient` | One name per command; nothing to map. |
| Handler signature | `(ctx, input)` | |
| Declarations | Standalone values in arrays: `commands: [...]`, `queries: [...]`, `streams: [...]`, `events: [...]`, `effects: [...]`, `lifecycle: [...]` | Contract values are importable and reusable across actors. |
| Contract / implementation split | `X.ts` exports the definition; `X.server.ts` exports `X.toLayer(...)`, the hooks, and the effect executors | Clients never bundle handler code or server services. Hooks and executors carry code, so they cannot live in the contract. |
| Queries | Run direct on the caller's node against committed rows: no entity hop, no `ActorUnavailable`, no mailbox serialization; they get their own layer (`X.queries`), which requires `Database` and not `Actors` | A single database makes the read consistent without occupying the actor's turn loop. |
| Streams | Run on the actor's node (so they can read the activation closure) but are forked past `concurrency: 1`, and are live only (`Persisted: false`) | A long-lived subscription must never block commands, and a live transcript is not worth a row in `cluster_replies` per chunk. |
| Fire-and-forget | `.send/.after/.at` exist only on `ctx.self` / `ctx.actors` inside a turn; the outside handle has none | Outside a turn there is no transaction to commit an intent with, so the durability guarantee would be a lie. |
| Caller | `CurrentCaller` is a required service with no default: `Actor.as(principal)` or `Actor.anonymous` on the call, `System(...)` provided by the framework inside turns, workflows, cron and effect executors | A forgotten caller is a compile error instead of a silent anonymous authorization. `Principal` is an empty interface the app augments. |
| Ambient call options | `Actor.tenant(id)`, `Actor.commandId(key)` are pipeables over any Effect (`Context.Reference` with defaults) | Call sites stay `counter.Increment(5)`; cross-cutting values do not become a trailing options argument on every method. |
| `commandId` | Generated by the framework; `ctx.commandId` exposes it; `Actor.commandId` overrides it for externally supplied idempotency keys; intents derive theirs from `(turn commandId, intent index)` | Receipts stay exactly-once without every caller inventing keys. |
| Errors | Command `E` is exactly `declared \| CommandConflict \| ActorUnavailable` (plus `NotCreated` under `Lifecycle.createdBy`, and neither delivery error inside a workflow); query `E` is `declared`; stream `E` is `declared \| ActorUnavailable` | `ActorUnavailable.cause` keeps the original Cluster error. Nothing collapses to `unknown`. |
| Workflows | `Actor.workflow` is a peer of `Actor.make`, not an actor feature; inside it, actor handles are full request/reply | There is no open turn to hold, so the "no request/reply" rule does not apply. |

## What compiles down to what

| Surface | Effect primitive |
| --- | --- |
| `Actor.command` / `Actor.query` | `Rpc.make(tag, { payload, success, error: Schema.Union(errors) })`, annotated `ClusterSchema.Persisted: true` |
| `Actor.stream` | `Rpc.make(tag, { …, stream: true })`, annotated `ClusterSchema.Persisted: false` (live only); the handler is wrapped in `Rpc.fork` so it skips the entity's concurrency semaphore |
| `Actor.make` | `RpcGroup.make(...)` + `Entity.fromRpcGroup(name, commands + streams)`; exposed as `X.rpcs` / `X.entity` escape hatches |
| `X.of(handlers, { lifecycle, effects })` + `X.toLayer(Effect…)` | The activation's closure: services and per-activation state are captured once in `Entity.toLayer`'s build effect; `X.of` only tags the result so the overloads can tell it from a plain handlers object |
| `X.queries(handlers)` | An in-process query registry keyed by `(actor, tag)`, resolved on the caller's node against `Database`; requires `Database` only, never `Actors` or `Sharding` |
| `X.toLayer(handlers, { lifecycle, effects })` | `Entity.toLayer(build, { concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy })`; `Sharding` is supplied from `Actors` so actor layers only require `Actors`. Hooks run inside `turn()` / around activation; effect executors drain the outbox. |
| `X.get(id)` / `Actors.get` | `Sharding.makeClient(entity)` wrapped so each method is a plain Effect and Cluster errors become `ActorUnavailable` |
| `X.client({ baseUrl })` | The same `X.rpcs` group over an HTTP/WebSocket `RpcClient`, unwrapped to Promises and `AsyncIterable`s |
| `Actor.workflow` | `Workflow.make(name, { payload, success, error, idempotencyKey })`; `ctx.activity` is `Activity.make` with `Actor.commandId(`${executionId}:${name}`)` piped around `run`, `ctx.sleep` is `DurableClock.sleep` |
| `Actor.tenant` / `commandId` | `Context.Reference` with defaults + `Effect.provideService`; readable from handlers as `ctx.tenantId` / `ctx.commandId` |
| `ctx.db`, `ctx.rows(table)` | `drizzle-orm/effect-postgres` on the same `PgClient`, joined to the turn transaction, pre-filtered by `(tenant_id, actor_id)` |
| `ctx.emit`, `ctx.perform`, `.send`, `.after`, `.at` | Rows in `actor_events` / `actor_outbox` and envelopes written into `cluster_messages` (`MessageStorage.saveEnvelope` on the transaction connection), all inside the turn transaction; the target runner is notified after COMMIT |
| `handle.events(E, { from })` | Runner-side `PubSub` published after commit, delivered over a non-persisted Cluster stream; `from` replays `actor_events` and joins the live feed |
| `ctx.self.X.after(d, { key })`, `Cron.every` | `DeliverAt` payloads in `cluster_messages` plus an `actor_timers` key map, so a keyed timer can be replaced and `ctx.timers.cancel(key)` can delete it |
| `Actor.cron(name, { cron })` | `ClusterCron.make({ name, cron, execute })` — one run per schedule for the whole cluster, with `System("cron")` as the caller |
| `CurrentCaller` / `Actor.as` / `Actor.auth` | The principal travels in the envelope headers through an `Rpc.middleware` with `requiredForClient: true`, decoded with the schema given to `Actor.layer({ principal })`; `Actor.serve({ auth })` turns request headers into it |
| `ctx.terminate` | Tombstones the generation, deletes the declared `tables` rows and the actor's timers in the turn transaction |
| `ctx.waitFor(Actor, id, Event)` | `DurableDeferred` plus a framework intent the actor resolves when it emits the event |
| `Actor.layer({ principal, topology })` | `Topology.single()` → `SingleRunner.layer`; `Topology.http({ listen, advertise })` → `HttpRunner.layerHttp` + `RunnerHealth.layerPing`; `Topology.k8s()` → `HttpRunner.layerHttp` + `RunnerHealth.layerK8s`. `Sharding` and `WorkflowEngine` are provided inside, so actor layers only require `Actors` and the app only provides `Database.layer(...)` |
| `TurnHooks` | `Context.Reference` with an inert default; `turn()` calls `beforeHandler` / `beforeCommit` / `afterCommit`. Production never provides it. The test harness provides one that records every `TurnReport` and dies at the requested crash point |
| `ActorTest.layer({ database, runners, effects })` | `Actor.layer` over `TestRunner.layer` (`Sharding` + `Runners.layerNoop` + `MessageStorage.layerMemory` + `RunnerStorage.layerMemory`) for one runner, or N `Sharding` instances over one in-memory `MessageStorage`, a harness `RunnerStorage` (per-address shard locks expiring on the `Clock`) and a `Runners.make` in-process bus; `Database.layer` on PGlite over `pglite-socket` (or a Postgres/Neki url); `TestClock` from `@effect/vitest`; a recording `TurnHooks`; executors wrapped so `"hold"` parks outbox rows until `test.effects.run` |

## Lifecycle policies

The `lifecycle` array is the single home for per-actor runtime behaviour. Each policy maps to one
knob; unknown combinations are impossible by construction (a policy is a tagged value, not a config
object).

| Policy | Maps to | Default |
| --- | --- | --- |
| `Hibernate.after(d)` | `Entity.toLayer.maxIdleTime` | 1 minute |
| `Mailbox.capacity(n \| "unbounded")` | `Entity.toLayer.mailboxCapacity` | `ShardingConfig.entityMailboxCapacity` (4096) |
| `Defects.retry(schedule)` | `Entity.toLayer.defectRetryPolicy` (Cluster concatenates it with its default backoff and re-writes in-flight requests after restart) | Cluster default |
| `Delivery.retry(schedule)` | Client-side retry of Cluster delivery errors before they surface as `ActorUnavailable` | none |
| `Effects.retry(schedule)` | Outbox executor retry before dead-lettering a `ctx.perform` effect | none |
| `Commands.timeout(d)` | `turn()` wraps the handler in a timeout inside the transaction; expiry is a defect, so the transaction rolls back and Cluster redelivers | none |
| `Commands.lockWait(d)` | `SET LOCAL lock_timeout` on the `SELECT … FOR UPDATE` generation fence; expiry is a defect | server default |
| `Receipts.keep(d)` | `actor_receipts` retention. Must be ≥ Cluster message retention; purge `cluster_replies`, then `cluster_messages`, then receipts | 7 days |
| `Events.keep(d \| "forever")` | `actor_events` retention | 30 days |
| `Lifecycle.createdBy(Command)` | Explicit creation: every other command's `E` gains `NotCreated` until the creating command has run | none (implicit creation) |
| `Cron.every(expr, Command)` | Per-actor timer re-armed after each run; only zero-input commands (cron has no payload to supply) | none |

Not policies, on purpose: `concurrency` is always `1` (a turn is a transaction), `Persisted` is
always `true` for commands and always `false` for streams, and `WithTransaction` is always `false` (see v3 decision B0: Cluster resumes reply
listeners before the outer commit, and on Neki `cluster_*` and business rows live in different shard groups).

## Types the sketch guarantees (from typecheck.ts)

- `Counter.get(id: CounterId): Effect<CounterHandle, never, Actors>`; a plain `string` id does not compile
- `counter.Increment: (input: number) => Effect<number, Overflow | CommandConflict | ActorUnavailable, CurrentCaller>` — commands, queries and streams all require `CurrentCaller`, so a forgotten caller is a compile error, not an anonymous authorization
- `counter.GetCount: () => Effect<number, never, CurrentCaller>` — queries are direct, so no `ActorUnavailable`
- `room.Transcript: () => Stream<Message, NotAMember | ActorUnavailable, CurrentCaller>`
- `counter.events(CountChanged, { from: 0 }): Stream<ActorEvent<CountChanged>, never, Scope>` — `ActorEvent` carries `sequence`, `at` and `commandId`
- inside a workflow, `ctx.actors.get(Chat, id).SendMessage(...): Effect<Message, InvalidMessage | NotAMember>` — no delivery errors, `R = never`; `ctx.waitFor(Chat, id, MessageAdded): Effect<Option<MessageAdded>>` and an event of another actor does not compile
- with `Lifecycle.createdBy(Increment)`, `Reset` carries `NotCreated` and `Increment` does not
- `ctx.self.Reset.after: (delay: Duration.Input, options?: IntentOptions) => Effect<void>`, and there is no `.after` / `.send` on the outside handle
- `ctx.terminate: Effect<void>`; there is no `ctx.memory` (per-activation state is a closure)
- `CounterLive: Layer<never, never, Actors>`; `ChatLive: Layer<never, never, RoomAccess | Actors>`; `ChatReads: Layer<never, never, RoomAccess | Database>`; `NightlyLive` / `AgentSessionLive`: `Layer<never, never, Actors>`; full app `Layer<never, ConfigError | SqlError, never>`
- Handlers reject undeclared errors, missing handlers, wrong input types and unknown commands; query handlers are rejected by `toLayer` and command handlers by `queries`; `ctx.emit` rejects a non-event, `ctx.perform` rejects a non-effect, a query context has no `emit`, `Cron.every` rejects a command that takes input, `Actor.as` rejects a non-`Principal`, and `actors.get` rejects an id of the wrong brand.
- Inside `Effect.fn(function*(ctx, input))`, `ctx` and `input` are contextually typed; spans are opened by the framework, so handlers do not name them.
- Testing: `TurnRecord<typeof Counter>` is a union discriminated on `command`, so `turn.exit` is `Exit<number, Overflow>` once `command === "Increment"`; `Step<typeof Counter>` carries each command's input type (`undefined` for zero-arg commands); `ActorState<typeof Chat>["deadLetters"][number]["effect"]` is `SendEmail`; `test.effects.override(Chat, { SendEmail: (effect, ctx) => … })` types `effect` and `ctx`, derives the fakes' requirements into the returned Effect (`Scope | RoomAccess`), and rejects an effect of another actor; `test.faults.crash` rejects an unknown command; `test.run(Counter, …)` rejects a Chat step; `ActorTest.layer()` is `Layer<ActorTest | Actors | Database | CurrentCaller>` with no requirements.

## Testing

The rule: a test never mocks the actor. Every test runs the real `turn()`, the real Cluster entity,
the real tables and the real serialization; only the edges are swapped (database, transport, time,
executors, caller). See [framework/Testing.ts](framework/Testing.ts) and the `example/*.test.ts` files.

| Edge | Production | Test |
| --- | --- | --- |
| database | `Database.layer({ url })` on Postgres / Neki | PGlite in-process over `pglite-socket` (same `PgClient`); `database: { url }` runs the same test on Postgres or Neki |
| transport | `Topology.http` / `Topology.k8s` | `TestRunner.layer` (in-memory `MessageStorage` + `RunnerStorage`, `Runners.layerNoop`); `runners: n` builds n `Sharding`s on one in-memory `MessageStorage`, a harness `RunnerStorage` and an in-process `Runners.make` bus with `simulateRemoteSerialization: true` |
| time | `Clock` | `TestClock`; every durable delay (`DeliverAt` timers, `Hibernate.after`, `Effects.retry`, `Commands.timeout`, `DurableClock`, `shardLockExpiration`) reads it, and `test.clock.advance` steps by `entityMessagePollInterval` and settles between steps |
| executors | run after COMMIT with `Effects.retry` | held: `ctx.perform` writes the outbox row and nothing runs until `test.effects.run` / `drain`; `fail` injects a cause for the next n attempts; `override` swaps in typed fakes |
| caller | `CurrentCaller` from the Rpc middleware | one default per layer (`Anonymous` unless `caller` is set); `Actor.as` still wins per call |
| observation | spans, metrics | `TurnHooks`: the harness records every `TurnReport` (trigger, replayed, exit, emitted, performed, intents, generation) and can die at `before-handler`, `before-commit` or `after-commit` |

What a test can do, all typed per actor:

- `test.inspect(Counter, id)` → `ActorState`: `exists`, `generation`, `resident`, `timers`, `pendingIntents`, `outbox`, `deadLetters`, `receipts`, `events`, `rows(table)`
- `test.turns.of(Counter, id)` / `next` / `test.record(effect)` → the committed turns, `exit` typed per command
- `test.effects.pending / run / drain / fail / override`
- `test.faults.crash / staleGeneration / holdLock (Postgres) / redeliver / chaos`
- `test.cluster.runners / runnerOf / kill / start / isolate` (with `runners: n`)
- `test.workflows.inspect / crashActivity`
- `test.serve({ actors, auth })` → the Promise SDK and OpenAPI over an in-process `HttpServer.layerTestClient`
- `test.run(actor, id, script, { concurrency })` and `test.check(actor, id, model, script)` with `Scripts.arbitrary(actor)` for `it.effect.prop`
- `describeConformance(it)` inside `it.layer(ActorTest.layer({ database }))`: the §3 gates as one suite that must pass on PGlite, Postgres and Neki

## Verification gates

Nothing below is claimed until the evidence exists.

1. **Intents in the turn transaction on Neki.** `turn()` writes intent envelopes into `cluster_messages`
   through `MessageStorage.saveEnvelope` on the transaction connection. On Neki `cluster_*` and the
   `(tenant_id, actor_id)` business tables are different shard groups, so this is a cross-shard-group
   transaction; it needs provider evidence that it commits atomically (or a documented fallback).
2. **Neki locking and pooling.** `SELECT … FOR UPDATE` on the generation fence,
   `SET __neki.tx_mode='single'` pinned to the connection that runs `BEGIN`, and session behaviour
   behind a pooler are all undocumented; the generation fence depends on them.
3. **Railway per-replica advertise address.** `Topology.http({ advertise })` needs each replica's own
   routable address; the mechanism (and whether it is stable across restarts) must be confirmed.
4. **PGlite limits for the lock tests.** Fencing, concurrency and recovery tests must run on real
   Postgres; PGlite's single-connection model cannot express the `FOR UPDATE` contention cases.
5. **PGlite under Bun.** `@electric-sql/pglite` + `pglite-socket` must run under Bun's test runner
   (vitest here) fast enough for one fresh database per `it.layer` block, and the framework and
   `SqlMessageStorage` migrations must apply on it.
6. **In-process multi-runner cluster.** Neither stock `RunnerStorage` fits: `layerMemory.acquire`
   grants every requested shard to any caller (verified in rc.116 source), and `SqlRunnerStorage`
   expires locks against the database's `now()`, so `TestClock` cannot expire a killed runner's
   shards. The harness provides its own `RunnerStorage` (per-address ownership, expiry on `Clock`,
   `shardLockExpiration` default 35s) and a `Runners.make` bus; both must be shown to drive N
   `Sharding` instances in one process.
7. **Crash points are real crashes.** `TurnHooks.beforeCommit` dying must abort the transaction
   (no partial write), and dying in `afterCommit` must leave the entity's reply undelivered so Cluster
   redelivers, or the harness has to interrupt the activation fiber instead of failing the hook.
