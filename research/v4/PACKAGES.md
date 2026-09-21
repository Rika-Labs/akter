# Durable Actors — what is an actor, what is the framework, what is a package (round 6, 2026-09-21)

> **Superseded on 2026-09-21 by decisions 151–171** in the parts that name packages and kinds: the package is
> `durable-actors` with four subpaths (`durable-actors`, `/runtime`, `/client`, `/testing`) — never
> `@rika/...`, no `/identity`, `/actors`, `/workflows`, `/pg`, `/http`, `/ai`, `/admin` or `/server` — and
> there is one kind, `Actor.make`, with `singleton: true`, `Cron.every` as a lifecycle policy and workflows as
> members, so `Durable.*` and `Workflow.make` do not exist. The reasoning about boundaries below still holds;
> the code blocks have been updated to the current spelling.

The question was: with decisions 1–134 settled, what should *not* be an actor, what should *not* be in the
framework, and what should be extracted — reacting to a proposed multi-package split (actors / events
"Topic" / workflows / runtime / testing). The Oracle reviewed the whole surface ([framework/Actor.ts](framework/Actor.ts),
[DECISIONS.md](DECISIONS.md), [DX.md](DX.md), the examples, [DNS-ORDERING.md](DNS-ORDERING.md)) against the
rc.116 sources. Every claim below that names an Effect internal was checked in `node_modules/effect/src`.
Decisions are 135–150 in [DECISIONS.md](DECISIONS.md) §3.5; veto by editing the row.

## The verdict in one paragraph

Ship **one distribution with module boundaries**, not five release trains. One user-facing primitive,
`Actor.make`; workflows are members of the actor that owns them, and cron and singletons are options on the same
constructor (`Cron.every` in `lifecycle`, `singleton: true`). **`Topic` is deferred**: on
one Postgres it is a new broker subsystem (partitions, offsets, consumer groups, retention gaps), not a wrapper,
and none of the examples need it; a projection actor fed by intents covers cross-actor fan-out today. The
runtime substrate becomes a real boundary (`Actor.layer` on `durable-actors/runtime`) with a small option set.
Testing stays one environment (`ActorTest` on `durable-actors/testing`) with a per-primitive fault seam. Four real bugs came out of the
review and are fixed in the sketch: writable blobs on wake, workflow keys without tenant, toolkit/MCP wanting a
caller at layer build, and `InsideTurn` bypassable through a captured handle.

## 1. What is not an actor

An actor is *identity + serialized mutations under one transaction*. Not "runs on a Cluster Entity": Effect's
`ClusterWorkflowEngine` runs workflow executions on an Entity too (with `concurrency: 2`, verified), and that is
engine bookkeeping, not the consistency contract the app sees.

| Program | Is | Because | Spelling |
| --- | --- | --- | --- |
| Chat, Counter, Doc, DNS `Order`, DNS `Domain` | actor | identity, ordered commands, receipts, events, timers | `Actor.make` |
| Cursor, DNS `RegistrarLane` | actor with no durable members | identity + serialized mutations of `vars`; forgets on hibernation (a lane is admission control, not a hard quota) | `Actor.make` with `vars` and no `state`/`tables`/`events`/`effects` |
| CodingAgent, AgentSession | actor + activation `run` | session identity, cancel/approve/results are actor state; the model loop is not a workflow. A prompt that must finish with no client attached needs a workflow or an effect, not a stronger `run` | `Actor.make` + `run` in `toLayer` |
| `User.Onboard`, `CodingAgent.Ship`, DNS `Order.Fulfil` | workflow member | an execution with a start and an end; identity is (deployment, tenant, owner, key) | `Actor.workflow` in `workflows: [...]` |
| Nightly, DNS `Reconcile` | cron on a singleton | the tick is not its own kind: it is a lifecycle policy naming a zero-input command | `Actor.make({ singleton: true, lifecycle: [Cron.every(...)] })` |
| Reaper | singleton | cluster-owned maintenance; framework retention must not depend on app SQL | `Actor.make({ singleton: true })` + `run` |
| Reports | SQL service | already not an actor | `Effect.Service` on `Database` |

Rejected: "workflows have no identity / no mailbox, so they are not actors". They have both; what they lack is an
*open-ended command API*. Rejected: "finite lifetime is the line" — actors terminate, workflows can wait forever.

