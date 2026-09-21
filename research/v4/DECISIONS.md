# Durable Actors — decision ledger (v4, 2026-09-21)

Every product and API decision taken in the v4 review, in the order it was asked. `#` is the question
number used in the review threads; letters are the option the owner picked. "Primitive" is the Effect
`4.0.0-rc.116` construct the decision compiles down to. "Status" is `settled`, `settled (interpreted)`
when the answer needed interpretation (veto if wrong), `delegated` when the owner said "your pick",
or `gated` when a verification must pass before the decision is claimed.

The typechecked sketch that embodies this ledger is [framework/Actor.ts](framework/Actor.ts); the
testing surface is [framework/Testing.ts](framework/Testing.ts).

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
| 9 | State | a — declared tables only, no state blob. | Rows are queryable, migratable, shardable. | drizzle | settled |
| 10 | Table access | b — `tables: [...]` declared on the actor; `ctx.rows(table)` pre-scoped to `(tenant_id, actor_id)`. | | drizzle query builder | settled |
| 11 | Hooks | b — values in a `lifecycle` array. Interpreted: hooks carry code, so they live in the server file (`X.onCreate/onWake/onSleep/onEffectFailed`) and are passed with `X.of(handlers, { lifecycle })`; contract-side `lifecycle` holds serializable policies only. | Clients never bundle handler code. | | settled (interpreted) |
| 12 | `ctx.self` | b — intents only (`ctx.self.Reset.after("1 hour")`); no request/reply to self inside a turn. | A turn holds a transaction open. | intents | settled |
| 13 | Other actors in a turn | b — intents only via `ctx.actors.get(Other, id).Cmd.send(...)`. | Same reason as 12. | intents | settled |
| 14 | Memory | b — declared `memory` on the actor. **Superseded by 51.** | | | superseded |
| 15 | `commandId` override | b — pipeable `Actor.commandId("key")`. | Ambient, no trailing option on every call. | `Context.Reference` | settled |
| 16 | Caller propagation | Resolved by 35–36. | | | superseded |
| 17 | Fire-and-forget outside a turn | a — not allowed; outside handles have no `.send`. | Every outside call is request/reply with a receipt. | | settled |
| 18 | Coding agents | Resolved by 40. | | | superseded |
| 19 | Streams | `Actor.stream` — routed via the actor, forked past the mailbox. | Long streams never block commands. | `Rpc.make({ stream: true })`, `Rpc.fork` | settled |
| 20 | Non-Effect client | `X.client({ baseUrl })` Promise client derived from `X.rpcs`. | | `RpcClient` | settled |
| 21 | Timers | b — keyed: `.after(d, input, { key })`, `.at(when, …)`, `ctx.timers.cancel(key)`; same key replaces. | | `DeliverAt` (see 38) | settled |
| 22 | Cron | a — `Cron.every(expr, ZeroInputCommand)` policy. | | see 39 | settled |
| 23 | Side effects | a — `effects: [SendEmail]`, `ctx.perform(new SendEmail(...))`, executors in the server file, `Effects.retry(schedule)` policy. Executed after commit, at least once. | Outbox pattern with typed payloads. | `actor_outbox` | settled |
| 24 | Workflows | `Actor.workflow(name, { input, output, errors, idempotencyKey })`, `W.toLayer((ctx, input) => …)`, `ctx.activity`, `ctx.sleep`, `ctx.actors`; `ctx.workflows.start(W, input)` intent inside turns. | | `Workflow.make`, `Activity.make`, `DurableClock` | settled |
| 25 | Declarative subscriptions | a — none; actors subscribe by sending intents from handlers. | | | settled |
| 26 | Delivery failure | a — `ActorUnavailable { reason, cause }` wrapping the Cluster error. | Nothing collapses to `unknown`. | `ClusterError` | settled |
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
| 36 | Attribution | a + b — `ctx.caller` is `User(principal) \| System({ source }) \| Anonymous`, **and** every outside call must be attributed: handle methods carry `R = CurrentCaller` until `Actor.as(principal)` / `Actor.anonymous` / the HTTP auth middleware provides it. Inside turns, workflows, cron and executors the framework provides `System`. | Explicit attribution at the edge; timers and cron still have a well-typed caller. | `Context.Service` (no default) | settled (interpreted: "B plus A") |
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
| 46 | Where intents go | a — inserted straight into `cluster_messages` inside the turn transaction (via `MessageStorage.saveEnvelope` on the fiber-scoped transaction connection), target runner notified after COMMIT. | Atomic with the turn, no relay. | `SqlMessageStorage` | gated (Neki: cross-shard-group transaction) |
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
| 62 | Test databases | a — PGlite in-process (over `@electric-sql/pglite-socket`, so the real `PgClient` is used) for unit and cluster tests; real Postgres for lock-contention, multi-connection and conformance tests; virtual time everywhere via `TestClock`. See [framework/Testing.ts](framework/Testing.ts). | PGlite multiplexes one connection, so `FOR UPDATE` contention is only real on Postgres. | `TestClock`, `SqlMessageStorage`, `Runners.layerNoop` | delegated |
| 63 | Spans | a — framework spans `actor.turn`, `actor.intent`, `actor.effect`, `actor.query`, `actor.stream` with `actor.type`, `actor.id`, `tenant`, `command`, `commandId`, `generation`; `Effect.fn("...")` names in handlers are optional. | | `Effect.withSpan`, `ClusterMetrics` | delegated |
| 64 | Tables | a — `Actor.table(name, columns)` adds `tenant_id`, `actor_id` and the composite index and returns a real drizzle `pgTable` (drizzle-kit still sees it). | | drizzle | delegated |
| 65 | Framework schema | a — `Database.layer({ migrate: "auto" })` runs the Effect `Migrator` at boot; `"manual"` exposes `Database.migrate` / a CLI. | | `Migrator` | delegated |
| 66 | Neki gate | a — design for "Postgres without `LISTEN/NOTIFY` or session pinning" everywhere (43, 46), then run one conformance suite (`FOR UPDATE`, `SET __neki.tx_mode='single'`, pooling, cross-shard-group transaction) before claiming support. | One code path. | conformance suite in `durable-actors/testing` | gated |
| 67 | Contract evolution | a — additive-only rule with `Schema` defaults, documented; no versioned commands yet. | Persisted messages and 30-day events decode with future code. | `Schema.optionalKey` / defaults | delegated |
| 68 | Names | `ctx.perform`, `Actor.as`, `Defects.retry`, `Actor.stream`, `Lifecycle.createdBy`. | | | delegated |

## 3. Verification gates (must pass before the decision is claimed)

| Gate | Decisions | Check |
| --- | --- | --- |
| Neki cross-shard-group transaction | 46 | A turn transaction that writes `actor_*`/business rows (tenant shard) and `cluster_messages` (single shard group) commits atomically on Neki, or 46 falls back to an `actor_outbox` relay on Neki only. |
| Neki locking and pinning | F5, 34, 66 | `SELECT … FOR UPDATE` on the generation row, `SET __neki.tx_mode='single'` on the `BEGIN` connection, pool behaviour under `shardLockDisableAdvisory: true`. |
| Railway advertise address | 60 | Each replica can advertise a private address that other replicas reach (`railnet0` per-replica address); otherwise use `Topology.k8s()` or a service-per-runner layout. |
| PGlite in tests | 62 | Effect `Migrator` DDL and `SqlMessageStorage` DDL run on PGlite; lock-contention tests are routed to real Postgres. |
| Cluster header size | 35 | Principal encoded in envelope headers stays under `cluster_messages.headers` limits for the largest expected principal. |
