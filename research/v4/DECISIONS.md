# Durable Actors — decision ledger (v4, 2026-09-21)

Every product and API decision taken in the v4 review, in the order it was asked. `#` is the question
number used in the review threads; letters are the option the owner picked. "Primitive" is the Effect
`4.0.0-rc.116` construct the decision compiles down to. "Status" is `settled`, `settled (interpreted)`
when the answer needed interpretation (veto if wrong), `delegated` when the owner said "your pick",
or `gated` when a verification must pass before the decision is claimed.

The typechecked sketch that embodies this ledger is [framework/Actor.ts](framework/Actor.ts); the
testing surface is [framework/Testing.ts](framework/Testing.ts). The latest rounds are §3.8 (181–192, scale and performance) and §3.9 (193–212, one way to do everything); the
comparison against Rivet's Effect SDK and Cloudflare Durable Objects is [COMPARISON.md](COMPARISON.md).

## 0. Foundations (carried from v3)

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | Storage | One relational database per deployment: self-hosted Postgres, PlanetScale Neki in cloud. No per-actor database. | Business rows, actor bookkeeping and Cluster storage share transactions and backups. | `PgClient` (drizzle on the same pool) | settled |
| F2 | Runtime | Effect Cluster `Entity` per actor type, one activation per id, `concurrency: 1`. | Placement, mailbox, redelivery and idle shutdown come from Cluster. | `Entity.toLayer`, `Sharding` | settled |
| F3 | Transaction model ("B0") | Messages `Persisted: true`, `WithTransaction: false`, no Cluster `primaryKey`. The framework `turn()` owns one transaction per command: generation fence (`SELECT … FOR UPDATE`) → receipt lookup → handler → events / intents / effects / receipt → COMMIT. | Cluster resumes reply listeners before an outer commit; on Neki `cluster_*` and business rows live in different shard groups. | `SqlClient.withTransaction` | settled |
| F4 | Retryable = defect | Stale generation, lock timeout, commit-unknown, command timeout are defects; Cluster restarts the entity per `Defects.retry` and redelivers. Declared errors are the only typed failures. | Keeps `E` exact and makes redelivery the single recovery path. | `defectRetryPolicy` | settled |
| F5 | Neki shard key | `actor_*` and business tables share `(tenant_id, actor_id)`; `cluster_*` is a single-shard group; `shardLockDisableAdvisory: true`; `SET __neki.tx_mode='single'` on the connection that runs `BEGIN`. | | `ShardingConfig`, `Database.layer({ neki })` | gated (Neki evidence) |

## 1. Contract surface (round 1–2)

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | Names | a — tag = handler key = handle method, PascalCase (`counter.Increment(1)`), 1:1 with the Rpc tag. | One name per command. | `Rpc.make(tag)` | settled |
| 2 | Declaring commands | a — `Actor.command(tag, { input, output, errors: [...] })`; `input` is a schema (positional arg), struct fields (object arg) or omitted (zero-arg). Errors are declared, not inferred. | Rpc derives the handler type from the declared error schema. | `Rpc.make({ payload, success, error })` | settled |
| 3 | Grouping | a — separate `commands`, `queries`, `streams` arrays on `Actor.make`. | | `RpcGroup.make` | settled |
| 4 | Queries | b — run direct on the caller's node against committed rows; `E` = declared errors only. | Single database: no Cluster hop, no `ActorUnavailable`. | `Database` | settled |
| 5 | Events | a — declared per actor (`events: [MessageAdded]`); `ctx.emit` typed to them. | | `actor_events` | settled |
| 6 | Ids | b — branded (`id: CounterId`); `get` accepts only the brand. | Wrong-actor ids fail at compile time. | `Schema.brand` | settled |
| 7 | `get` | a — infallible, implicit create on first turn. | | | settled (see 52 for opt-in explicit create) |
| 8 | Tenant | b — explicit `get(id, { tenant })` with ambient default; branded `TenantId`; `Actor.tenant(id)` pipeable. | | `Context.Reference` | settled |
| 9 | State | a — declared tables only, no state blob. | Rows are queryable, migratable, shardable. | drizzle | superseded by 125 (keyed `state` added next to tables) |
| 10 | Table access | b — `tables: [...]` declared on the actor; `ctx.rows(table)` pre-scoped to `(tenant_id, actor_id)`. | | drizzle query builder | settled |
| 11 | Hooks | b — values in a `lifecycle` array. Interpreted: hooks carry code, so they live in the server file (`X.onCreate/onWake/onSleep/onEffectFailed`) and are passed with `X.of(handlers, { lifecycle })`; contract-side `lifecycle` holds serializable policies only. | Clients never bundle handler code. | superseded by 109 |
| 12 | `ctx.self` | b — intents only (`ctx.self.Reset.after("1 hour")`); no request/reply to self inside a turn. | A turn holds a transaction open. | intents | settled |
| 13 | Other actors in a turn | b — intents only via `ctx.actors.get(Other, id).Cmd.send(...)`. | Same reason as 12. | intents | settled |
| 14 | Memory | b — declared `memory` on the actor. **Superseded by 51.** | | | superseded |
| 15 | `commandId` override | b — pipeable `Actor.commandId("key")`. | Ambient, no trailing option on every call. | `Context.Reference` | settled |
| 16 | Caller propagation | Resolved by 35–36. | | | superseded |
| 17 | Fire-and-forget outside a turn | a — not allowed; outside handles have no `.send`. | Every outside call is request/reply with a receipt. | | settled |
| 18 | Coding agents | Resolved by 40. | | | superseded |
| 19 | Streams | `Actor.stream` — routed via the actor, forked past the mailbox. | Long streams never block commands. | `Rpc.make({ stream: true })`, `Rpc.fork` | settled |
| 20 | Non-Effect client | `X.client({ baseUrl })` Promise client derived from `X.rpcs`. | | `RpcClient` | superseded by 114 |
| 21 | Timers | b — keyed: `.after(d, input, { key })`, `.at(when, …)`, `ctx.timers.cancel(key)`; same key replaces. | | `DeliverAt` (see 38) | settled |
| 22 | Cron | a — `Cron.every(expr, ZeroInputCommand)` policy. | | see 39 | settled |
| 23 | Side effects | a — `effects: [SendEmail]`, `ctx.perform(new SendEmail(...))`, executors in the server file, `Effects.retry(schedule)` policy. Executed after commit, at least once. | Outbox pattern with typed payloads. | `actor_outbox` | settled |
| 24 | Workflows | `Actor.workflow(name, { input, output, errors, idempotencyKey })`, `W.toLayer((ctx, input) => …)`, `ctx.activity`, `ctx.sleep`, `ctx.actors`; `ctx.workflows.start(W, input)` intent inside turns. | | `Workflow.make`, `Activity.make`, `DurableClock` | superseded by 119 |
| 25 | Declarative subscriptions | a — none; actors subscribe by sending intents from handlers. | | | settled |
| 26 | Delivery failure | a — `ActorUnavailable { reason, cause }` wrapping the Cluster error. | Nothing collapses to `unknown`. | `ClusterError` | superseded by 105 |
| 27 | Delivery retry | b — `Delivery.retry(schedule)` policy before `ActorUnavailable`. | | `Schedule` | settled |
| 28 | Retryable conditions | a — pure defect path (see F4). | | | settled |
| 29 | Test layer | a — `Actor.testLayer`. **Refined by 62.** | | | superseded |
| 30 | Names | `Actor.make`, `X.toLayer`, `Actors`, `Hibernate.after`, `Turn`, `CommandConflict`, `ActorUnavailable`. | | | settled |
| 31 | Packaging | a — one package, namespaces. **Refined by 61.** | | | settled |
| 32 | ORM | a — `drizzle-orm/effect-postgres` on the framework `PgClient` (one pool, joins Effect transactions). | Fixes the two-pool debt in `packages/database`. | `PgClient` | settled |
| 33 | Migrations | a — framework tables via Effect `Migrator`; app tables via drizzle-kit. **Refined by 65.** | | `Migrator` | settled |
| 34 | Neki pinning | a — inside `Database.layer({ neki: true })`. | | | gated |

## 2. Round 3

### Caller and tenant

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 35 | Principal shape | b — app-defined via module augmentation: `declare module "durable-actors" { interface Principal { userId: UserId; … } }` plus a schema registered once in `Actor.layer({ principal })`. | Typed `ctx.caller` everywhere with no generics on contexts; a schema because the principal rides in the envelope headers and is persisted with the message. | `Rpc.middleware` (`requiredForClient: true`), envelope `headers` | settled |
| 36 | Attribution | a + b — `ctx.caller` is `User(principal) \| System({ source }) \| Anonymous`, **and** every outside call must be attributed: handle methods carry `R = CurrentCaller` until `Actor.as(principal)` / `Actor.anonymous` / the HTTP auth middleware provides it. Inside turns, workflows, cron and executors the framework provides `System`. | Explicit attribution at the edge; timers and cron still have a well-typed caller. | `Context.Service` (no default) | superseded by 89–91 |
| 37 | Tenant placement | Must work on Neki and plain Postgres. Entity id = `${tenant}/${id}`; all tenants in Cluster's `default` shard group for now; `Actor.layer({ shardGroup: (tenant) => … })` reserved for dedicated runner pools. | | `ClusterSchema.ShardGroup` | settled (interpreted) |

### Timers and cron

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 38 | Timer implementation | a — a scheduled intent is a persisted Cluster message whose payload implements `DeliverAt`; `actor_timers(tenant, actor, key → message_id)` maps keys; cancel/replace tombstones the old message id and the framework drops a tombstoned message on delivery. Works on Neki and Postgres because `cluster_messages` is one shard group. | Cluster already polls `deliver_at`; the framework owns only the key map. | `DeliverAt`, `SqlMessageStorage` | settled |
| 39 | Cron | a — both: per-actor `Cron.every(expr, Cmd)` (arms on the first turn, re-arms after each run) and cluster-wide `Actor.cron(name, { cron })` with `Nightly.toLayer(run)` that can talk to actors. | Per-actor schedules and fleet-wide jobs are different primitives. | self-timer; `ClusterCron.make` + `Singleton` | settled |