```ts
// one constructor (decision 157); see example/User.ts, example/Nightly.ts, example/Reaper.ts
export const Onboard = Actor.workflow("Onboard", { description: "…", input: { roomId: RoomId }, output: Schema.Struct({ nudged: Schema.Boolean }), errors: [NotAMember] })
export const User = Actor.make("User", { id: UserId, commands: [Join], workflows: [Onboard], state: { rooms: … } })

export const ResetAll = Actor.command("ResetAll", { description: "Reset the well-known counters." })
export const Nightly = Actor.make("Nightly", {
  description: "Nightly maintenance: resets the well-known counters at 03:00 UTC.",
  singleton: true,
  commands: [ResetAll],
  lifecycle: [Cron.every("0 3 * * *", ResetAll, { skipIfOlderThan: "1 hour" })]
})
export const Reaper = Actor.make("Reaper", { description: "Retries young dead letters cluster-wide.", singleton: true, commands: [Pause, Resume], state: { paused: … } })
```

## 2. What is not in the framework

The differentiator is *typed contracts → attributed calls → fenced serialized transactions → durable consequences →
faithful failure tests*. Adapters make it reachable; they are not it.

| Surface | Decision | Why |
| --- | --- | --- |
| `Actor.serve`, `Actor.auth` | keep on `/runtime`, **optional to call** (decision 155) | contract-derived RPC/OpenAPI/SSE is product, not turn execution; caller *propagation* stays core, credential *verification* is an edge concern. Embedded apps never call `serve` |
| AI adapters (`toolkit`, `mcp`) | **not built** (decision 153) | the primitives — contracts, events with a cursor, effects with dead letters, workflows with `waitFor`, connections — are what make agents easy to write; `/openapi.json` is what tools consume |
| `framework/React.ts` | **delete from v1** | a UI cache/subscription layer proves nothing about durable actors and is under-typed |
| Promise client | keep, implementation → `/client` | browser adoption; never pulls `effect/unstable/sql` |
| `Actor.blob` | keep core, **writes only inside turns** | atomic bytes next to metadata is real; it is rows, not S3 |
| `Actor.connection` | keep the contract on the root, transport on `/runtime` | per-activation sessions with typed frames are the realtime story; `Connections.park` lets the activation hibernate while sockets stay open (decision 163) |
| `Lifecycle.createdBy`, `ctx.terminate`, `State.maxBytes` | keep core | prevent mutating nonexistent domain objects; only the turn owner can coordinate generation + cleanup; the small-state/large-table split is what keeps turns cheap |
| `Actors.deadLetters` | keep on `Actors` (`list / retry / discard`) | recovery is essential, and the `Reaper` singleton's `run` loop is the canonical consumer; a separate admin subpath was dropped with the multi-subpath split |
| a Kubernetes topology | **not built** | `Topology.single()` and `Topology.http({ listen, advertise })` (plus `Topology.fromConfig()`) are enough; add more when its discovery/health contract is implemented |
| barrel | narrow | `ServeTypeId`, `Serve`, `Hook`, `InsideTurn`, `InActorTurn`, `RpcsOf`, `HandlersFor`, `Drizzle/ColumnKind/ColumnType` placeholders are internal; `X.entity` is an escape hatch, not part of the documented surface |

`ctx.terminate` is specified, not softened: a transactional lifecycle transition plus declared-data cleanup. Not
permission to delete receipts still needed for replay, not compensation of started effects, not erasure of history.

## 3. Package layout

Superseded on 2026-09-21 by decision 151: the thirteen-subpath tree below was cut to four, because every extra
subpath is a decision a reader has to make before writing a contract. What survived is the browser rule of
decision 61 (the root never pulls `effect/unstable/sql`) and lockstep versions in one npm distribution.

```text
durable-actors                     # never @rika/...
├── .                    Actor (make, command, query, stream, connection, workflow, table, blob, migration,
│                        serve, auth, as, anonymous, tenant, commandId), Policy (Hibernate, Mailbox, Defects,
│                        Delivery, Effects, Commands, Receipts, Events, State, Cron, Lifecycle, Connections),
│                        Actors, ActorError, Principal/Caller/CurrentCaller/TenantId/ActorRef (browser-safe)
├── /runtime             Actor.layer, Topology (single / http / fromConfig), Database
├── /client              Promise client, TransportError (browser-safe; no effect/unstable/sql)
└── /testing             ActorTest
```

Absent: `/events`, `Topic`, `Projection`, `/react`, S3 segment APIs, a Kubernetes topology, and the
`/identity`, `/actors`, `/workflows`, `/pg`, `/http`, `/ai`, `/admin`, `/server` subpaths this section proposed.

**Type → owner**

