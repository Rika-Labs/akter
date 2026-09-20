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

## Files

| File | Role |
| --- | --- |
| [framework/Actor.ts](framework/Actor.ts) | The proposed `Actor` module: `command`, `query`, `stream`, `make`, `workflow`, policies, `Actors` service, `Actor.layer`. Runtime internals (`turn`, `makeHandle`) are `declare`d, not implemented. |
| [example/Counter.ts](example/Counter.ts), [example/Chat.ts](example/Chat.ts) | Contract files. Clients import these. Positional input, zero-arg, struct input, branded ids, events, effects, streams, tables, memory. |
| [example/Counter.server.ts](example/Counter.server.ts), [example/Chat.server.ts](example/Chat.server.ts) | Server files: `X.toLayer(...)`. Object form and Effect form (services acquired once per activation), plus hooks and effect executors. |
| [example/Onboard.ts](example/Onboard.ts), [example/Onboard.server.ts](example/Onboard.server.ts) | A workflow contract and its implementation (activities, durable sleep, full actor handles). |
| [example/usage.ts](example/usage.ts) | Client program, Promise client, and the server layer graph. |

## The surface

```ts
// Chat.ts (contract)
export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))

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
  memory: () => ({ typing: new Set<string>() }),
  lifecycle: [Hibernate.after("5 minutes"), Events.keep("30 days"), Delivery.retry(Schedule.exponential("100 millis"))]
})

// Chat.server.ts (implementation: handlers, hooks, effect executors)
export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.of({
      SendMessage: Effect.fn("Chat.SendMessage")(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.address)
        ...
        yield* ctx.emit(new MessageAdded({ message }))           // after commit
        yield* ctx.perform(new SendEmail({ to, body }))          // outbox, at least once
        yield* ctx.actors.get(Counter, CounterId.make("messages-sent")).Increment.send(1) // durable intent
        return message
      }),
      Recent: (ctx, input) => ...,
      Transcript: (ctx) => ...   // Stream, forked past the mailbox, may read ctx.memory
    })
  }),
  {
    effects: { SendEmail: (effect, ctx) => mailer.send(effect.to, effect.body) },
    lifecycle: [Chat.onWake((ctx) => ...)]
  }
)

// anywhere
const room = yield* Chat.get(RoomId.make("room-1"), { tenant: TenantId.make("acme") })
const msg = yield* room.SendMessage({ id: "m1", body: "hi" }).pipe(Actor.as({ userId: "u1" }))
const counter = yield* Counter.get(CounterId.make("counter-123"))
yield* counter.Increment(5).pipe(Actor.commandId("idempotency-key-from-http"))
yield* counter.Reset()
const stream = room.Transcript()             // Stream<Message, NotAMember | ActorUnavailable>
const ticks = counter.events(CountChanged)   // Stream<CountChanged, never, Scope>
const actors = yield* Actors
actors.get(Counter, CounterId.make("counter-123")) // same handle, non-sugared

// non-Effect callers
const chat = Chat.client({ baseUrl: "https://actors.example.com" })
await chat.get(RoomId.make("room-1")).SendMessage({ id: "m1", body: "hi" })
```

## Decisions recorded in this iteration

