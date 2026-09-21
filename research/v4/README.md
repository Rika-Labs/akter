# Research v4 — Effect-native actor API (2026-09-21)

Predecessor: [v3](../v3/README.md) (feature specification). v4 keeps the v3 architecture (one relational
database per deployment, transactional turns, Cluster-backed placement) and replaces the v3 `Actor.define`
sketch with a surface verified against Effect `4.0.0-rc.116` types, recording which Effect primitive each
piece compiles down to.

Everything in this folder typechecks:

```
bunx tsc --noEmit -p research/v4/tsconfig.json
```

[typecheck.ts](typecheck.ts) holds strict type equalities (`any` never satisfies them) and
`@ts-expect-error` negatives, so a regression in the sketch fails the command. Nothing here executes:
runtime internals (`turn`, `makeHandle`, the harness) are `declare`d. The types are the deliverable.

Where the reasoning lives:

- [DECISIONS.md](DECISIONS.md) — every decision (1–172) with the Effect primitive it compiles down to and its
  status; §3.6 is the latest round (one kind, workflows as members, no AI surface, Rivet borrowings); §4 is
  the verification gates that must pass before a claim is made.
- [COMPARISON.md](COMPARISON.md) — the same concepts, side by side, in Durable Actors, Rivet's Effect SDK
  2.3.17 and Cloudflare Durable Objects, with the coding-agent use case in all three and honest ranks.
- [DX.md](DX.md) — the developer/agent-experience review that produced decisions 89–134.
- [PACKAGES.md](PACKAGES.md) — what is not an actor, not the framework, not a package (135–150).
- [DNS-ORDERING.md](DNS-ORDERING.md) — a DNS ordering API written with actors only.

## Files

| File | Role |
| --- | --- |
| [framework/Actor.ts](framework/Actor.ts) | The proposed `durable-actors` module: `command`, `query`, `stream`, `connection`, `workflow`, `blob`, `table`, `migration`, `make`, policies, `Actors`, `Actor.layer`, `Actor.serve`, `Actor.auth`, `ActorError`, contexts, handles. |
| [framework/Testing.ts](framework/Testing.ts) | The `durable-actors/testing` subpath: `ActorTest`, `ActorTest.layer({ as, database, runners, effects })`, bound actors (`test.actor`, `test.create`), typed turn log, durable-state inspection (`state`, `rows`, `events`, `outbox`, `deadLetters`, `receipts`, `timers`), held effects, fault injection, in-process multi-runner cluster, workflow inspection, `seed`, `system` handle, in-process HTTP server, model-based checks, conformance suite. |
| [example/Principal.ts](example/Principal.ts) | The app's subject: branded `UserId` / `OrgId`, the module augmentation that fills in `Principal`, the schema `Actor.layer` decodes with. |
| [example/Counter.ts](example/Counter.ts) / [Counter.server.ts](example/Counter.server.ts) | The smallest actor: positional input, zero-arg command, a query, keyed state, `Cron.every` on the actor itself. |
| [example/Chat.ts](example/Chat.ts) / [Chat.server.ts](example/Chat.server.ts) / [Chat.queries.ts](example/Chat.queries.ts) | A room: struct input, internal command, table, events, effects with executors, a stream, a typed `Live` connection with per-connection state, hooks. The query layer needs `Database`, never `Actors`. |
| [example/Cursor.ts](example/Cursor.ts) / [Cursor.server.ts](example/Cursor.server.ts) | An actor that stores nothing durable — live cursors. Durability is not a flag; declare no state/tables/events and none are written. |
| [example/Doc.ts](example/Doc.ts) / [Doc.server.ts](example/Doc.server.ts) | Blobs (an update-log CRDT) next to keyed state and a table. |
| [example/User.ts](example/User.ts) / [User.server.ts](example/User.server.ts) | A workflow as a member of its owner: `Onboard` in `workflows: [..]`, started as an intent from a turn or from the handle, keyed per room, `ctx.waitFor` on the owner's own events. |
| [example/Reaper.ts](example/Reaper.ts) / [Reaper.server.ts](example/Reaper.server.ts), [example/Nightly.ts](example/Nightly.ts) / [Nightly.server.ts](example/Nightly.server.ts), [example/SandboxReaper.ts](example/SandboxReaper.ts) / [SandboxReaper.server.ts](example/SandboxReaper.server.ts) | Singletons (`singleton: true`): a `run` loop live on one runner, a cluster-wide `Cron.every`, an effect. |
| [example/CodingAgent.ts](example/CodingAgent.ts) / [CodingAgent.server.ts](example/CodingAgent.server.ts) / [services.ts](example/services.ts) | The reference use case: one OpenCode agent per actor in an E2B sandbox that pauses when idle. Uses every member kind, a state migration, `vars`, `run`, `Lifecycle.createdBy`, minted ids. `services.ts` wraps the two Promise SDKs as Effect services (structural SDK types, so it typechecks without the packages). |
| [example/AgentSession.ts](example/AgentSession.ts) / [AgentSession.server.ts](example/AgentSession.server.ts) | The earlier agent sketch (model stream, tool effects reporting back as intents). Kept for the tests that exercise effects and connections. |
| [example/Mailer.ts](example/Mailer.ts), [example/Reports.ts](example/Reports.ts) | An ordinary application service used by executors; cross-actor reads as plain SQL over the same tables through `Database`. |
| [example/usage.ts](example/usage.ts), [example/browser.ts](example/browser.ts), [example/server.ts](example/server.ts) | The Effect client program (ambient caller, one yield per handle), the Promise client for non-Effect callers, and the whole process (`Actor.serve`, `Actor.layer`, `Database.layerConfig`). |
| [example/Counter.test.ts](example/Counter.test.ts), [Chat.test.ts](example/Chat.test.ts), [AgentSession.test.ts](example/AgentSession.test.ts), [CodingAgent.test.ts](example/CodingAgent.test.ts), [cluster.test.ts](example/cluster.test.ts), [sdk.test.ts](example/sdk.test.ts) | Tests against the harness (typecheck-only; the root `vitest.config.ts` does not include `research/`): exactly-once under crashes, receipts, timers on virtual time, held/failed/overridden effects, event replay, hibernation, dead letters, state migration, workflow activity crashes, two-runner kill mid-turn, the Promise SDK over an in-process server. |