| Type / API | Owner |
| --- | --- |
| `TenantId`, `Tenant`, `DeploymentId`, `Principal`, `Caller`, `CurrentCaller`, `ActorRef` | root (browser-safe; `Caller.System` references `ActorRef`, so it lives here — no universal `ResourceRef`) |
| `CommandId`, `Actor.commandId`, `ActorError` (with its reasons), `Turn`, contexts, policies, events, intents | root |
| `ExecutionId`, `WorkflowRun`, `WorkflowInterrupted`, `WorkflowContext`, `Actor.workflow` | root (a workflow is a member) |
| `Database`, `Topology`, `Actor.layer`, runtime options, `RuntimeControl` | `/runtime` |
| `Actor.serve`, `Auth`, `Unauthorized`, `InvalidInput` | root (`serve` is optional to call, decision 155) |
| `TransportError`, call options | `/client` |
| dead-letter ops (`Actors.deadLetters.list / retry / discard`) | root |
| `TurnHooks`, `TurnReport`, activity fault hooks | internal; re-exported only by `/testing` |

```ts
// one augmentation target: the root
declare module "durable-actors" {
  interface Principal { readonly userId: UserId; readonly orgId: OrgId; readonly roles: ReadonlyArray<"member" | "admin"> }
}
```

### `server.ts` with the subpaths that exist

Same registrations as [example/server.ts](example/server.ts); the runtime boundary is explicit, and there is no
process-wide anonymous caller — `CurrentCaller` defaults to `Anonymous` and the auth middleware sets it per
request (decision 154).

```ts
import { Layer } from "effect"
import { Actor, DeploymentId, TenantId } from "durable-actors"
import { Database, Topology } from "durable-actors/runtime"

const auth = Actor.auth.bearer(verify)

const Registrations = Layer.mergeAll(
  ChatLive, ChatReads, CounterLive, CounterReads, CodingAgentLive, CursorLive, DocLive, DocReads, UserLive, NightlyLive, ReaperLive
).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive, ModelLive, ToolsLive))
)

// optional (decision 155): drop `Actor.serve` to embed the actors in this process and call them as Effects
export const AppLive = Registrations.pipe(
  Layer.provideMerge(Actor.serve({
    actors: [Chat, Counter, CodingAgent, Cursor, Doc, User, Nightly, Reaper],
    auth
  })),
  Layer.provide(Actor.layer({
    deployment: DeploymentId.make("chat-production"),
    principal: PrincipalSchema,
    tenant: (p) => TenantId.make(p.orgId),
    topology: Topology.fromConfig(),
    shardGroup: (tenant) => (tenant.startsWith("eu-") ? "eu" : "default"),
    pollInterval: "1 second"
  })),
  Layer.provide(Database.layerConfig())
)

export const main = Layer.launch(AppLive)
```

`Actor.layer` requires exactly one `Database`; it takes no `objectStorage`, no `auth`, no executor bag, no
migration callbacks. There is no separate workflow layer: a workflow body ships with its owner's `toLayer`.

## 4. The verbs inside a turn (no `publish`, no universal `dispatch`)

Each verb encodes a different recovery rule; collapsing them saves autocomplete entries and loses types.

| Verb | Meaning | Rides the transaction? |
| --- | --- | --- |
| `ctx.emit(event)` | append a fact to *this actor's* history | yes (live delivery after COMMIT) |
| `ctx.self.X.send / after / at`, `ctx.actors.get(A, id).X.send` | durable delivery to a known actor | yes (`cluster_messages`, decision 46) |
| `ctx.self.W.start / cancel` (a workflow member) | a workflow control intent | yes (a specialized intent) |
| `ctx.perform(effect)` | run an external side effect at least once | yes (outbox row) |
| `ctx.connections.broadcast(frame)` | best-effort live hint | **no** — a process can die between COMMIT and broadcast |

```ts
Place: Effect.fn(function*(ctx, input) {
  yield* ctx.rows(orders).insert({ /* … */ })
  yield* ctx.emit(new OrderPlaced({ domain: input.domain }))
  yield* ctx.actors.get(SalesProjection, projectionIdFor(ctx.id)).OrderPlaced.send({ orderId: ctx.id, domain: input.domain })
  yield* ctx.self.Fulfil.start(input, { key: input.domain })     // `Fulfil` is in this actor's `workflows: [...]`
  yield* ctx.perform(new SendConfirmation({ orderId: ctx.id, email: input.email }))
})
```

## 5. `Topic` — deferred, with the bar it must clear