| Decision | Choice | Why |
| --- | --- | --- |
| Handle acquisition | `const counter = yield* Counter.get(id)` — one yield, then methods are plain Effects with `R = never` | The runtime is captured at `get`; no `(yield* Svc).method()` at call sites. `Counter.get` is sugar over `Actors.get(Counter, id)`. |
| Identity | `id` is a branded schema (`CounterId`); `Counter.get("c1")` does not compile | Ids from different actors can never be swapped, and the brand documents which table column an id belongs to. |
| Command naming | Tag, handler key, and handle method are the same PascalCase name (`SendMessage`), 1:1 with `Rpc.make` / `RpcClient` | One name per command; nothing to map. |
| Handler signature | `(ctx, input)` | |
| Declarations | Standalone values in arrays: `commands: [...]`, `queries: [...]`, `streams: [...]`, `events: [...]`, `effects: [...]`, `lifecycle: [...]` | Contract values are importable and reusable across actors. |
| Contract / implementation split | `X.ts` exports the definition; `X.server.ts` exports `X.toLayer(...)`, the hooks, and the effect executors | Clients never bundle handler code or server services. Hooks and executors carry code, so they cannot live in the contract. |
| Queries | Run direct on the caller's node against committed rows: no entity hop, no `ActorUnavailable`, no mailbox serialization | A single database makes the read consistent without occupying the actor's turn loop. |
| Streams | Run on the actor's node (so they can read activation memory) but are forked past `concurrency: 1` | A long-lived subscription must never block commands. |
| Fire-and-forget | `.send/.after/.at` exist only on `ctx.self` / `ctx.actors` inside a turn; the outside handle has none | Outside a turn there is no transaction to commit an intent with, so the durability guarantee would be a lie. |
| Ambient call options | `Actor.tenant(id)`, `Actor.as(caller)`, `Actor.commandId(key)` are pipeables over any Effect | Call sites stay `counter.Increment(5)`; cross-cutting values do not become a trailing options argument on every method. |
| `commandId` | Generated by the framework; `ctx.commandId` exposes it; `Actor.commandId` overrides it for externally supplied idempotency keys; intents derive theirs from `(turn commandId, intent index)` | Receipts stay exactly-once without every caller inventing keys. |
| Errors | Command `E` is exactly `declared \| CommandConflict \| ActorUnavailable`; query `E` is `declared`; stream `E` is `declared \| ActorUnavailable` | `ActorUnavailable.cause` keeps the original Cluster error. Nothing collapses to `unknown`. |
| Workflows | `Actor.workflow` is a peer of `Actor.make`, not an actor feature; inside it, actor handles are full request/reply | There is no open turn to hold, so the "no request/reply" rule does not apply. |

## What compiles down to what

| Surface | Effect primitive |
| --- | --- |
| `Actor.command` / `Actor.query` | `Rpc.make(tag, { payload, success, error: Schema.Union(errors) })`, annotated `ClusterSchema.Persisted: true` |
| `Actor.stream` | `Rpc.make(tag, { …, stream: true })`; the handler is wrapped in `Rpc.fork` so it skips the entity's concurrency semaphore |
| `Actor.make` | `RpcGroup.make(...)` + `Entity.fromRpcGroup(name, commands + streams)`; exposed as `X.rpcs` / `X.entity` escape hatches |
| `X.toLayer(handlers, { lifecycle, effects })` | `Entity.toLayer(build, { concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy })`; `Sharding` is supplied from `Actors` so actor layers only require `Actors`. Hooks run inside `turn()` / around activation; effect executors drain the outbox. |
| `X.get(id)` / `Actors.get` | `Sharding.makeClient(entity)` wrapped so each method is a plain Effect and Cluster errors become `ActorUnavailable` |
| `X.client({ baseUrl })` | The same `X.rpcs` group over an HTTP/WebSocket `RpcClient`, unwrapped to Promises and `AsyncIterable`s |
| `Actor.workflow` | `Workflow.make(name, { payload, success, error, idempotencyKey })`; `ctx.activity` is `Activity.make`, `ctx.sleep` is `DurableClock.sleep` |
| `Actor.tenant` / `as` / `commandId` | `Context.Reference` with defaults + `Effect.provideService`; readable from handlers as `ctx.tenantId` / `ctx.caller` / `ctx.commandId` |
| `ctx.db`, `ctx.rows(table)` | `drizzle-orm/effect-postgres` on the same `PgClient`, joined to the turn transaction, pre-filtered by `(tenant_id, actor_id)` |
| `ctx.emit`, `ctx.perform`, `.send`, `.after`, `.at` | Rows in `actor_events` / `actor_outbox` / `actor_intents` inside the turn transaction; delivered post-commit |
| `handle.events(E)` | `Stream` fed by post-commit `NOTIFY` / PubSub, filtered by tag |
| `Actor.layer` | `Layer<Actors, never, Database \| Sharding \| WorkflowEngine>`; the app provides `Database.layer(config)`, a runner layer (`TestRunner.layer` in tests), and `ClusterWorkflowEngine` |

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
| `Cron.every(expr, Command)` | Per-actor timer re-armed after each run; only zero-input commands (cron has no payload to supply) | none |

Not policies, on purpose: `concurrency` is always `1` (a turn is a transaction), `Persisted` is
always `true`, and `WithTransaction` is always `false` (see v3 decision B0: Cluster resumes reply
listeners before the outer commit, and on Neki `cluster_*` and business rows live in different shard groups).