## The surface

```ts
// Principal.ts — the app's subject; the framework's `Principal` is empty and augmented
declare module "durable-actors" {
  interface Principal { readonly userId: UserId; readonly orgId: OrgId; readonly roles: ReadonlyArray<"member" | "admin"> }
}

// Chat.ts — the contract; clients import this, it carries no handler code
export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))
export const messages = Actor.table("chat_messages", { id: "text", author_id: "text", body: "text", sent_at: "timestamptz" })

export const SendMessage = Actor.command("SendMessage", { input: { body: Schema.String }, output: Message, errors: [InvalidMessage, NotAMember] })
export const Recent = Actor.query("Recent", { input: { limit: Schema.Number }, output: Schema.Array(Message), errors: [NotAMember] })
export const Live = Actor.connection("Live", { server: Schema.Union([Message, Typing]), client: Typing, state: { typingSince: Schema.optionalKey(Schema.DateTimeUtc) } })

export const Chat = Actor.make("Chat", {
  id: RoomId,                                   // omit `id` and `Chat.create()` mints a UUIDv7
  commands: [SendMessage, MarkDelivered],
  internal: [MarkDelivered],                    // reachable from turns, executors, timers, workflows — not from outside
  queries: [Recent],
  connections: [Live],
  events: [MessageAdded, EmailDelivered],
  effects: [SendEmail],
  tables: [messages],
  lifecycle: [Hibernate.after("5 minutes"), Events.keep("30 days"), Mailbox.capacity(500), Effects.retry(Schedule.spaced("1 second"))]
})

// Chat.server.ts — handlers, hooks, executors; per-activation state is the closure
export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    return Chat.of({
      SendMessage: Effect.fn(function*(ctx, { body }) {
        yield* access.requireMember(ctx.caller, ctx.ref)                    // ctx.caller: User { principal } | System { source }
        const message = new Message({ id: ctx.commandId, authorId: …, body, sentAt: ctx.now })
        yield* ctx.rows(messages).insert({ … })                             // in the turn transaction
        yield* ctx.emit(new MessageAdded({ message }))                       // actor_events, after commit to subscribers
        yield* ctx.perform(new SendEmail({ messageId: message.id, to, body })) // outbox, executed after COMMIT
        yield* ctx.actors.get(User, authorId).NoteMessage.send({ roomId: ctx.id, messageId: message.id }) // durable intent
        yield* ctx.connections.broadcast(message)                            // to open Live connections, after COMMIT
        return message
      }),
      Live: (ctx, inbound) => inbound.pipe(Stream.tap((f) => ctx.connections.broadcast(f, { except: ctx.conn.id })), Stream.drain)
    }, {
      hooks: [Chat.onEffectFailed((ctx, effect, cause) => …), Chat.onDefect((ctx, command, cause) => …)],
      effects: { SendEmail: (ctx, e) => mailer.send(e.to, e.body).pipe(Effect.andThen(ctx.self.MarkDelivered.send({ messageId: e.messageId }))) }
    })
  })
)
export const ChatReads = Chat.toQueryLayer({ Recent: (ctx, { limit }) => ctx.rows(messages).all({ limit, orderBy: … }) })

// a singleton with a cron (Nightly.ts): one tick per schedule for the whole cluster
export const Nightly = Actor.make("Nightly", { singleton: true, commands: [ResetAll], lifecycle: [Cron.every("0 3 * * *", ResetAll)] })

// a workflow as a member (User.ts / User.server.ts)
export const Onboard = Actor.workflow("Onboard", { input: { roomId: RoomId }, output: Schema.Struct({ nudged: Schema.Boolean }), errors: [NotAMember] })
export const User = Actor.make("User", { id: UserId, commands: [Join, NoteMessage], internal: [NoteMessage], workflows: [Onboard], events: [Joined, FirstMessage], state: { … } })

// usage.ts — one yield for the handle, plain Effects after; the caller is ambient for the program
const program = Effect.gen(function*() {
  const room = yield* Chat.get(RoomId.make("room-1"))
  const msg = yield* room.SendMessage({ body: "hi" })            // E = InvalidMessage | NotAMember | ActorError.Of<DeliveryReason>
  yield* room.SendMessage({ body: "again" }).pipe(Actor.commandId(httpIdempotencyKey))
  const recent = yield* room.Recent({ limit: 20 })              // E = NotAMember: no actor hop
  const history = room.events(MessageAdded, { after: 0 })       // Stream: replay from actor_events, then live
  yield* Effect.scoped(Effect.gen(function*() { const conn = yield* room.Live(); yield* conn.frames.pipe(Stream.take(1), Stream.runDrain) }))
  const user = yield* User.get(alice.userId)
  const run = yield* user.Onboard.start({ roomId: RoomId.make("room-1") }, { key: "room-1" })
  const outcome = yield* run.result                             // Effect<{ nudged }, NotAMember | WorkflowInterrupted>
  const agent = yield* CodingAgent.create()                     // minted id; nothing is written until the first command
  yield* agent.Start({ repo: "https://github.com/acme/app" })
}).pipe(Actor.as(alice))

// non-Effect callers (browser.ts)
const chat = Chat.client({ baseUrl: "https://actors.example.com", headers: { authorization: `Bearer ${token}` } })
await chat.get(RoomId.make("room-1")).SendMessage({ body: "hi" })

// server.ts — embedded (leave `Actor.serve` out), served (this file as a process), or hosted (same layers on our runners)
Layer.mergeAll(ChatLive, ChatReads, CounterLive, UserLive, NightlyLive, CodingAgentLive, …).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive, SandboxesLive(e2b), OpenCodeLive(opencodeSdk))),
  Layer.provideMerge(Actor.serve({ actors: [Chat, Counter, User, Nightly, CodingAgent, …], auth: Actor.auth.bearer(verify) })),
  Layer.provide(Actor.layer({ principal: PrincipalSchema, tenant: (p) => TenantId.make(p.orgId), topology: Topology.fromConfig() })),
  Layer.provide(Database.layerConfig())
)
```