A topic earns its place when consumers are **added independently of producers**, replay spans **unbounded or unknown
producer identities**, history must **outlive the producer**, and consumer groups need **operational management**. No
example needs that. Actor-per-partition + per-actor events + cursor gives the *writer* half of a topic; it does not
give consumer discovery, offsets, ownership, rebalance, retention gaps or poison-event policy — those are the product.

What we do instead today: a **projection actor** fed by explicit intents (above). A replaying consumer sends
`(source ref, sequence)` to its destination actor, which commits its checkpoint *with* the derived state in one
turn; nothing is acknowledged before that transaction succeeds.

Honesty note for whenever `ctx.publish` exists: committing a publish *intent* is not committing the *append*. The
atomic guarantee is "actor state + publication obligation"; there is a recoverable window where the turn has
committed and the topic does not yet contain the event. Good guarantee; name it.

If vetoed and built, v1 is bounded to: `topic_partitions(next_offset)`, `topic_entries((tenant, topic, partition,
offset), key, schema, payload, producer_dedup)`, `topic_consumers(group, partition, checkpoint, lease, epoch)`,
publish obligations in the existing outbox; fixed partition count; ordering within a partition's *append order*
(offset allocation and append under one partition lock — a sequence alone is not a commit-order cursor);
at-least-once; one fenced consumer per (group, partition); explicit retention-gap errors; dedup by (source ref,
commandId, ordinal); no compaction, S3 segments, repartitioning or Kafka compatibility. On Neki the obligation
stays in the source actor's shard; the append is a separate transaction until the cross-group gate (46) passes.
Size: XL, a persistence subsystem with its own failure model.

## 6. Bugs the review found, and what changed

**Writable blobs on wake (fixed).** `WakeContext.blob` returned `BlobHandle` and Doc compacted from `onWake`; wake
has no transaction (F3). Now `WakeContext` is read-only (`BlobRead`) and gains `self`, so a hook can *schedule*
maintenance; Doc compacts through an `internal` `Compact` command sent every 100 updates and once on a cold start.

```ts
export const Compact = Actor.command("Compact", { description: "Fold the update log. Sent by the actor to itself." })
export const Doc = Actor.make("Doc", { commands: [ApplyUpdate, Rename, Compact], internal: [Compact], /* … */ })
// server
Compact: (ctx) => ctx.blob(doc).compact(mergeUpdates),
// in ApplyUpdate:  if (seq % 100 === 0) yield* ctx.self.Compact.send()
hooks: [Doc.onWake((ctx) => ctx.state.revision % 100 === 0 ? Effect.void : ctx.self.Compact.send())]
```

**Workflow identity without tenant (fixed in the factory).** Effect derives the execution id from (name, key) only,
and the factory passed the app key straight through. The persisted payload now carries `__deployment`, `__tenant`,
`__onBehalfOf`; the key is `JSON.stringify([deployment, tenant, appKey])`; a resumed run rebuilds its context from
the envelope, never from the runner's ambient defaults. `Actor.layer({ deployment })` (`DeploymentId`) is new.

**Caller at layer build for the AI adapters (moot: the adapters are not built).**

> Superseded on 2026-09-21 by decisions 153 and 154: there is no `Actor.toolkit` and no `Actor.mcp`, so no
> adapter has to source a caller. The general fix survives and is now the rule everywhere: `CurrentCaller` is a
> `Context.Reference` defaulting to `Anonymous`, the HTTP auth middleware sets it per request, and no handle
> ever carries `CurrentCaller` in `R`.

The original finding: a caller cannot be supplied when a tool *layer* is built, only when a tool is *called*.
With the ambient reference that is automatic — the layer needs only `Actors`, and each request runs under the
caller its credentials decoded to. A script or a test that wants a specific caller binds it at the handle:

```ts
const room = yield* Chat.get(roomId, { as: principal })              // explicit, per handle
yield* program.pipe(Actor.as(localAgent))                             // scoped override, e.g. a CLI or a script
```

**`InsideTurn` bypass (runtime twin added).** The type check sees requirements, but a handle bound before the turn has
`R = never`. `turn()` now also sets `InActorTurn` and every outside operation dies when it finds it `true`. The
type error stays as the readable diagnostic; the runtime check is the enforcement.

## 7. Testing across primitives

One environment (database, clock, runners, serialization, `settle`), several seams:

| Primitive | Seam |
| --- | --- |
| actor turn | `TurnHooks` before handler / before commit / after commit (unchanged) |
| workflow activity | the activity body/result boundary: `beforeBody`, `afterBodyBeforeResult`, `afterResult` — `Effect.die` inside the body is *not* process loss (the engine may record the exit as a result); pause + `cluster.kill` is the stronger test |
| topic (later) | partition claim, delivery, checkpoint commit — `pauseConsumption`, not `pause` |
| cluster | runner transport/storage ownership (`cluster.kill / isolate`) |