## Types the sketch guarantees (from typecheck.ts)

- `Counter.get(id: CounterId): Effect<CounterHandle, never, Actors>`; a plain `string` id does not compile
- `counter.Increment: (input: number) => Effect<number, Overflow | CommandConflict | ActorUnavailable>`
- `counter.Reset: () => Effect<void, CommandConflict | ActorUnavailable>`
- `counter.GetCount: () => Effect<number, never>` — queries are direct, so no `ActorUnavailable`
- `room.Transcript: () => Stream<Message, NotAMember | ActorUnavailable>`
- `counter.events(CountChanged): Stream<CountChanged, never, Scope>`
- `ctx.self.Reset.after: (delay: Duration.Input, options?: IntentOptions) => Effect<void>`, and there is no `.after` / `.send` on the outside handle
- `CounterLive: Layer<never, never, Actors>`; `ChatLive: Layer<never, never, RoomAccess | Actors>`; `OnboardLive: Layer<never, never, Actors>`; full app `Layer<never, never, never>`
- Handlers reject undeclared errors, missing handlers, wrong input types and unknown commands; `ctx.emit` rejects a non-event, `ctx.perform` rejects a non-effect, a query context has no `emit`, `Cron.every` rejects a command that takes input, and `actors.get` rejects an id of the wrong brand.
- Inside `Effect.fn(...)(function*(ctx, input))`, `ctx` and `input` are contextually typed.

## Unresolved

1. **Caller propagation mechanism** (v3 question 16). `Caller` is a `Context.Reference` with an
   `anonymous` default, so a forgotten `Actor.as(...)` silently authorizes as anonymous instead of
   failing. Alternatives: no default (forcing `R = Caller` into every call site's type), or a
   framework-level guard that rejects commands whose handler reads `ctx.caller` when the reference
   is still the default.
2. **Coding-agent requirements** (v3 question 18). `X.client({ baseUrl })` gives Promises and
   `AsyncIterable`s, but nothing yet emits a machine-readable contract (OpenAPI / JSON Schema) from
   `X.rpcs`, and there is no decision on how an agent discovers which actors exist.
3. **Hooks in the server file.** `onCreate` / `onWake` / `onSleep` are passed to `toLayer` because
   they carry code and services. That splits the actor's lifecycle across two files: retention and
   hibernation are in the contract, creation and wake are not. Acceptable, or should the contract
   declare hook *names* that the server file must implement?
4. **`ctx.workflows.start` as an intent.** It returns `Effect<void>` and is committed with the turn,
   so the caller cannot observe the executionId. Should it return the id (requiring the id to be
   derived from the idempotency key before commit), or stay opaque?
5. **Memory thunk shape.** `memory: () => M` gives one `Ref<M>` per activation, created eagerly. It
   cannot allocate resources (no `Effect`, no `Scope`), so a connection or a subscription has to be
   acquired in `onWake` instead. Should `memory` be `Effect<M, never, Scope>`?
6. **Timer implementation.** `ctx.self.Reset.after(d, { key })` and `Cron.every` could use Cluster's
   `DeliverAt` annotation (storage-level scheduling, no extra table) or a framework `actor_timers`
   table (keyed replace and `ctx.timers.cancel` are trivial; `DeliverAt` has no cancel). Currently
   the surface assumes the table.
7. **Persisted vs non-persisted streams.** Stream RPCs are annotated `Persisted: true` with the rest
   of the group, which means every chunk goes through `cluster_replies`. For a live transcript that
   is wasteful; a non-persisted stream loses resume-after-reconnect. Needs a per-stream choice.
8. **`Database` on Neki**: `Database.layer` must pin `SET __neki.tx_mode='single'` to the connection
   that runs `BEGIN`, and `shardLockDisableAdvisory: true`. `LISTEN/NOTIFY`, `FOR UPDATE`, and
   session pinning are undocumented on Neki and need provider evidence before `handle.events` is
   claimed there.
9. **Repo debt found during review** (not changed): `packages/database/src/index.ts` builds two pools
   (`PgClient.layer` and a raw `pg.Pool` for `drizzle-orm/node-postgres`), so Drizzle never joins an
   Effect transaction; it should use `drizzle-orm/effect-postgres`. `packages/database/src/migrate.ts`
   hand-rolls migrations with raw `pg`; `Migrator` exists in `effect/unstable/sql`.