## What compiles down to what

| Surface | Effect primitive |
| --- | --- |
| `Actor.command` / `Actor.query` | `Rpc.make(tag, { payload, success, error: Schema.Union(errors) })`, annotated `ClusterSchema.Persisted: true` |
| `Actor.stream` | `Rpc.make(tag, { …, stream: true })`, `Persisted: false`; the handler is wrapped in `Rpc.fork` so it skips the entity's concurrency semaphore |
| `Actor.connection` | A non-persisted bidirectional Rpc stream on the activation; frames validated with the `server` / `client` schemas; `Connections.park` hands the socket to the edge with `conn.state` (≤ 16 KiB) while the entity hibernates |
| `Actor.workflow` (member) | `Workflow.make(name, { payload, success, error, idempotencyKey: (owner, key) })`; `ctx.activity` is `Activity.make` with `Actor.commandId(`${executionId}:${name}`)` piped around `run`; `ctx.sleep` is `DurableClock.sleep`; `ctx.waitFor` is a `DurableDeferred` resolved by a framework intent on the owner |
| `Actor.make` | `RpcGroup.make(...)` + `Entity.fromRpcGroup(name, commands + streams + connections)`; `singleton: true` fixes the id and keeps a boot activation resident |
| `X.of(handlers, { hooks, effects, run })` + `X.toLayer(Effect…)` | The activation's closure: services and per-activation values are captured once in `Entity.toLayer`'s build effect; `run` is `Effect.forkScoped` in that scope, restarted on wake |
| `X.toQueryLayer(handlers)` | An in-process query registry keyed by `(actor, tag)`, resolved on the caller's node against `Database`; requires `Database` only |
| `X.toLayer` options | `Entity.toLayer(build, { concurrency: 1, maxIdleTime, mailboxCapacity, defectRetryPolicy })`; `Sharding` is supplied from `Actors` so actor layers only require `Actors`. Hooks run inside `turn()` / around activation; executors drain the outbox |
| `X.get(id)` / `X.create()` / `Actors.get` | `Sharding.makeClient(entity)` wrapped so each method is a plain Effect with `R = never` (caller bound at `get`), Cluster errors mapped to `ActorError.Of<reason>` |
| `X.client({ baseUrl })` | The same Rpc group over an HTTP/WebSocket `RpcClient`, unwrapped to Promises and `AsyncIterable`s; same error classes |
| `Actor.as` / `Actor.tenant` / `Actor.commandId` | `Context.Reference`s with defaults + `Effect.provideService`; `CurrentCaller` is bound at `get`; readable inside turns as `ctx.caller` / `ctx.tenantId` / `ctx.commandId` |
| `state`, `migrations` | One JSONB row in `actor_state` per actor, decoded through the migration chain on read, encoded with the latest schema on write, in the turn transaction; `State.maxBytes` is a defect above the limit |
| `vars` | A schema'd per-activation record in the build scope; `ctx.vars.set`; dropped on hibernation |
| `ctx.db`, `ctx.rows(table)` | `drizzle-orm/effect-postgres` on the same `PgClient`, joined to the turn transaction, pre-filtered by `(tenant_id, actor_id)` |
| `ctx.emit`, `ctx.perform`, `.send`, `.after`, `.at`, `W.start` | Rows in `actor_events` / `actor_outbox` and envelopes in `cluster_messages` (`MessageStorage.saveEnvelope` on the transaction connection), inside the turn transaction; on Neki the envelope goes to `actor_outbox` in the tenant shard and a relay moves it after COMMIT (decision 156) |
| `handle.events(E, { after })` | Runner-side `PubSub` published after commit over a non-persisted Cluster stream; `after` replays `actor_events` and joins the live feed |
| `ctx.self.X.after(d, { key })`, `Cron.every` | `DeliverAt` payloads in `cluster_messages` plus an `actor_timers` key map, so a keyed timer can be replaced and `ctx.timers.cancel(key)` can delete it; a cron is a timer re-armed after each run |
| `Actor.auth` / `Actor.serve({ auth })` | The principal travels in envelope headers through an `Rpc.middleware` with `requiredForClient: true`, decoded with the schema given to `Actor.layer({ principal })`; `serve` turns request headers into it and fails `Unauthorized({ code })` |
| `Actor.layer({ principal, tenant, topology })` | `Topology.single()` → `SingleRunner.layer`; `Topology.http({ listen, advertise })` → `HttpRunner.layerHttp` + `RunnerHealth.layerPing`; `Topology.k8s()` → `RunnerHealth.layerK8s`; `Sharding` and `WorkflowEngine` provided inside, so the app provides only `Database.layer(...)` |
| `TurnHooks` | `Context.Reference` with an inert default; `turn()` calls `beforeHandler` / `beforeCommit` / `afterCommit`. Exported only from `durable-actors/testing`, which provides one that records every `TurnReport` and dies at the requested crash point |
| `ActorTest.layer({ as, database, runners, effects })` | `Actor.layer` over `Sharding.layer` + `Runners.layerNoop` + the production `SqlMessageStorage` on the test `SqlClient` + a harness `RunnerStorage` + `RunnerHealth.layerNoop`; `runners: n` builds n `Sharding` instances over the shared SQL backend with an in-process `Runners.make` bus; `Database.layer` on PGlite over `pglite-socket` (or a Postgres/Neki url); `TestClock`; a recording `TurnHooks`; executors wrapped so `"hold"` parks outbox rows until `test.effects.run` |