```ts
import { ActorTest } from "durable-actors/testing"        // one name, no alias
const test = yield* ActorTest
const room = yield* test.actor(Chat, roomId)
const user = yield* test.actor(User, alice.userId)
// a workflow is reached through its owner, keyed like it was started
yield* user.workflow(Onboard, { key: roomId }).crashActivity("welcome", { at: "afterBodyBeforeResult", times: 1 })
yield* room.handle.SendMessage({ body: "hello" })
yield* test.settle
```

## 8. Hosting boundaries (only what affects the split now)

Host **deployments** first; application organizations are **tenants inside** a deployment. `tenant_id` and
`shardGroup` are placement and routing, not a sandbox for uploaded code: a handler has `ctx.db`. Cluster shard
groups (compute placement) and Neki shard groups (data placement) are different things.

What the runtime exposes so a control plane can drive it: a stable `DeploymentId` (never a code version); a manifest
of installed contracts + required migrations so an incompatible runner is rejected at start, not at decode; explicit
readiness and drain; configuration without ambient globals; edge-owned auth where a tenant override is routing, not
authorization; operator capability (dead letters, drain) reachable without exposing it on customer endpoints.

```ts
interface RuntimeControl {
  readonly ready: Effect.Effect<void>
  readonly status: Effect.Effect<{ deployment: DeploymentId; state: "starting" | "ready" | "draining"; shardGroups: ReadonlyArray<string> }>
  readonly drain: Effect.Effect<void>
}
export const deployment = { contracts: { actors: [Chat, Counter, User] }, registrations: Registrations }  // workflows ride their owners
```

Managed runners and bring-your-own runners use the same contract; start with BYO if platform scope matters.
Arbitrary customer code sharing a process and a credential is a separate sandboxing project.

## 9. DX findings, ruled

| Finding | Verdict |
| --- | --- |
| plain `Schema.Class` frames cannot switch on `_tag` | real; mixed-frame connections use `TaggedClass` (`MessageFrame \| Typing`); a single-frame connection may stay plain |
| AI adapters need a caller at layer level | was a real bug; moot since decision 153 dropped the adapters, and decision 154 made the caller ambient with a per-handle `{ as }` override |
| singleton/`run` need `catchCause` for `E = never` | the `E = never` is right; a *blanket* catch is wrong — it turns a failed loop into a completed worker. Handle expected failures; no `X.onRun` helper |
| queries on an actor whose state is only `vars` carry `ActorError` | correct: `vars` live on the activation, and a query runs on the caller's node against committed rows — use a stream instead (see `example/Cursor.ts`) |
| `ReadOptions.where` has no ranges | acceptable v1 sugar as long as `ctx.db` is the typed escape hatch; no second SQL DSL |
| `ctx.state.set` is `Partial` | correct patch semantics; document omitted-vs-deleted keys |
| `Actor.tenant` on a bound handle is a no-op | correct binding; apply it at `get` (documented) |

## 10. Ranked next changes to `Actor.ts`

> Superseded on 2026-09-21 by decisions 151–171: items 3, 5, 6, 7 and 8 assumed AI adapters, a `/actors/server`
> split, a `DurableRuntime.layer` boundary, `Workflow.make` / `Durable.*` aliases and `/admin` / `/http` / `/ai`
> subpaths. None of those exist: one kind, four subpaths, no AI surface.

1. runtime turn-boundary enforcement in `turn()` and on captured handles — **done (sketch)**
2. workflow tenant/deployment key + persisted caller, plus a cross-tenant isolation test — **factory done; test pending**
3. ~~AI caller ownership; typed tools~~ — dropped (decision 153)
4. read-only blobs off-turn; compaction as a command — **done**
5. browser-safe contracts vs backend construction (`Actor.make` currently builds the Entity inline; the split is
   internal, not a subpath) — pending
6. `Actor.layer` on `durable-actors/runtime` as the one runtime boundary — **done (sketch)**
7. one kind: `Actor.make` with `singleton: true`, `Cron.every` in `lifecycle`, workflows as members — **done**
8. dead letters stay on `Actors`; `serve` stays on the root and is optional to call — **done**
9. narrow the public barrel — pending
10. reconcile fixtures: migrate `example/*.test.ts` and `typecheck.ts` to 151–171, implement `test.actor`/`Options.as`,
    drop React and the extra topologies — **done for the examples; harness pending**