### Coding agents, streams, events

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 40 | Coding agents | Recommendation taken: (iii) both — actors are the runtime for agent sessions **and** the SDK is optimized for LLM authors. `AgentSession` is the reference program (`SendPrompt`, `Cancel`, `ApproveTool`; `Tokens` stream; `TurnStarted/ToolCalled/TurnFinished` events; `CallModel/RunTool` effects; `turns`/`toolCalls` tables). Hard parts, in order: resumable output (events + cursor), durable tool calls (effects + dead letters), human-in-the-loop waits (`ctx.waitFor` in workflows). Contracts export JSON Schema / OpenAPI for agent tooling (57). | | | settled (interpreted) |
| 41 | Stream durability | a — `Actor.stream` is always live (`Persisted: false`): cheap, dies with the activation. Durable output goes through events with a cursor. | A persisted stream writes every chunk to `cluster_replies`. | `ClusterSchema.Persisted` | settled |
| 42 | Event cursor | b — `events(E, { from })` yields `ActorEvent<E> = { sequence, at, commandId, event }`; `from` replays `actor_events` then joins live. | Reconnecting browsers and agents resume without gaps. | `actor_events(sequence)` | settled |
| 43 | Event fan-out | c — through the actor's runner: after COMMIT the turn publishes into the activation's PubSub; subscribers anywhere reach it via a non-persisted Cluster stream. No `LISTEN/NOTIFY`, so Neki is not special. Slow subscribers get a sliding buffer and catch up with `from`. | Single writer keeps ordering; no database feature dependency. | `PubSub`, non-persisted stream Rpc | settled |

### Effects, intents, idempotency

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 44 | Executor exhaustion | b — dead-letter row (`actor_dead_letters`) + `Actors.deadLetters` admin API + server-side hook `X.onEffectFailed((ctx, effect, cause) => …)` that runs inside a turn. | The actor can react (mark undelivered, notify). | framework command | settled |
| 45 | Executor context | a — no `db`: executors are side effects only; results flow back as intents (`ctx.self.EmailSent.send(...)`). | Post-commit, at-least-once code must not write business rows non-atomically. | | settled |
| 46 | Where intents go | a — inserted straight into `cluster_messages` inside the turn transaction (via `MessageStorage.saveEnvelope` on the fiber-scoped transaction connection), target runner notified after COMMIT. **Amended by 156:** on Neki, where `cluster_messages` (single shard group) and the tenant's rows cannot share a transaction, the turn writes the intent to `actor_outbox` (same shard as the actor) and a relay on the actor's runner moves it into `cluster_messages` after COMMIT; the receipt makes the relay idempotent. Postgres keeps the direct write. | Atomic with the turn; the relay is the one Neki-only code path and is exercised by the conformance suite. | `SqlMessageStorage`, `actor_outbox` | settled; gated (Neki conformance) |
| 47 | Duplicate `commandId` | a — same payload hash returns the stored `Exit` (`Schema.Exit(output, Union(errors))`), declared failures included; different payload fails with `CommandConflict`. | Exactly-once visible to the caller. | `Schema.Exit` | settled |
| 48 | `Actor.commandId` scope | a — covers everything inside the pipe, documented "one command per key"; a second consumer of the same key in one scope is a defect. | | `Context.Reference` | settled |