## Lifecycle policies

The `lifecycle` array is the single home for per-actor runtime behaviour. Each policy maps to one knob; a
policy is a tagged value, so unknown combinations are impossible by construction.

| Policy | Maps to | Default |
| --- | --- | --- |
| `Hibernate.after(d)` | `Entity.toLayer.maxIdleTime` | 1 minute |
| `Mailbox.capacity(n \| "unbounded")` | `Entity.toLayer.mailboxCapacity` | `ShardingConfig.entityMailboxCapacity` (4096) |
| `Defects.retry(schedule)` | `Entity.toLayer.defectRetryPolicy` (concatenated with Cluster's default backoff) | Cluster default |
| `Delivery.retry(schedule)` / `Delivery.timeout(d)` | Client-side retry of Cluster delivery errors before `ActorError(ActorUnavailable)`; caller stops waiting → `ActorError(Timeout)` | none / 30 seconds |
| `Effects.retry(schedule)` | Outbox executor retry before dead-lettering a `ctx.perform` effect (then `onEffectFailed` runs inside a turn) | none |
| `Commands.timeout(d)` | `turn()` wraps the handler in a timeout inside the transaction; expiry is a defect, so the transaction rolls back and Cluster redelivers | none |
| `Commands.lockWait(d)` | `SET LOCAL lock_timeout` on the `SELECT … FOR UPDATE` generation fence; expiry is a defect | server default |
| `Receipts.keep(d)` | `actor_receipts` retention; must be ≥ Cluster message retention | 7 days |
| `Events.keep(d \| "forever")` | `actor_events` retention | 30 days |
| `State.maxBytes(n)` | Keyed-state row ceiling; exceeding it is a defect ("move `x` to a table") | 64 KiB |
| `Lifecycle.createdBy(Command)` | Explicit creation: every other command's `E` gains `NotCreated` until the creating command has run | none (implicit creation) |
| `Cron.every(expr, Command, { skipIfOlderThan? })` | Per-actor timer re-armed after each run; zero-input commands only; with `singleton: true` it is cluster-wide | none |
| `Connections.park` / `Connections.keepAwake` | What open connections do to hibernation: park (sockets stay at the edge, `conn.state` restored on the next frame) or count as activity | `park` |

Not policies, on purpose: `concurrency` is always `1` (a turn is a transaction), `Persisted` is always
`true` for commands and always `false` for streams and connections, and `WithTransaction` is always `false`
(v3 decision B0: Cluster resumes reply listeners before the outer commit, and on Neki `cluster_*` and
business rows live in different shard groups).

## Types the sketch guarantees (from typecheck.ts)

- `Counter.get(id: CounterId): Effect<Handle, never, Actors>`; a plain `string` id does not compile; `CodingAgent.create(): Effect<Handle, never, Actors>` exists only when no `id` was declared, and `CodingAgent.id` is the minted branded schema
- `counter.Increment: (input: number) => Effect<number, Overflow | ActorError.Of<DeliveryReason>>` with `R = never`: the caller is bound at `get`
- `counter.GetCount: () => Effect<number, never>` — queries never hop, so no `ActorError`
- `room.Live: () => Effect<Connection<Message | Typing, Typing>, NotAMember | ActorError.Of<DeliveryReason>, Scope>`
- `counter.events(CountChanged, { after: 0 }): Stream<ActorEvent<CountChanged>>` — `ActorEvent` carries `sequence`, `at`, `commandId`
- `user.Onboard.start(input, { key }): Effect<WorkflowRun<{ nudged }, NotAMember>>`; inside the body `ctx.owner.Join(...)` has no delivery errors and reaches internal commands; `ctx.waitFor(FirstMessage)` accepts only the owner's events
- with `Lifecycle.createdBy(Start)`, every command but `Start` carries `ActorError.Of<NotCreated>`
- `ctx.self.Reset.after: (delay, options?) => Effect<void>`; there is no `.after` / `.send` on the outside handle
- `ChatLive: Layer<never, never, RoomAccess | Actors>`; `ChatReads: Layer<never, never, RoomAccess | Database>`; the full app `Layer<never, ConfigError | SqlError, never>`
- Handlers reject undeclared errors, missing handlers, wrong input types and unknown commands; query handlers are rejected by `toLayer` and command handlers by `toQueryLayer`; `ctx.emit` rejects a non-event, `ctx.perform` rejects a non-effect, a query context has no `emit`, `Cron.every` rejects a command that takes input, `Actor.as` rejects a non-`Principal`, `actors.get` rejects an id of the wrong brand, and a handler that needs `Actors` (request/reply inside a turn) does not compile
- Testing: `TurnRecord<typeof Counter>` is a union discriminated on `command`, so `turn.exit` is `Exit<number, Overflow>` once `command === "Increment"`; `ActorState<typeof Chat>["deadLetters"][number]["effect"]` is `SendEmail`; `ActorState<A>["state"]` is `Option<StateOf<A>>`; `test.effects.override(Chat, { SendEmail: (ctx, effect) => … })` types both and derives the fakes' requirements into `R`; `test.faults.crash` rejects an unknown command; `ActorTest.layer()` is `Layer<ActorTest | Actors | Database>` with no requirements

## Testing

The rule: a test never mocks the actor. Every test runs the real `turn()`, the real Cluster entity, the real
tables and the real serialization; only the edges are swapped (database, transport, time, executors,
caller). See [framework/Testing.ts](framework/Testing.ts) and the `example/*.test.ts` files.

| Edge | Production | Test |
| --- | --- | --- |
| database | `Database.layer({ url })` on Postgres / Neki | PGlite in-process over `pglite-socket` (same `PgClient`); `database: { url }` runs the same test on Postgres or Neki |
| storage | `SqlMessageStorage` on the app `SqlClient` | the same `SqlMessageStorage` on the test `SqlClient`, so intents written in a turn roll back with it |
| transport | `Topology.http` / `Topology.k8s` | `Sharding` + `Runners.layerNoop` + harness `RunnerStorage`; `runners: n` builds n `Sharding`s over the shared storage with an in-process `Runners.make` bus (`simulateRemoteSerialization: true`) and a client-only `Sharding` for the caller |
| time | `Clock` | `TestClock`; every durable delay (`DeliverAt` timers, `Hibernate.after`, `Effects.retry`, `Commands.timeout`, `DurableClock`, `shardLockExpiration`) reads it; `test.clock.advance` steps by `entityMessagePollInterval` and settles between steps |
| executors | run after COMMIT with `Effects.retry` | held: `ctx.perform` writes the outbox row and nothing runs until `test.effects.run` / `drain`; `fail` injects a cause for the next n attempts; `override` swaps in typed fakes |
| caller | `CurrentCaller` from the Rpc middleware | one default per layer (`ActorTest.layer({ as })`); `test.actor(X, id, { as })` and `Actor.as` override per handle / per call |
| observation | spans, metrics | `TurnHooks`: the harness records every `TurnReport` (trigger, replayed, exit, emitted, performed, intents, generation) and can die at `before-handler`, `before-commit` or `after-commit` |

What a test can do, all typed per actor:

- `const agent = yield* test.actor(CodingAgent, id)` / `test.create(CodingAgent)` → a bound actor: `handle`, `system` (a `System` caller that reaches internal commands), `inspect`, `turns`, `effects`, `seed({ state, rows })`, `crash`, `pause`, `workflows.crashActivity`
- `agent.inspect` → `ActorState`: `exists`, `generation`, `resident`, `state`, `timers`, `pendingIntents`, `outbox`, `deadLetters`, `receipts`, `events`, `rows(table)`
- `test.effects.pending / run / drain / fail / override`, `test.deadLetters.retry`
- `test.faults.crash` (hook dies → EntityManager restart, same requestId rewritten after the `Defects.retry` delay, which the harness advances through) / `pause` (hook parks; with `cluster.kill` for runner death mid-turn) / `staleGeneration` / `holdLock` (Postgres) / `redeliver` / `chaos`
- `test.cluster.runners / runnerOf / kill / start / isolate` (with `runners: n`)
- `test.clock.advance`, `test.settle`
- `test.serve({ actors, auth })` → the Promise SDK and OpenAPI over an in-process `HttpServer.layerTestClient`
- `test.run(actor, id, script, { concurrency })` and `test.check(actor, id, model, script)` with `Scripts.arbitrary(actor)` for `it.effect.prop`
- `describeConformance(it)` inside `it.layer(ActorTest.layer({ database }))`: the §4 gates as one suite that must pass on PGlite, Postgres and Neki

## Verification gates

Nothing is claimed until the evidence exists. The full table is [DECISIONS.md §4](DECISIONS.md#4-verification-gates-must-pass-before-the-decision-is-claimed); the ones that decide whether the architecture holds:

1. **Intents in the turn transaction on Neki.** `cluster_messages` and the `(tenant_id, actor_id)` business tables are different shard groups. Either the cross-shard-group transaction commits atomically, or (decision 156) the envelope goes to `actor_outbox` in the tenant shard and a relay moves it exactly once after COMMIT.
2. **Neki locking and pooling.** `SELECT … FOR UPDATE` on the generation fence, `SET __neki.tx_mode='single'` pinned to the `BEGIN` connection, session behaviour behind a pooler.
3. **PGlite under Bun**, one fresh database per `it.layer` block, framework and `SqlMessageStorage` migrations applying; lock-contention tests routed to real Postgres.
4. **In-process multi-runner cluster.** The harness `RunnerStorage` (per-address locks, `Clock` expiry) and `Runners.make` bus driving N `Sharding` instances; `cluster.kill` + `clock.advance(> shardLockExpiration)` moves the shard.
5. **Crash points.** Source-verified that `withTransaction` rolls back on a failed Exit and `EntityManager` rewrites the same envelope after the defect retry delay; still to show the harness advancing the TestClock through that delay from inside the hook, and `pause` + `cluster.kill` recovering on the survivor.
6. **Intent rollback.** On `SqlMessageStorage`, an intent written by a turn that then fails `beforeCommit` is never delivered.
7. **State migration chain**, **connection park** (sockets survive hibernation, `conn.state` restored, `resumed === true`), **singleton uniqueness** with two runners (one cron tick per schedule, one live `run` loop, both move on kill).