### Queries, memory, lifecycle

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 49 | Query placement | c — `X.queries({ Recent: … })` is its own layer requiring only `Database`, so API nodes host reads without hosting the entity; `X.toLayer` holds commands, streams, hooks and executors. | Clients import contracts; API tier imports the queries layer; workers import the server layer. | `Layer` | settled |
| 50 | Memory-backed reads | a — use a stream (`Actor.stream` runs on the actor's node and sees the closure). | | | settled |
| 51 | Memory | a — no `memory` declaration; per-activation state is a closure in the Effect form of `toLayer` (`Chat.toLayer(Effect.gen(function*() { const typing = yield* Ref.make(...); return Chat.of({...}, { lifecycle: [...] }) }))`). | One concept fewer; streams and hooks share the closure. | `Entity.toLayer(Effect)` | delegated |
| 52 | Explicit creation | b — opt-in `Lifecycle.createdBy(CreateRoom)`: the creating command must run first; other commands gain `NotCreated` in `E`. | Default stays implicit (7). | type-level policy | delegated |
| 53 | Deletion | a — `ctx.terminate()` inside a turn: tombstones the generation, deletes rows in declared `tables`, purges timers; later commands recreate (or `NotCreated` under 52). | | | delegated |

### Workflows

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 54 | Handles in workflows | a — `WorkflowHandle`: `E` = declared errors only, `R = never`; the framework retries delivery and treats `CommandConflict` as a defect. | Activities should not hand-`catchTags` retryable errors. | | delegated |
| 55 | Command ids in activities | a — the framework pipes `Actor.commandId(`${executionId}:${activityName}`)` around the activity's `run`. | Activity retries never double-apply commands. | receipts | delegated |
| 56 | Waiting on events | a — `ctx.waitFor(Actor, id, Event, { timeout })` → `Option<Event>`, backed by `DurableDeferred` plus a framework intent that resolves it. | Human-in-the-loop for agent sessions. | `DurableDeferred` | delegated |

### Transport, SDK, deployment

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 57 | HTTP surface | c — Rpc protocol first (SDK, native streams), plus an HttpApi with OpenAPI derived from the same contract for third parties and tool generation. | | `RpcServer.layerProtocolHttp/WebSocket`, `EntityProxy.toHttpApiGroup` | delegated |
| 58 | Edge auth | b — `Actor.auth((headers) => Effect<Principal, Unauthorized>)`; the framework turns it into the Rpc middleware that provides `CurrentCaller`. | | `RpcMiddleware.Service` | delegated |
| 59 | Promise SDK errors | a — thrown instances of the same `Schema.TaggedError` classes; `httpApiStatus` drives HTTP codes. | | `Schema.Exit` decoding | delegated |
| 60 | Topology | multi-runner: `Actor.layer({ topology: Topology.http({ listen, advertise }) })` with `HttpRunner.layerHttp` + `RunnerHealth.layerPing`; `Topology.single()` (`SingleRunner.layer`) for dev/tests; `Topology.k8s()` (`RunnerHealth.layerK8s`). | | `HttpRunner`, `RunnerHealth`, `SqlRunnerStorage` | settled; gated (Railway per-replica advertise address) |
| 61 | Packaging | a — one package with subpaths: `durable-actors` (contracts, `Actor`, `Actors`), `durable-actors/pg` (`Database`, migrations), `durable-actors/client` (browser-safe Promise SDK), `durable-actors/testing` (`ActorTest`). | Browser bundles never pull `effect/unstable/sql`. | package `exports` | delegated |

### Testing, observability, schema, evolution

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 62 | Test databases | a — PGlite in-process (over `@electric-sql/pglite-socket`, so the real `PgClient` is used) for unit and cluster tests; real Postgres for lock-contention, multi-connection and conformance tests; virtual time everywhere via `TestClock`. `ActorTest.layer({ database: "pglite" \| { url, neki } })` in [framework/Testing.ts](framework/Testing.ts). | PGlite multiplexes one connection, so `FOR UPDATE` contention is only real on Postgres. | `TestClock`, `SqlMessageStorage`, `Runners.layerNoop` | delegated; gated (PGlite under Bun) |
| 63 | Spans | a — framework spans `actor.turn`, `actor.intent`, `actor.effect`, `actor.query`, `actor.stream` with `actor.type`, `actor.id`, `tenant`, `command`, `commandId`, `generation`; `Effect.fn("...")` names in handlers are optional. | | `Effect.withSpan`, `ClusterMetrics` | delegated |
| 64 | Tables | a — `Actor.table(name, columns)` adds `tenant_id`, `actor_id` and the composite index and returns a real drizzle `pgTable` (drizzle-kit still sees it). | | drizzle | delegated |
| 65 | Framework schema | a — `Database.layer({ migrate: "auto" })` runs the Effect `Migrator` at boot; `"manual"` exposes `Database.migrate` / a CLI. | | `Migrator` | delegated |
| 66 | Neki gate | a — design for "Postgres without `LISTEN/NOTIFY` or session pinning" everywhere (43, 46), then run one conformance suite (`FOR UPDATE`, `SET __neki.tx_mode='single'`, pooling, cross-shard-group transaction) before claiming support. | One code path. | conformance suite in `durable-actors/testing` | gated |
| 67 | Contract evolution | a — additive-only rule with `Schema` defaults, documented; no versioned commands yet. | Persisted messages and 30-day events decode with future code. | `Schema.optionalKey` / defaults | delegated |
| 68 | Names | `ctx.perform`, `Actor.as`, `Defects.retry`, `Actor.stream`, `Lifecycle.createdBy`. | | | delegated |

### Testing surface (round 3, "most testable actor framework")

Owner asked for the ability to "test and do anything we can"; the shape below is my pick and every
row is veto-able. Embodied in [framework/Testing.ts](framework/Testing.ts) and `example/*.test.ts`.

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 69 | Test boundary | No handler-only "fake ctx" harness. Every test runs the real `turn()`, entity, tables and serialization; only database, transport, time, executors and caller are swapped. | A fake `ctx` would pass tests the real transaction fails (fencing, receipts, outbox ordering). PGlite is fast enough. | `ActorTest.layer` (see 82: not `TestRunner.layer`), PGlite | delegated |
| 70 | Harness shape | One service, `ActorTest`, from `ActorTest.layer(options)` → `Layer<ActorTest \| Actors \| Database \| CurrentCaller>`, used with `it.layer(...)`; sub-harnesses `clock`, `turns`, `effects`, `faults`, `cluster`, `workflows`, `serve`, `inspect`, `record`, `run`, `check`. | Matches the house `@effect/vitest` style (`it.layer`, `it.effect`). | `Context.Service`, `it.layer` | delegated |
| 71 | Observation seam | `TurnHooks` (`Context.Reference`, inert default) called by `turn()` at `beforeHandler` / `beforeCommit` / `afterCommit` with a `TurnReport`. The harness records turns and injects crashes through it; production never provides it. | One seam instead of test-only branches in `turn()`. A hook defect is faithful: `SqlClient.withTransaction` rolls back on a failed Exit; `EntityManager` restarts on a defect and rewrites the same envelope after the defect retry delay (verified in rc.116 source, Oracle review). | `Context.Reference` | delegated |
| 72 | Effects in tests | Held by default (`effects: "hold"`): `ctx.perform` writes the outbox row, nothing runs until `test.effects.run` / `drain`; `fail(actor, Effect, cause, { times })` and `override(actor, fakes)`. | Model calls and emails stay out of the happy path; retry → dead letter → `onEffectFailed` becomes explicit steps. | outbox rows, `Effects.retry` on `TestClock` | delegated |
| 73 | Typed fakes | `override<A, const X extends Partial<EffectExecutors<…, any>>>(actor, fakes: X & NoExtraKeys<X, tags>)`: `effect`/`ctx` contextually typed, requirements derived with `ExecutorServices<X>` (`-?` + `NonNullable`, so a pretyped `Partial` keeps its `R`), unknown effect names rejected. Asserted for inline arrows, `Effect.fn`, `Effect.gen`, a pretyped `Partial`, `{}`, two fakes needing different services, and strict `Eq` (not `any`) on `effect`/`ctx`. | `Partial<mapped<…, R>>` with `A` unfixed cannot infer `R`; a `Record<string, …>` intersection infers `R` but types `effect` as `any`. Same shape as `Entity.toLayer<Handlers extends HandlersFrom<Rpcs>>`. | `Effect.Services` | delegated (verified in typecheck.ts) |
| 74 | Isolation | One fresh tenant per `ActorTest.layer` build (per `it.layer` block); `test.reset` clears it between tests. | Files never share rows; a block shares one PGlite. | `Actor.tenant` | delegated |
| 75 | Time | `test.clock.advance(d)` steps `TestClock` by `ShardingConfig.entityMessagePollInterval` and settles between steps. | A timer that arms another timer fires in order. `MemoryDriver` / `SqlMessageStorage` gate `deliverAt` on `Clock`. | `TestClock.adjust` | delegated |
| 76 | Faults | `crash({ at, command, times })` (hook dies; EntityManager in-memory restart; the harness advances the TestClock through the defect retry delay so the call need not be forked), `pause({ at, command })` → `{ reached, release }` (hook parks; pair with `cluster.kill` for runner death mid-turn, recovered from storage by the survivor), `staleGeneration`, `holdLock` (Postgres only, `UnsupportedOnPglite`), `redeliver(commandId)`, `chaos({ probability, at, seed })`. | These are the exactly-once cases: committed-but-reply-lost must replay the receipt; before-commit must apply once; stale generation is a defect; runner death must recover from `cluster_messages`. | `TurnHooks`, `actor_generations`, `cluster_messages` | delegated; gated (clock advance from the hook; pause + kill) |
| 77 | Multi-runner | `runners: n` → n `Sharding` instances, each with its own `MessageStorage.makeEncoded` wrapper over the shared SQL backend (`unregisterShardReplyHandlers` drops every listener of a shard in a wrapper, so sharing one wrapper would let a dying runner interrupt another runner's callers), a harness `RunnerStorage` (per-address shard ownership, expiry on Effect `Clock`, and `kill` makes it drop the dead address's `unregister`/`release` since closing a Sharding scope is a graceful exit) and an in-process `Runners.make` bus, `simulateRemoteSerialization: true`; the test fiber's `Actors` is a client-only `Sharding` (`runnerAddress: None`); `cluster.kill / start / isolate / runnerOf`. | Rebalance without double apply is testable in one process. Stock storages do not fit: `RunnerStorage.layerMemory.acquire` grants every shard to any caller; `SqlRunnerStorage` expiry reads database `now()`, not the TestClock. | `Runners.make`, `RunnerStorage.of`, `MessageStorage.makeEncoded`, `Sharding.layer` | delegated; gated |
| 78 | Model-based tests | `Scripts.arbitrary(actor, { steps, duplicateCommandIds, commands })` from the commands' input schemas; `Model<A, S>` (`initial`, `step`, `observe`) and `test.check(actor, id, model, script, { concurrency })` → `ModelMismatch`; runs under `it.effect.prop`. Effect's own `Arbitrary`, no fast-check. | Random scripts + `chaos` + concurrency against a sequential model is the strongest exactly-once check available. | `effect/unstable/arbitrary`, `it.effect.prop` | delegated |
| 79 | SDK tests | `test.serve({ actors, auth })` → Promise client and `HttpClient` over `HttpServer.layerTestClient`; thrown errors are the contract's `Schema.TaggedError` instances. | The Rpc serialization and `Actor.auth` middleware run, no port. | `HttpServer.layerTestClient` | delegated |
| 80 | Conformance | `conformance: ReadonlyArray<ConformanceCase>` (`requires: "any" \| "postgres"`) + `describeConformance(it)`; one file runs it on PGlite, `TEST_PG_URL` and `TEST_NEKI_URL` with `it.effect.skipIf`. | Decision 66's "Neki supported" is this suite passing. | `it.effect.skipIf` | delegated |
| 81 | Default caller | `Anonymous` unless `ActorTest.layer({ caller })`; `Actor.as` per call. | Authorization failures stay visible in tests. | `CurrentCaller` | superseded by 120 |
| 82 | Storage in tests | The production `SqlMessageStorage` on the test `SqlClient` (PGlite or url), never `MessageStorage.layerMemory` / `TestRunner.layer`. | `MemoryDriver.saveEnvelope` writes immediately (verified), so a turn that rolls back would leave its intents deliverable and decision 46 (intents in the turn transaction) could not be tested. `SqlMessageStorage` takes `now` from the Effect `Clock`, so timers stay TestClock-driven. | `SqlMessageStorage.layer` | delegated |

### Testing surface, open questions closed (round 4, "you pick")

Owner delegated the six questions left open after the Oracle review. Each row is my pick; veto by editing the row.

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 83 | Effects default | `effects: "hold"` is the `ActorTest.layer` default; `effects: "run"` is a per-layer opt-in for integration-style tests that want executors to run as they would in production (still on the TestClock, still overridable). | A held outbox keeps model calls and email out of every happy-path test and makes retry → dead letter → `onEffectFailed` a sequence of explicit steps. Tests that want the executor loop say so once per `it.layer` block. | outbox rows, `EffectsHarness.run/drain` | settled (my pick) |
| 84 | Handler-only harness | None. Decision 69 stands: there is exactly one test path, the real `turn()` on PGlite. No `Actor.testHandler(...)` or fake `ctx` factory. | Two paths would let handler tests pass what the transaction rejects (fencing, receipts, outbox order). PGlite start-up is the price and it is paid once per `it.layer` block. | `ActorTest.layer` | settled (my pick) |
| 85 | Tenant isolation | One tenant per `ActorTest.layer` build (one per `it.layer` block). Tests in a block use distinct actor ids; `test.reset` deletes that tenant's rows in every framework and business table when a test needs a clean slate. There is no per-test tenant. | Per-test tenants would need the layer rebuilt per test or a mutable `CurrentTenant`; both leak into the harness. Distinct ids are free and `reset` is explicit. | `Actor.tenant`, `Database` | settled (my pick) |
| 86 | Defect retry in tests | `faults.crash` advances the `TestClock` through the EntityManager's defect retry delay itself, so the actor's `Defects.retry` schedule stays under test and the calling fiber need not be forked. No `defectRetry: "immediate"` option on `ActorTest.layer`. | The retry schedule is production behaviour (decision 56); a test that skips it cannot catch a policy that never retries. The harness advancing the clock from inside the hook is gate "Crash points". | `TurnHooks`, `TestClock.adjust`, `Schedule` | settled (my pick); gated |
| 87 | Names | Keep `ActorTest`, `test.faults.pause`, `describeConformance`, `Scripts.arbitrary`, `TurnHooks`. | Each name matches the noun it acts on; renaming now buys nothing. | | settled (my pick) |
| 88 | `TurnHooks` visibility | Sealed to `durable-actors/testing`: `TurnHooks` / `TurnReport` / `TurnHooksShape` are defined in the framework module but re-exported only by the testing subpath, never by the public `durable-actors` entry. Production observability is spans, metrics and `actor_events`. Re-open if an audit-log use case appears that the events table does not cover. | A public hook that can roll back a COMMIT by dying is a foot-gun outside tests; keeping it off the main surface preserves "one seam, test-only". | `Context.Reference` | settled (my pick) |

## 3. Round 5 — DX/AX and closing the gaps (89–134)

The owner picked option **a** for all 46 rows below. The full reasoning, alternatives and code live in
[DX.md](DX.md) §2, §6 and §7, and the typechecked embodiment is [framework/Actor.ts](framework/Actor.ts).

### Caller and tenant

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 89 | Where the caller binds | a — the caller is captured at `get` (both ambient `Actor.as` and explicit `get(id, { as })`); `get` requires `Actors \| CurrentCaller` and handle methods have `R = never`. | Attribution cannot be forgotten because a handle without a caller cannot exist. | `Context.Service` (`CurrentCaller`) | settled |
| 90 | Tenant derivation | a — `Actor.layer({ tenant: (principal) => principal.orgId })` derives the tenant once; `get(id, { tenant })` and `Actor.tenant` stay as overrides. | One place decides tenancy instead of every call site. | `Context.Reference` | settled |
| 91 | System callers | a — `System { source, ref?, onBehalfOf: Option<Principal> }` propagated into intents, timers, cron, workflow starts and executors, plus `ctx.principal: Option<Principal>`. | A timer armed by a user still knows whom it acts for. | `Context.Service` (`CurrentCaller`) | settled |
| 92 | Auth on `serve` | a — `auth` is required on `Actor.serve`; `Actor.auth.none` is the explicit public opt-out, with `Actor.auth.bearer/header` helpers. | Forgetting auth must not serve every actor to anyone. | `RpcMiddleware.Service` | settled |
| 93 | Service ids | a — service keys match export names: `"durable-actors/CurrentCaller"`. | Effect prints the key in error output, so it should name the export. | `Context.Service` | settled |
| 94 | `id` on `Actor.make` | a — `id` is required (no `Schema.String` default); `id: Schema.String` stays allowed but must be written. | The silent default opted out of branded ids (decision 6). | `Schema.brand` | superseded by 164 (no `id` ⇒ minted `${Name}Id`; branded ids kept) |

### Contract

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 95 | Internal commands | a — `internal: [...]` on `Actor.make`; internal commands exist on `ctx.self`, `ctx.actors`, workflow handles and `EffectContext.self` but are absent from `Handle`, the Promise client, HTTP and `Actor.toolkit`, and a non-System caller is a defect. | A browser must not be able to forge an effect-executor result. | `Rpc.make` (type-level `Exclude`) | settled |
| 96 | Descriptions | a — optional `description` on actors, commands, queries, streams and workflows; `Actor.toolkit` is a type error when an included actor or non-internal command has none. | Tools without descriptions are the one thing every tool-use guide forbids. | `OpenApi.Description`, `Tool.make` | settled |
| 97 | Error schemas | a — `errors` must be yieldable tagged errors (`AnyError`); a declared error without `httpApiStatus` maps to 422. | `errors: [Schema.String]` compiles today and cannot be yielded. | `Schema.TaggedError` | settled |
| 98 | Policy targets | a — `Ps extends ReadonlyArray<Policy<Cs[number]>>`, so `Cron.every` / `Lifecycle.createdBy` can only name this actor's commands, plus a runtime uniqueness check on tags. | Mismatches move from runtime to compile time. | `RpcGroup.make` | settled |
| 99 | Event cursor option | a — `events(E, { after })` reading inclusive-exclusive as intended, and the stream has `R = never` (no `Scope`). | `from` read ambiguously and rc.116 streams own their scope. | `Stream.fromPubSub` | settled |
| 100 | `ActorRef` | a — `ActorRef = { actor, tenant, id }` as a `Schema.Class` exposed as `handle.ref` / `ctx.ref`; Cluster's `EntityAddress` stays internal. | User code should never import `effect/unstable/cluster`. | `Schema.Class` | settled |
| 101 | `Policy` namespace | a — add a `Policy = { Hibernate, Mailbox, Defects, Delivery, Effects, Commands, Receipts, Events, Cron, Lifecycle }` re-export and list it in `llms.txt`; individual exports kept. | An agent typing `Actor.` cannot otherwise find ten top-level policy modules. | — | settled |
| 102 | Query layer name | a — `X.toQueryLayer(...)`, freeing the contract field name `queries` to mean the same thing on the definition as on `Actor.make`. | Every other builder is `toLayer`; consistency across the ladder. | `Layer` | settled |

### Handler contexts

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 103 | Read-only contexts | a — `ScopedRead<T>` (select only) on `QueryContext`, `StreamContext` and `WakeContext`; `Scoped<T>` with writes only on `CommandContext`. | A write outside the fence should fail to compile, not run. | drizzle query builder | settled |
| 104 | `ctx.rows` sugar | a — the pre-scoped builder gains `one / all / insert / upsert`; `ctx.db` stays the escape hatch for joins. | The four calls every handler makes stop being hand-written. | drizzle | settled |

### Errors

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 105 | Framework error payloads | a — every framework error is a `Schema.TaggedError` with `httpApiStatus`, `ref`, `command`, literal-union `reason`, `retryAfter` where applicable, a `retryable` property and an `override get message()` saying what to do next. | Agents and humans get the next step instead of a bare tag. | `Schema.TaggedError` | settled |
| 106 | Boundary errors | a — `InvalidInput` (400) and `TransportError` exist only on the HTTP boundary and the Promise client, never in the Effect handle's `E`. | The Effect handle's inputs are typed and its failures are already `ActorUnavailable`. | `Schema.TaggedError` | settled |
| 107 | Request id | a — the HTTP layer echoes the commandId as `x-request-id`; `TransportError.requestId` and the errors' `commandId` are the same searchable string. | One id links client error, server log and receipt. | `HttpApi` | settled |

### Server file

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 108 | Executor signature | a — effect executors take `(ctx, effect)`. | One argument order across every handler in the framework. | `Entity.toLayer` | settled |
| 109 | Server-side key name | a — the server file's `lifecycle:` becomes `hooks:`; the contract keeps `lifecycle:` for serializable policies. | The same key meant two different things (data vs code). | `Entity.toLayer` | settled |
| 110 | Request/reply in a turn | a — `InsideTurn<R>` turns a request/reply inside a handler into a literal-string type error naming `ctx.actors.get(Other, id).Command.send(...)`. | Decisions 12/13 gain a readable message instead of "not assignable". | — | settled |
| 111 | `Actors` surface | a — `Actors` is `{ get, deadLetters }`; `sharding / database / engine` move to a non-public `ActorRuntime`. | Users never need Cluster's `Sharding`. | `Context.Service` | settled |
| 112 | Spans and logs | a — `turn()`, executors and queries wrap handlers in `Effect.withSpan("durable-actors/turn", …)` and `Effect.annotateLogs`; `Actor.make({ spanAttributes })` passes through. | Handlers stop interpolating ids into log strings. | `Effect.withSpan` | settled |

### Clients

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 113 | Who mints the commandId | a — the handle method mints a UUID inside `Effect.suspend` when it runs and the `Delivery.retry` loop reuses it; the Promise client does the same and sends `x-command-id`; `turn()` never generates. | Server-generated ids make a post-commit resend a new envelope, applying the command twice. | `Effect.suspend`, receipts | settled |
| 114 | Promise client options | a — `X.client({ baseUrl, headers, timeoutInMs, fetch })` with a trailing `{ commandId, signal }` options bag per call and `AsyncIterable` events. | Azure-style options-last, abortable calls, consistent across the ladder. | `RpcClient` | settled |
| 115 | Toolkits and MCP | a — `Actor.toolkit([...], { maxOutputBytes })` producing namespaced tools with `failureMode: "return"`, and `Actor.mcp({ actors, name, version })`; internal commands and streams excluded. | Agents get the actors as tools without forging internal commands or blowing the output budget. | `Toolkit.make`, `McpServer` | settled |
| 116 | Served documentation | a — `Actor.serve` also serves `/llms.txt`, `/openapi.json` and `/actors/{name}.md`, on by default with `docs: false` to disable. | Documentation an agent can fetch is part of the runtime surface. | `HttpApi`, `OpenApi` | settled |
| 117 | Deprecation | a — `deprecated: true` on a command, query or stream flows to `OpenApi.Deprecated`, the tool description prefix and an `llms.txt` section. | One flag drives every generated surface. | `OpenApi.Deprecated` | settled |
| 118 | Configuration | a — `Database.layer({ url: Redacted, … })` / `Database.layerConfig()` and `Topology.fromConfig()` read Effect configuration. | `url: string` prints secrets in error output. | `Config.Redacted` | settled |
| 119 | Workflow start | a — `W.start(input)` returns a `WorkflowRun<Out, Err>` handle (`id`, `result`, `poll`, `interrupt`) and `W.run(id)` rehydrates one. | Long-running operations return a poller, not a bare string. | `WorkflowEngine.poll / interrupt / resume` | settled |

### Testing

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 120 | Bound test harness | a — `ActorTest.layer({ as })` takes a `Principal \| Caller`, and `test.actor(Chat, id)` returns a bound `{ handle, ref, inspect, turns, next, effects, rows, crash, pause }`; the flat API stays. | Tests stop repeating `(Chat, id)` and hand-spelling the caller union. | `ActorTest.layer` | settled |

### Documentation for agents

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 121 | Agent docs shipped | a — `packages/durable-actors/llms.txt`, an AGENTS.md block with runnable `tsc` / `bun test` commands, and `skills/building-durable-actors/SKILL.md` (≤ 500 lines, third-person). | The agent-facing entry points are artifacts, not prose in a README. | — | settled |
| 122 | Example snippets | a — every README snippet is one operation copied verbatim from a file under `examples/` that `bun test` runs against PGlite. | Copy-pasteable examples must be tested examples. | `it.layer` (PGlite) | settled |
| 123 | JSDoc | a — `@since` / `@category` on every export, categories `constructors \| contexts \| policies \| errors \| clients \| testing`. | Generated docs and `llms.txt` sections come from one source. | — | settled |
| 124 | Kept after review | a — no change to `(ctx, input)` order, `X.of(handlers, { hooks, effects })`, declared `errors`, the `Actor.commandId` pipe, `Turn`, `Hibernate.after`, the separate `commands / queries / streams` arrays, `test.faults.*` names and sealed `TurnHooks`. | Reviewed and deliberately unchanged. | — | settled |

### Closing the gaps against Rivet / DO (125–131)

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 125 | Keyed state | a — `state: { key: Schema }` stored in `actor_state(tenant_id, actor_id, actor, key, value jsonb)`, loaded after the generation fence in the turn transaction, synchronous reads, `ctx.state.set` writes dirty keys at commit, read-only snapshots elsewhere, `State.maxBytes("64 KiB")`. | Supersedes the "no state blob" half of 9a: a small keyed store next to the tables, as Rivet and DO both ended up needing. | `Schema`, `SqlClient.withTransaction` | settled |
| 126 | Connections | a — `Actor.connection(name, { params, server, client, state, errors })` as a fourth contract kind, with `ctx.connections.broadcast/list`, WebSocket transport and frames forked past the mailbox. | Closes the DO/Rivet realtime-session gap with the same typed contracts. | `RpcServer.layerProtocolWebsocket`, `Rpc.fork` | settled |
| 127 | `run` loop | a — `X.of(handlers, { run })`: a long-lived activation loop started on wake and interrupted on sleep, with `events`, `state`, `self`/`actors` intents, `connections` and `memory`, but no transaction. | Rivet's `run` loop without breaking the one-transaction-per-turn rule. | `Entity.toLayer(Effect)`, `Stream` | settled |
| 128 | Placement | a — `Actor.layer({ shardGroup: (tenant) => … })` is first-class, with runners selecting groups via `ACTORS_SHARD_GROUPS`. | Compute follows the tenant even though data placement stays single-database. | `ClusterSchema.ShardGroup`, `ShardingConfig.shardGroups` | settled |
| 129 | Timer precision | a — `pollInterval: "1 second"` default, an in-memory sleep-then-`pollStorage` on the runner that wrote a `deliverAt` intent, and `NOTIFY actor_wake` after COMMIT for cross-runner intents (Postgres; a gate on Neki). | `ctx.self.Reset.after("5 seconds")` must not fire at 15 s. | `Sharding.pollStorage` | settled |
| 130 | Client reach | a — SSE at `GET /actors/{name}/{id}/events?after=`, `/openapi.json` for generated clients in other languages, and a `durable-actors/react` subpath (`useActor`, `useQuery`, `useConnection`). | Every language reaches actors without a hand-written client. | `HttpApi`, `OpenApi` | settled |
| 131 | Blobs | a — `Actor.blob("doc")` / `blobs: [doc]` over `actor_blobs(tenant_id, actor_id, key, seq, data bytea)`, lazy `get/set/append/compact`, streamed over HTTP, exempt from `State.maxBytes`. | Large per-actor binaries (CRDT logs, embeddings) do not belong in keyed state. | `Schema.Uint8Array`, `HttpApi` | settled |

### Kinds, members, runtime (132–134)

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 132 | Kinds | a — no `Actor.job`; add `Actor.singleton(name, { description, shardGroup })` alongside `make`, `workflow` and `cron`. | A job is already a one-activity workflow; a cluster-wide leader/poller is the missing kind. | `Singleton.make` | settled |
| 133 | Ephemeral actors | a — `Actor.ephemeral(name, { id, memory, commands, connections, lifecycle })`: same contract members, no state/tables/events/effects/receipts, `ctx.memory` only, durability policies rejected at the type level. | A kind that changes `E`, `ctx` and allowed policies deserves a constructor, not a `durable: false` flag. | `Entity` (`Persisted: false`) | settled |
| 134 | Visible levels | a — `@category kinds \| members \| policies \| runtime \| clients \| testing` JSDoc, `_kind` tags on kinds and members, and a type error when a member is passed to `Actor.serve` / `Actor.toolkit`. | The three levels under `Actor.` become discoverable without renaming anything. | — | settled |

**Embodiment status (2026-09-21).** [framework/Actor.ts](framework/Actor.ts), [framework/Testing.ts](framework/Testing.ts),
every `example/*.ts`, every `example/*.test.ts` and [typecheck.ts](typecheck.ts) embody 89–172 and typecheck with zero
errors (`bunx tsc --noEmit -p research/v4/tsconfig.json`). Rows marked *superseded* above were replaced by §3.6.

## 3.5. Round 6 — what is not an actor, not the framework, not one package (135–150)

Owner asked for an Oracle pass on "what shouldn't be an actor, what shouldn't be in the framework, what to extract",
reacting to a proposed `@rika/durable` split (actors / events `Topic` / workflows / runtime / testing). Full reasoning
and code in [PACKAGES.md](PACKAGES.md). Rows are my picks adopting the Oracle's verdicts; `settled (my pick)` rows are
already applied in [framework/Actor.ts](framework/Actor.ts), `proposed` rows await the owner's veto/ack.

### Primitives

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 135 | Primitive taxonomy | Two primitives, `Actor` and `Workflow`; `cron` and `singleton` are runtime facilities under `Durable`. Additive aliases `Workflow.make`, `Durable.cron`, `Durable.singleton`, `Durable.as/tenant/commandId`; `Actor.workflow/cron/singleton` stay (decision 30 names are kept). New docs and the skill use the new spellings. | A workflow has identity and a mailbox (`ClusterWorkflowEngine` runs it on an Entity, `concurrency: 2`, verified) but no open-ended command API; cron/singleton are scheduling and leadership, not identity + serialized mutation. Renaming nothing avoids a migration campaign. | `Workflow.make`, `ClusterCron.make`, `Singleton.make` | superseded by 157–158 (one kind, workflows as members; no `Durable` / `Workflow` namespaces) |
| 136 | Off-turn contexts are read-only | `WakeContext` (`onWake`/`onSleep`) and `RunContext` see `BlobRead`, read-only rows and the committed `state` snapshot, and gain `self` so they can *schedule* work. Maintenance that writes (compaction, backfills) is an `internal` command the actor sends itself. Doc compacts via `Compact` every 100 updates and on cold start. | Wake has no transaction (F3); a writable `BlobHandle` there was a hole. | `IntentHandle` | settled (my pick) |
| 137 | `Topic` / durable-events | Deferred. Cross-actor fan-out is a projection actor fed by explicit intents; a replaying consumer commits its checkpoint with the derived state in one turn. If built later: bounded v1 spec in PACKAGES.md §5 (fixed partitions, append-order offsets under a partition lock, at-least-once, fenced consumer per (group, partition), retention-gap errors, obligation in the source shard on Neki), sized XL. | On one Postgres a topic is a broker subsystem (offsets, groups, rebalance, retention, poison policy), not a wrapper; `effect/unstable/eventlog` is a local-first client journal, not a partitioned log (verified); no example needs it. "Committing a publish intent is not committing the append" must be named when it exists. | — | proposed |
| 138 | Verbs inside a turn | Keep the distinct set: `ctx.emit`, `ctx.self.X.send/after/at` + `ctx.actors.get(A, id).X.send`, `ctx.workflows.start/cancel`, `ctx.perform`. `ctx.connections.broadcast` is documented best-effort (not transactional). No `ctx.publish` until 137 is built; no universal `dispatch`. | Each verb has a different recovery rule; one verb would lose types and readability. | — | settled (my pick) |

### Packaging and boundaries

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 139 | Distribution | One npm distribution with lockstep subpaths (refines 61): `.` (browser-safe `Actor`, `Workflow`, `Durable`, policies, identity, boundary errors), `/identity`, `/actors`, `/actors/server`, `/workflows`, `/workflows/server`, `/runtime`, `/pg`, `/http`, `/ai`, `/client`, `/admin`, `/testing`, `/server`. Not five release trains. Absent from v1: `/events`, `/react`, `Topology.k8s`, S3 APIs. | Independent versions of shared services/schemas (`Caller`, workflow targets) create incompatible identities; the browser rule (never pull `effect/unstable/sql`) is the boundary that matters, not directory count. | package `exports` | superseded by 151 (four subpaths) |
| 140 | Type ownership | `/identity`: `TenantId`, `Tenant`, `DeploymentId`, `Principal` (the one augmentation target), `Caller`, `CurrentCaller`, `ActorRef`. `/actors`: `CommandId`, `CommandConflict`, `NotCreated`, `ActorUnavailable`, `Turn`, contexts, policies. `/workflows`: `ExecutionId`, `WorkflowRun`, `WorkflowInterrupted`. `/pg`: `Database`. `/runtime`: `Topology`, `RuntimeControl`. `/http`: `Auth`. root: `Unauthorized`, `InvalidInput`. `/client`: `TransportError`. `/testing` only: `TurnHooks`, `TurnReport`, activity fault hooks. | `Caller.System` references `ActorRef`, so the ref is identity; errors that mention receipts stay with actors. | — | superseded by 151 (types live on the root entry; `/runtime`, `/client`, `/testing` only) |
| 141 | Runtime boundary | `DurableRuntime.layer({ deployment, principal, tenant?, topology, shardGroup?, shardGroups?, pollInterval? })` requiring exactly one `Database`; `Actor.layer` forwards to it. No `objectStorage`, `auth`, executor bag or migration callbacks in the options. `Actor.layer({ deployment })` added now as `DeploymentId` (default `"default"`). | Runtime owns placement, transport, identity configuration, lifecycle; actor/workflow backends own their semantics; auth belongs to the edge. | `Sharding`, `WorkflowEngine` | superseded by 155 (`Actor.layer` is the runtime; no `DurableRuntime`); `deployment` kept |
| 142 | Cut or move | Move: `serve`/`auth` → `/http`; `toolkit`/`mcp` → `/ai`; `Actors.deadLetters` → `/admin` (`ActorAdmin`); Promise client impl → `/client`. Delete from v1: `framework/React.ts`, `Topology.k8s`. Keep core: `blob` (writes in turns only), `connection` contract, `Lifecycle.createdBy`, `ctx.terminate` (specified: transition + declared-data cleanup, not receipt deletion, not compensation, not history erasure), `State.maxBytes`. Narrow the barrel: `ServeTypeId`, `Serve`, `Hook`, `InsideTurn`, `InActorTurn`, `RpcsOf`, `HandlersFor`, drizzle placeholders, `X.entity` off the root. | The differentiator is contracts → attribution → fenced turns → durable consequences → faithful tests; adapters make it reachable. | — | superseded by 151/153 (`serve`/`auth` stay on the root; toolkit/MCP deleted; `deadLetters` stays on `Actors`); the React deletion and `Topology.k8s` removal were applied |
| 143 | Testing across primitives | One environment: `ActorTest` re-exported as `DurableTest`; `test.actor(A, id)` (120), `test.workflow(W).crashActivity(name, { at: "beforeBody" \| "afterBodyBeforeResult" \| "afterResult", times })`; a future topic harness says `pauseConsumption`, not `pause`. `Effect.die` inside an activity body is not process loss (the engine may record it as a result); pause + `cluster.kill` is the stronger test. | `TurnHooks` is actor-specific; workflows need their own seam at the body/result boundary. | `TurnHooks`, activity boundary hook | proposed |
| 144 | Workflow identity | The persisted payload is the app input plus `__deployment`, `__tenant`, `__onBehalfOf`; the execution key is `JSON.stringify([deployment, tenant, appKey])`; a resumed run rebuilds tenant and caller from the envelope, never from ambient defaults. `waitFor` needs an actor-side registration acknowledgement so an event emitted before the registration lands is not lost (integration module owns the race and its test). | Effect derives the execution id from (name, key) only (verified); two tenants with the same app key must not share a run. | `Workflow.make({ idempotencyKey })` | settled (my pick; ack + isolation test pending) |
| 145 | Caller for tools and MCP | The caller is a per-call dependency (`Tool.make({ dependencies: [Actors, CurrentCaller] })`, verified in rc.116); `Actor.toolkit(...).layer` requires only `Actors`. `Actor.mcp` takes `transport: { _tag: "http", path, auth: Auth<R> } \| { _tag: "stdio", as }` and returns `Layer<never, never, Actors \| R>`; the HTTP bridge (provide `CurrentCaller` per invocation from the request) is ours because `McpRequestContext` carries no headers. Caller-supplied MCP metadata is never a principal. The `Layer.succeed(CurrentCaller, anonymous)` workaround is removed from `server.ts`. | A layer-level caller is a per-request value frozen at boot: an authentication bug. | `Tool.make`, `McpServer.registerToolkit` | superseded by 153 (no toolkit / MCP in the framework); the per-call caller rule survives as 154 |
| 146 | Turn boundary at runtime | `InActorTurn` (`Context.Reference<boolean>`, internal) is set by `turn()` around the handler; every outside operation (`X.get`, handle methods, `Actors.get`, `W.start`) is wrapped in `outsideTurn`, which dies when inside. `InsideTurn<R>` stays as the readable type diagnostic. | The type check sees requirements only; a handle bound before the turn has `R = never` and could make request/reply calls inside a transaction. | `Context.Reference` | settled (my pick) |
| 147 | Hosting boundary | Host deployments first, tenants inside a deployment. `DeploymentId` is stable and never a code version. Runtime exposes: a manifest of contracts + required migrations (reject incompatible runners at start), `RuntimeControl { ready, status, drain }`, configuration without ambient globals, edge-owned auth where a tenant override is routing not authorization, operator capability in `/admin`. A deployment artifact is `{ contracts: { actors, workflows }, registrations }`. Managed and bring-your-own runners share this contract. | `tenant_id`/`shardGroup` are placement, not a sandbox: handlers have `ctx.db`. Cluster shard groups (compute) and Neki shard groups (data) are different. | — | proposed |
| 148 | Connection frames | Mixed-frame connections declare `Schema.TaggedClass` frames (`MessageFrame \| Typing`); a single-frame connection may stay a plain class. | Plain classes cannot be discriminated on `_tag`. | `Schema.TaggedClass` | settled (my pick) |
| 149 | `E = never` on `run`/singleton | Keep the requirement; reject a blanket `catchCause` and any `X.onRun` helper. Expected failures are handled by name; a defect restarts the activation/singleton. | A swallowed failure turns a dead loop into a "completed" worker. | — | settled (my pick) |
| 150 | Typed tools | `Actor.toolkit` must preserve each tool's parameter, success, error and requirement types (today the map is `Tool.Any`). | Erased tool types defeat the "agents get the contracts" story (115). | `Tool.Tool<Name, Config, Actors \| CurrentCaller>` | superseded by 153 (no toolkit) |

## 3.6. Round 7 — one kind, workflows as members, no AI surface, Rivet borrowings (151–172)

Owner's answers in this round, in order: package names carry no `rika`; everything binds to the actor ("a full actor
framework, not a workflow framework"); nothing AI-specific ships; `Actor.as` piping is bad DX; one database per
deployment with tenants inside; one `Actor.make` with ephemeral/workflow/cron expressed differently; no `durable`
flag; workflows as members; ids minted by default with the option to declare your own; steal the nice parts of
Rivet's Effect SDK. Code: [framework/Actor.ts](framework/Actor.ts), [framework/Testing.ts](framework/Testing.ts),
[example/CodingAgent.ts](example/CodingAgent.ts) + [CodingAgent.server.ts](example/CodingAgent.server.ts) +
[CodingAgent.test.ts](example/CodingAgent.test.ts) (every member kind in one actor). Comparison:
[COMPARISON.md](COMPARISON.md).

### Naming, packaging, scope

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 151 | Package | `durable-actors`, one distribution, four subpaths: `.` (`Actor`, policies, errors, identity, `Actors`, `Actor.serve`, `Actor.auth`), `/runtime` (`Actor.layer`, `Topology`, `Database`, migrations), `/client` (browser-safe Promise client), `/testing` (`ActorTest`). Supersedes 61, 139–142. | The owner's boundary is "the browser never pulls `effect/unstable/sql`"; four entries express that, thirteen do not. No `@rika` anywhere in code or docs. | package `exports` | settled |
| 152 | Rivet borrowings | From `@rivetkit/effect` 2.3.17 (verified): `vars` (typed per-activation variables), the `run` loop, `conn.state` (per-connection state that survives hibernation), `ctx.self.X.after/at` as the schedule API, and `ActorError.reason` + `Effect.catchReasons` (Rivet's `RivetError { reason }` shape). Not borrowed: `X.toLayer(wake, { state: { schema, initialValue } })` (our state is transactional, not interval-saved), raw Promise `db`, `Registry`. | Rivet's per-activation ergonomics are good and cost nothing; its state model (1 s save interval) contradicts F3. | `Entity.toLayer(Effect)`, `Effect.catchReasons` | settled |
| 153 | No AI surface | Deleted `Actor.toolkit`, `Actor.mcp`, `/ai`, `llms.txt`, `docs:` on `serve`, `example/agent.ts`, `framework/React.ts`. The framework ships primitives that make agents easy to build on (contracts, receipts, events with a cursor, effects with dead letters, workflows with `waitFor`, connections); `/openapi.json` is what tool generators consume. `CodingAgent` is the reference for "an agent is an actor". Supersedes 115–117, 121, 145, 150. | Owner: "the primitives we ship should just make it easy to build AI on top". | `OpenApi` | settled |

### Caller, tenancy, running it

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 154 | Ambient caller | `CurrentCaller` is a `Context.Reference` with default `Anonymous` (was a `Context.Service`). It is set once at the edge (the `Actor.serve` auth middleware per request, `ActorTest.layer({ as })` per test, `Actor.as(p)` around a script) and read at `X.get`; `X.get(id, { as })` binds per handle. No handle method carries `CurrentCaller` in `R`; nothing is piped per call. Refines 36, 89. Inside turns and workflows `ctx.caller` / `ctx.principal` are the attribution. | Owner: "shouldn't the actor know by default its principal?". A Reference makes the caller ambient without an unbound-handle state. | `Context.Reference` | settled |
| 155 | Ways to run | `Actor.layer({ principal, topology, tenant?, shardGroup?, deployment?, pollInterval? })` is the runtime, one per process; three ways to run: **embedded** (that layer inside your app, call actors as Effects), **served** (`Actor.serve({ actors, auth, openapi?, path? })` in its own process: HTTP + WebSocket + SSE + OpenAPI), **hosted** (the same layer, our runners and Neki). `serve` is optional: it exists for other languages, browsers and the hosted product, not because Effect callers need it. Supersedes 141. | Owner: "why are we providing a server?". | `Layer`, `HttpRouter`, `RpcServer` | settled |
| 156 | Tenancy | One database per deployment; tenants are rows (`tenant_id` on every framework and business table, composite indexes, optional RLS policies per table). Not one database per tenant: cross-tenant workflows, singletons and cron would need cross-database transactions, migrations would multiply per tenant, and Neki already shards by `tenant_id`. Dedicated placement is `shardGroup` (compute) and Neki shard placement (data), not a separate database. Neki intents: see the amendment to 46 (`actor_outbox` relay). | Owner asked for per-tenant databases for isolation; isolation is enforced by the fence + `tenant_id` + RLS, placement by shard groups. | `tenant_id`, RLS, `ClusterSchema.ShardGroup` | settled (interpreted) |

### One kind, members

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 157 | One kind | Only `Actor.make`. No `Actor.ephemeral`, `Actor.cron`, `Actor.singleton`, `Actor.job`, no `Durable.*`, no `Workflow.make`. Durability is what you declare: an actor with no `state`, `tables`, `events`, `effects` or `blobs` touches none of those rows (its commands are still fenced, receipted turns). `singleton: true` on `Actor.make` gives `X.get()` with no id, cluster-wide `Cron.every` and `run` (via `Sharding.registerSingleton`). Cron is the `Cron.every(expr, Cmd, { skipIfOlderThan })` lifecycle policy on a zero-input command of the same actor. Supersedes 132, 133, 135. | Owner: "one Actor.make and think of doing workflow, cron differently"; "we don't need a durable flag, people can just not use the DB". | `Entity.toLayer`, `Singleton`, `DeliverAt` | settled |
| 158 | Workflows as members | `Actor.workflow(tag, { description, input: fields, output, errors })` listed in `workflows: [..]`; the body lives in `X.toLayer` next to the command handlers as `(ctx, input)`. Outside: `x.Ship.start(input, { key })` → `WorkflowRun { id, key, result, poll, interrupt }`, `x.Ship.run(key)` rehydrates. Inside a turn: intents `ctx.self.Ship.start(input)` / `.cancel()`. `WorkflowContext { executionId, key, principal, owner: WorkflowHandle, actors, activity(name, { output, errors, run, retry }), sleep, waitFor(Event, { where, timeout }) }`. Execution key = `[deployment, tenant, actor, id, workflow, key]` (refines 144). Supersedes 119's standalone `W.start`, 135. | Owner: "Actor.workflow I liked, please bind everything to Actors". A workflow owned by an actor has an obvious identity, tenant and caller. | `Workflow.make`, `Activity`, `DurableDeferred` | settled |
| 159 | Server options | `X.toLayer(handlers, { hooks, effects, run, shardGroup, spanAttributes })`; `shardGroup` per actor overrides `Actor.layer({ shardGroup })`. Refines 109, 128. | Placement and tracing attributes are server-side code, not contract. | `Entity.toLayer` | settled |
| 160 | `vars` | `vars: { host: Schema.OptionFromOptionalKey(Schema.String) }` on `Actor.make`: typed per-activation variables with `ctx.vars.x`, `ctx.vars.set`, `ctx.vars.update`, present on every context, dropped on hibernation, never persisted. Replaces the closure-only answer of 51 and the `ctx.memory` name (owner: "sounds like agent memory"). | Rivet's `vars`, typed. | `Ref` in the activation scope | settled |
| 161 | `onDefect` | `X.onDefect((ctx, command, cause) => …)` in `hooks`: runs after a deterministic defect (state over `State.maxBytes`, a decode failure, an internal command from a non-System caller) with a read-only `WakeContext`; the turn rolled back, the caller got a `Die`, the actor stays resident. Not for F4's retryable defects, which restart the activation. | The two defect kinds have different recovery; only one deserves a hook. | `Cause` | settled |
| 162 | State migrations | `migrations: [Actor.migration(StateV1, StateV2, upcast)]` with `state: StateV2.fields`; the chain is validated at `make` (each `to` is the next `from`, the last `to` is the declared state); a turn decodes the stored row through the chain before the handler and writes the current shape on commit; tables migrate with drizzle-kit as before (33). | Owner: "how do we migrate?". Keyed state needs a code-level upcast; tables have SQL migrations. | `Schema.decode`, `actor_state` | settled |
| 163 | Connections and hibernation | `Actor.connection(tag, { params?, server, client?, state?, errors? })`; policies `Connections.park` (default: the activation hibernates while sockets stay open, an inbound frame or a broadcast wakes it) and `Connections.keepAwake`; `ctx.conn.state` (≤ 16 KiB, the DO `serializeAttachment` limit) and `ctx.conn.resumed` in the handler. Refines 126. | DO's WebSocket-hibernation semantics, typed. | `RpcServer.layerProtocolWebsocket`, `actor_connections` | settled |
| 164 | Id modes | No `id` on `Actor.make` ⇒ **minted**: `X.create()` returns a handle with a fresh UUIDv7, `X.id` is the branded schema `${Name}Id`, `Actors.mint(X)`; `id: Schema` ⇒ **named**: `X.get(id)`; `singleton: true` ⇒ `X.get()`. Nothing is written until the first turn. Supersedes 94; keeps 6 (branded). | Owner: "it should generate its own actor id, but give them the option". | `Crypto.randomUUIDv7`, `Schema.brand` | settled |
| 165 | `state.changes` | `ctx.state` outside a turn (streams, connections, `run`, wake hooks) is a `StateSnapshot` with `changes: Stream<State>` of committed snapshots. | A `run` loop that follows state (the CodingAgent's active turn) needs a stream, not polling. | `PubSub` | settled |
| 166 | `waitFor` scope | `ctx.waitFor(Event, { where, timeout })` in a workflow body waits for the **owner** actor's events only; other actors are reached through `ctx.actors` and their own events. Refines 56. | Owner-scoped registration removes the cross-actor race in 144. | `DurableDeferred` + owner intent | settled |
| 167 | One framework error | `ActorError { reason: ActorUnavailable \| MailboxFull \| Timeout \| CommandConflict \| NotCreated \| Unauthorized \| InvalidInput \| TransportError }` with `isRetryable`, `retryAfter`, `message` from the reason; handles are typed `ActorError.Of<R>` narrowed to the reasons a method can produce (`never` when none). Catch with `Effect.catchTag("ActorError", …)` or `Effect.catchReasons("ActorError", { NotCreated: … })`. **Caveat (verified in rc.116):** `catchReasons` without an `orElse` keeps the full `ActorError` in `E`; exhaustiveness per call site needs `orElse`. Declared errors are never wrapped. Refines 105. | Rivet's `RivetError { reason }` shape fits Effect 4's `HttpClientError` precedent; one tag to catch, typed reasons to branch on. | `Schema.TaggedError`, `Effect.catchReasons` | settled |
| 168 | Spans | Cluster RPC spans are `durable-actors.<Actor>/<Command>` (Effect RPC's naming) with `rpc.system.name`, `rpc.service`, `rpc.method` and the turn attributes of 63/112; trace context rides the envelope. | One naming scheme across Effect RPC and the turn. | `Effect.withSpan`, envelope headers | settled |
| 169 | `run` semantics | `run: (ctx) => Effect<void, never, R>` is sugar for a fiber forked in the activation `Scope` on wake and interrupted on sleep; `E = never` (149); with `Connections.park` it is interrupted when the activation parks and restarted on the next wake. | Nothing new underneath; the name says when it runs. | `Effect.forkScoped` | settled |
| 170 | Cron placement | `Cron.every` on a named/minted actor arms a per-actor timer (first turn, then re-armed after each run); on a `singleton: true` actor it is cluster-wide (one tick per deployment) through `Sharding.registerSingleton`. Refines 39. | The same policy reads the same on both; the runtime decides the mechanism from `mode`. | `DeliverAt`, `Singleton` | settled |
| 171 | `Members` | The contract bag is `commands, internal, queries, streams, connections, workflows, events, effects, tables, blobs, state, vars, migrations, lifecycle`; `ActorDefinition = Members & { _kind, name, description, mode, get, create, client, toLayer, toQueryLayer, of, ofQueries, onCreate, onWake, onSleep, onEffectFailed, onDefect, rpcs, entity }`. | One type the contexts, handles, executors and harness are derived from. | mapped types | settled |

### Testing additions this round

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 172 | Harness gaps closed | `ActorState.state: Option<StateOf<A>>` (decoded through `migrations`, never wakes the actor); `BoundActor.seed({ state, rows })` writes raw rows as an older deployment would (so a V1 state row can be seeded and the next turn must upcast it); `BoundActor.system: WorkflowHandle<A>` (the System-caller handle: internal commands reachable, for delivering `TurnDone`-style commands directly); `test.create(X)` for minted actors. Found by writing [CodingAgent.test.ts](example/CodingAgent.test.ts). | A migration that cannot be tested is not a feature; internal commands must be drivable without the executor that normally sends them. | `actor_state`, `WorkflowHandle` | settled (my pick) |

Decisions made on the owner's behalf in this round (veto by editing the row): the `Members` bag name (171); `Unauthorized.reason`
→ `code` (so `reason` means one thing framework-wide, 167); the Cursor example's `Positions` became a stream; singleton
residency (a singleton is resident on exactly one runner; `Hibernate.after` applies); the CodingAgent design (OpenCode
session created at sandbox start, `TurnDone.error` for failed turns, `Idle` timer key `"idle"` at 15 minutes, the run
loop following `state.changes`); structural `E2BSdk` / `OpenCodeSdk` types in `example/services.ts` instead of adding
`e2b` and `@opencode-ai/sdk` as dependencies; `ActorTest.layer({ as })` (renamed from `caller`); the `catchReasons` /
`orElse` caveat recorded rather than hidden.

## 3.7. Round 8 — repository structure (173–180)

The monorepo layout, adopted from the Whorl restructure contract. Normative text is
[docs/architecture/repository-structure.md](../../docs/architecture/repository-structure.md) and
[ADR 0001](../../docs/decisions/0001-repository-structure.md); these rows record the owner's answers.

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 173 | Tree | `apps/{api,console,edge,cli}`, `packages/{durable-actors,deployments,accounts,billing,email,contracts,observability,postgres}`, `examples/*`, `infra`, `tooling/{oxlint,structure,databases}`. The nine `export {}` runtime scaffolds, `apps/server` and `apps/worker` are gone; `auth → accounts`, `database → postgres`, `server → api`, `@project/* → @durable-actors/*`; the root package is `@durable-actors/monorepo` because the unscoped name is the framework's. | Decision 151's four entries need one package with folders, not thirteen packages. | Bun workspaces | settled |
| 174 | Runtime construction | `Actors.layer(...)` from `durable-actors/runtime`; no `Actor.layer` on the root. The `Actors` tag is what every `X.get` already requires, and the browser rule is a folder, not a tree-shaking promise. Earlier rows keep the `Actor.layer` spelling as history. | Owner answered "actors" to the `ActorRuntime.layer` / `Actor.layer` question. | `Layer` | settled (interpreted) |
| 175 | Actor files | Role folders: `<actor>/{contract,layer,queries}.ts` plus `workflows/` and `effects/` beside them; kebab-case everywhere. The research corpus's `Chat.ts` / `Chat.server.ts` stays as research. | Owner: "I like role folders". | — | settled |
| 176 | Examples | `examples/{counter,chat,coding-agent}` are workspace packages ported from `example/`; they are the end-to-end corpus, not documentation. | Owner: "yes do examples". | Bun workspaces | settled |
| 177 | CLI | `apps/cli` publishes `@durable-actors/cli` with bin `durable` (`durable login`, `durable dev`, `durable deploy`, `durable migrate`, `durable dead-letters`); no `bin` until the first command exists. | Owner picked `durable`; `actors` is taken on npm as a package name anyway. | `effect/unstable/cli` | settled |
| 178 | Control-plane actors | `packages/deployments` (`Deployment`, `Runners` singleton, `UsageMeter`) run embedded in `apps/api`; no `apps/worker`, no `apps/runner` (a managed runner is the customer's served container started by a `Deployment` effect). | Owner: "embedded in apps/api". | `Actors.layer` | settled |
| 179 | Test databases | `tooling/databases` owns disposable Postgres / Neki / PGlite; `tooling/structure` owns the tree checker and `src/exemptions.ts`. | Owner picked `tooling/databases` over Whorl's `tooling/testing` (would collide with `durable-actors/testing`). | — | settled |
| 180 | Exemptions | `packages/ui` stays a separate StyleX compile unit until `apps/console/src/build.ts` runs the transform; template `test/` directories stay until each package is rewritten on the framework; `research/` is outside the structure rules. Each is one row in `tooling/structure/src/exemptions.ts`. | A broken console build is worse than one listed exemption. | — | settled (my pick) |

## 3.8. Round 9 — scale and performance against Rivet and Durable Objects (181–192)

Owner's questions in this round: how Postgres-backed actors reach Rivet's claimed billions of actors; rough performance estimates against Rivet and Durable Objects; persist the changes that close the gaps; then "even more crazy things" to beat Rivet outright. Research: Rivet's source shows UniversalDB (Postgres or RocksDB in OSS, FoundationDB enterprise) as a central store, with its Postgres backend documented to about 1,000 concurrent actors; Neki is Platform Preview with no atomic cross-shard writes or shared cross-shard snapshots; PlanetScale commits wait for a replica in a second availability zone. Recorded in [ADR 0005](../../docs/decisions/0005-turn-latency-batching-and-regional-placement.md), [ADR 0006](../../docs/decisions/0006-scale-rules-placement-and-query-tiers.md), and [ADR 0011](../../docs/decisions/0011-direct-commands-outbox-and-performance.md).

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 181 | Scale target | Hot paths touch one shard and cost what is active, not what is stored; a billion stored actors fit one shard, a trillion needs about 100 shards plus a cold tier. | Rivet's "billions" are idle rows in partitioned storage; the same property holds on sharded Postgres. | Neki shard index | settled |
| 182 | Turn round trips | Two pipelined round trips per turn: admission (fence, receipt) and commit; decoded state cached per activation. | A turn of sequential statements pays one network hop per statement through the Neki router. | pipelined `SqlClient` | settled |
| 183 | Turn batches | Waiting commands for one actor share a transaction (cap 32, no added wait, per-command failure isolation). Refined by 187. | Hot-actor throughput is about 1 / commit latency without batching. | `Queue.takeBetween` | settled |
| 184 | Regions | Hosted tenants have a home region, each with its own database; F1 becomes one database per deployment region. | Remote users otherwise pay 50–150 ms per request. | tenant directory | settled |
| 185 | Placement | Per-type placement key (tenant default, actor, or parent); framework `routing_key` = XXH3-64 of a versioned encoding on every row. | Tenant-only placement caps a large tenant at one shard. | Neki `range` index | settled |
| 186 | Query tiers | Local (one actor), group (one placement key, one shard, one snapshot), fleet (explicit, eventually consistent). Refined by 190. | Scatter cost grows with shard count; Neki has no cross-shard snapshot. | — | settled |
| 187 | Pipelined batches | Batch N+1 runs in memory while batch N commits; nothing from a batch is visible before its commit. | Throughput bound moves from commit latency to handler CPU. | `Entity.toLayerQueue` | settled |
| 188 | Reducers | Pure `reduce` in the contract, optimistic in the browser, commutative merging with `combine`. Spelled in 196. | Zero perceived latency and a scalable hot counter. | `Result` | settled |
| 189 | Read-your-writes reads | Every query carries the handle's last-seen commit version and is answered by the nearest caught-up replica or edge cache. | Remote reads at edge latency without a setting. | — | settled |
| 190 | Fleet views | Fleet queries only as declared `Fleet.view`, maintained from the change feed; engine choice open. | Relational visibility at any scale. | CDC | settled; engine open |
| 191 | Storage and operations | Zstd-dictionary-compressed `bytea` state; cold tier after 30 idle days; same-AZ runners; automatic prewarm; operator tenant moves. | Trillion-actor cost, and one cross-zone hop per turn. | — | settled |
| 192 | Evidence | `ActorTest.simulate` deterministic simulation and published benchmarks; V8 isolates deferred. | Trust claims need reproducible evidence. | `TestClock` | settled |

## 3.9. Round 10 — one way to do everything (193–212)

Owner's answers in this round, in order: direct commands are the only command path ("no footguns"); only one way to do anything unless it materially changes outcomes; `Actor.make` is the only way to make an actor; keep PascalCase; reject both an array of members and the `turn.send(Counter, id, Increment, 1)` form as hard to read and not Effect-native; accept a sectioned definition object and handles whose method shape is the same inside and outside a turn. Recorded in [ADR 0010](../../docs/decisions/0010-one-way-effect-native-api.md) and [ADR 0011](../../docs/decisions/0011-direct-commands-outbox-and-performance.md). The type spike is `research/v5`, not yet written.

| # | Decision | Choice | Why | Primitive | Status |
| --- | --- | --- | --- | --- | --- |
| 193 | One way | Exactly one way to do each task; a second way only when it materially changes outcomes. | Owner: "only provide ONE way to do anything … no footguns". | — | settled |
| 194 | Constructor | `Actor.make(name, definition)` is the only way to make an actor and its only shape; no piping, no member-list array. Supersedes 3, 157, 171. | Owner: "only one way to MAKE an actor, and that is Actor.make"; the array was hard to read. | `Rpc.make`-style options | settled |
| 195 | Definition sections | `key`, `placement`, `state`, `tables`, `blobs`, `events`, `effects`, `api`, `policy`; data only. `api` is a record whose keys equal member tags. | One registry; named sections read like `Rpc.make` and `Schema.Struct`. | mapped types | settled |
| 196 | Members | `Actor.command`, `Actor.reducer`, `Actor.query`, `Actor.stream`, `Actor.connection`, `Actor.workflow`, `Actor.state`, `Actor.table`, `Actor.blob`, `Actor.Event`, `Actor.effect`; `internal: true` on the command. | Member constructors never make actors; no `internal` list to keep in sync. | `Rpc.make` | settled |
| 197 | Identity | `key`: id schema (named), `Actor.singleton`, or omitted (minted). `X.create()` is the only minting path; `Actors.mint` and public `X.id` removed. Supersedes 157's `singleton: true`. | One field cannot conflict with itself. | `Sharding.registerSingleton` | settled |
| 198 | Policies | `policy` data keys replace `Hibernate`, `Commands`, `Delivery`, `State`, `Mailbox`, `Lifecycle`, `Receipts`, `Events`, `Effects`, `Connections`, and `Cron.every`. | Serializable data in the contract; type-checked references to `api`. | — | settled |
| 199 | Context | Handlers take only input; context is a typed service per phase: `X.Turn`, `X.Read`, `X.Connection`, `X.Workflow`, `X.Executor`. Supersedes 124's `(ctx, input)`. | One path instead of `ctx` plus an untyped `Turn`; helper types state their phase. | `Context.Service` | settled |
| 200 | Activation values | `vars` removed; a `Ref` in the layer build closure. Supersedes 51. | Plain Effect. | `Ref` | settled |
| 201 | Layers | `toLayer`, `toQueryLayer`, `toEffectLayer`, Effect form only, no options; build body = wake, `Effect.addFinalizer` = sleep, `Effect.forkScoped` = `run`, `X.onDefect`, internal `EffectDeadLettered`. Supersedes 11, 109, 159. | Code lives in layers, not configuration. | `Layer`, `Scope` | settled |
| 202 | Calls outside turns | `(yield* X.get(id)).Command(input)` request/reply; PascalCase method = tag = `api` key = handler key; no `.send`. | Effect Cluster's entity client shape. | `Entity.client` | settled |
| 203 | Intents inside turns | `(yield* X.intents(id)).Command(input)` returns an intent; `Intent.after`, `Intent.at`, `Intent.key` pipe onto it; `Intent.cancel(key)`; self via `X.intents(turn.id)`. | Same call shape as outside; the turn decides durability, like Cluster's `discard`. | `Actor.InTurn` marker | settled |
| 204 | Rejected spellings | camelCase methods and `turn.send(Counter, id, Increment, 1)` rejected. | A second spelling per command; not Effect-native. | — | settled |
| 205 | Ambient scope | `Actor.as`, `Actor.tenant`, `Actor.commandId` around an Effect; `get` takes no options. Supersedes the `get` options of 8, 89, 154. | One way to set caller and tenant. | `Context.Reference` | settled |
| 206 | Direct commands | Commands route as volatile Cluster messages; the receipt is the only durable admission record; callers retry with the same id. Supersedes F3's persisted messages. | Owner chose direct as the only path; removes three writes per command and the global `cluster_*` hot path. | `ClusterSchema.Persisted` false | settled |
| 207 | One outbox | Every intent, timer, workflow start, and effect obligation is an `actor_outbox` row on the sender's shard, delivered as a direct command keyed by the intent id. Supersedes 46/156's `cluster_messages` handoff and F5's single-shard-group intent path. | One intent path on every backend and region. | — | settled |
| 208 | Durability | One level: cross-AZ commit. No `local`/`memory` modes; ephemeral data travels as connection frames. | Faster modes that risk acknowledged writes are footguns. | — | settled |
| 209 | Reads | One query path (189); `group` replaces `ctx.db` for placement-group joins; fleet reads only through `Fleet.view`. | One way per tier. | Drizzle | settled |
| 210 | Reducer shape | `Actor.reducer(tag, { state, input, errors?, reduce, commutative? })`; commutative reducers return `void` and declare no errors. | Reducer vs command is the one kept distinction: only reducers run on clients or merge. | `Result` | settled |
| 211 | Workflows | Workflow members in `api`; body uses `X.Workflow` plus Effect `Activity` and `DurableClock`; started by a call outside a turn or an intent inside. | One call shape for every member. | `Workflow`, `Activity` | settled |
| 212 | Migration | M0 code (ADR 0007/0008 spelling, persisted Cluster messages) migrates to this API and delivery model in M1; the `research/v5` type spike gates it. | Docs describe target; code and evidence change together. | — | gated (type spike) |

## 4. Verification gates (must pass before the decision is claimed)

| Gate | Decisions | Check |
| --- | --- | --- |
| Neki cross-shard-group transaction | 46 | A turn transaction that writes `actor_*`/business rows (tenant shard) and `cluster_messages` (single shard group) commits atomically on Neki, or 46 falls back to an `actor_outbox` relay on Neki only. |
| Neki locking and pinning | F5, 34, 66 | `SELECT … FOR UPDATE` on the generation row, `SET __neki.tx_mode='single'` on the `BEGIN` connection, pool behaviour under `shardLockDisableAdvisory: true`. |
| Railway advertise address | 60 | Each replica can advertise a private address that other replicas reach (`railnet0` per-replica address); otherwise use `Topology.k8s()` or a service-per-runner layout. |
| PGlite in tests | 62 | Effect `Migrator` DDL and `SqlMessageStorage` DDL run on PGlite; lock-contention tests are routed to real Postgres. |
| Cluster header size | 35 | Principal encoded in envelope headers stays under `cluster_messages.headers` limits for the largest expected principal. |
| PGlite under Bun | 62, 69 | `@electric-sql/pglite` + `pglite-socket` run under `bun --bun vitest`, one fresh database per `it.layer` block is fast enough, and the framework + `SqlMessageStorage` migrations apply. |
| In-process multi-runner | 77 | A harness `RunnerStorage` (per-address locks, `Clock` expiry) plus a `Runners.make` bus drive N `Sharding` instances in one process and `cluster.kill` + `clock.advance(> shardLockExpiration)` moves the shard. |
| Crash points | 71, 76 | Source-verified: `withTransaction` rolls back on a failed Exit; `EntityManager` rewrites the same envelope after the defect retry delay. To show: the harness advancing the TestClock through that delay from inside the hook; `pause` + `cluster.kill` rolling back and recovering from `cluster_messages` on the survivor after `shardLockExpiration`. |
| Intent rollback | 46, 82 | On `SqlMessageStorage`, an intent written by a turn that fails `beforeCommit` is never delivered. |
| Workflow tenant isolation | 144 | Two tenants starting `Onboard` with the same app idempotency key get two executions; a run resumed on another runner reports the tenant and `onBehalfOf` from its envelope, not the runner's ambient `Tenant`. |
| `waitFor` registration | 144 | An event emitted by the actor between `W.start` and the `waitFor` registration landing still resolves the deferred (registration is acknowledged before the workflow proceeds). |
| Per-call caller over HTTP | 154 (was 145, superseded by 153: no MCP) | Over `Actor.serve`, two concurrent commands with different bearer tokens run as different principals (`ctx.caller` differs, receipts attribute to each); a call without credentials fails with `Unauthorized`, never runs as `Anonymous`. |
| Turn boundary at runtime | 146 | A handle obtained outside and captured in a closure, then called inside a handler, dies with the "Request/reply inside a turn" message and the turn rolls back. |
| Neki intent relay (superseded by 207: outbox delivery on every backend) | 46, 156 | On Neki a turn that writes tenant rows and an intent commits both in the tenant shard (`actor_outbox`); the relay moves the intent into `cluster_messages` after COMMIT exactly once (receipt keyed on the intent id) and a relay crash between COMMIT and the move is recovered by the next relay pass. |
| State migration chain | 162 | A seeded V1 `actor_state` row is decoded through `migrations` on the next turn, the handler sees the V2 shape, and the committed row is V2; a chain whose `to`/`from` do not line up fails at `Actor.make`. |
| Connection park | 163 | With `Connections.park`, an activation with open sockets hibernates after `Hibernate.after`, `conn.state` is restored on the next inbound frame (`ctx.conn.resumed === true`), and a broadcast from a turn wakes it. |
| Singleton uniqueness | 157, 170 | With two runners, a `singleton: true` actor's `Cron.every` ticks once per schedule and its `run` loop is live on exactly one runner; killing that runner moves both within `shardLockExpiration`. |
| Outbox delivery | 207 | Same-shard, cross-shard, and cross-region intents and keyed timers survive crashes before delivery, after receiver commit, and before row deletion with one receiver transition per intent id. |
| Direct command recovery | 206 | Owner killed before commit: no receipt or consequence, and the caller's retry with the same id executes once; after commit: receipt replay. |
| Pipelined visibility | 187 | Batch N+1's replies, broadcasts, and outbox rows stay hidden until its own commit; a failed batch N discards them. |
| Reducer laws | 188, 210 | Commutative reducers satisfy the merge law under generated inputs; browser optimistic state converges to committed state. |
| API type spike | 194–205 | `research/v5` rejects a mismatched `api` key, a bad cron target, wrong-phase context use, `X.intents` outside a turn, and `X.get` inside a turn; typecheck time recorded. |
