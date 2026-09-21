# Durable Actors — what is an actor, what is the framework, what is a package (round 6, 2026-09-21)

The question was: with decisions 1–134 settled, what should *not* be an actor, what should *not* be in the
framework, and what should be extracted — reacting to the proposed `@rika/durable` split (actors / events
"Topic" / workflows / runtime / testing). The Oracle reviewed the whole surface ([framework/Actor.ts](framework/Actor.ts),
[DECISIONS.md](DECISIONS.md), [DX.md](DX.md), the examples, [DNS-ORDERING.md](DNS-ORDERING.md)) against the
rc.116 sources. Every claim below that names an Effect internal was checked in `node_modules/effect/src`.
Decisions are 135–150 in [DECISIONS.md](DECISIONS.md) §3.5; veto by editing the row.

## The verdict in one paragraph

Ship **one distribution with module boundaries**, not five release trains. Two user-facing primitives now,
`Actor` and `Workflow`; `cron` and `singleton` are runtime facilities under `Durable`. **`Topic` is deferred**: on
one Postgres it is a new broker subsystem (partitions, offsets, consumer groups, retention gaps), not a wrapper,
and none of the examples need it; a projection actor fed by intents covers cross-actor fan-out today. The
runtime substrate becomes a real boundary (`DurableRuntime.layer`) with a small option set. Testing stays one
environment (`ActorTest`, aliased `DurableTest`) with a per-primitive fault seam. Four real bugs came out of the
review and are fixed in the sketch: writable blobs on wake, workflow keys without tenant, toolkit/MCP wanting a
caller at layer build, and `InsideTurn` bypassable through a captured handle.

## 1. What is not an actor

An actor is *identity + serialized mutations under one transaction*. Not "runs on a Cluster Entity": Effect's
`ClusterWorkflowEngine` runs workflow executions on an Entity too (with `concurrency: 2`, verified), and that is
engine bookkeeping, not the consistency contract the app sees.

| Program | Is | Because | Spelling |
| --- | --- | --- | --- |
| Chat, Counter, Doc, DNS `Order`, DNS `Domain` | durable actor | identity, ordered commands, receipts, events, timers | `Actor.make` |
| Cursor, DNS `RegistrarLane` | ephemeral actor | identity + serialized in-memory mutations; forgets on restart (a lane is admission control, not a hard quota) | `Actor.ephemeral` |
| AgentSession | durable actor + activation `run` | session identity, cancel/approve/results are actor state; the model loop is not a workflow. A prompt that must finish with no client attached needs a workflow or an effect, not a stronger `run` | `Actor.make` |
| Onboard, DNS `Fulfil` | workflow | an execution with a start and an end; identity is (deployment, tenant, key) | `Workflow.make` (alias `Actor.workflow`) |
| Nightly, DNS `Reconcile` | cron facility | the tick is not an actor; its targets are | `Durable.cron` (alias `Actor.cron`) |
| Reaper | singleton facility | cluster-owned maintenance; framework retention must not depend on app SQL | `Durable.singleton` (alias `Actor.singleton`) |
| Reports | SQL service | already not an actor | `Effect.Service` on `Database` |

Rejected: "workflows have no identity / no mailbox, so they are not actors". They have both; what they lack is an
*open-ended command API*. Rejected: "finite lifetime is the line" — actors terminate, workflows can wait forever.

```ts
// new docs and the skill use these; the settled Actor.* spellings stay as aliases
export const Onboard = Workflow.make("Onboard", { input: { userId: UserId, roomId: RoomId }, output: Schema.Struct({ nudged: Schema.Boolean }), idempotencyKey: ({ userId }) => userId })
export const Nightly = Durable.cron("nightly-reset", { cron: "0 3 * * *" })
export const Reaper  = Durable.singleton("Reaper", { description: "Purges expired receipts cluster-wide." })
```

## 2. What is not in the framework

The differentiator is *typed contracts → attributed calls → fenced serialized transactions → durable consequences →
faithful failure tests*. Adapters make it reachable; they are not it.

| Surface | Decision | Why |
| --- | --- | --- |
| `Actor.serve`, `Actor.auth` | move → `/http` | contract-derived RPC/OpenAPI/SSE is product, not turn execution; caller *propagation* stays core, credential *verification* is an edge concern |
| `Actor.toolkit`, `Actor.mcp` | move → `/ai` | same contracts, different dependency graph; the caller is per invocation (§6) |
| `framework/React.ts` | **delete from v1** | a UI cache/subscription layer proves nothing about durable actors and is under-typed |
| Promise client | keep, implementation → `/client` | browser adoption; never pulls `effect/unstable/sql` |
| `Actor.blob` | keep core, **writes only inside turns** | atomic bytes next to metadata is real; it is rows, not S3 |
| `Actor.connection` | keep contract core, transport → `/http` | per-activation sessions with typed frames are the realtime story |
| `Lifecycle.createdBy`, `ctx.terminate`, `State.maxBytes` | keep core | prevent mutating nonexistent domain objects; only the turn owner can coordinate generation + cleanup; the small-state/large-table split is what keeps turns cheap |
| `Actors.deadLetters` | move → `/admin` (`ActorAdmin`) | recovery is essential; unrestricted admin on every `Actors` client is not |
| `Topology.k8s` | **delete from v1** | `Topology.http` is enough; add k8s when its discovery/health contract is implemented |
| barrel | narrow | `ServeTypeId`, `Serve`, `Hook`, `InsideTurn`, `InActorTurn`, `RpcsOf`, `HandlersFor`, `Drizzle/ColumnKind/ColumnType` placeholders are internal or `/actors/server`; `X.entity` is exposed from `/actors/server`, not the root |

`ctx.terminate` is specified, not softened: a transactional lifecycle transition plus declared-data cleanup. Not
permission to delete receipts still needed for replay, not compensation of started effects, not erasure of history.

## 3. Package layout

One npm distribution (`@rika/durable`, or the same tree under `durable-actors`), explicit subpaths, lockstep
versions. Refines decision 61; keeps its browser rule: the root never re-exports `/pg`, `/runtime`, `/actors/server`.

```text
@rika/durable
├── .                    Actor, Workflow, Durable, policies, identity + boundary errors (browser-safe)
├── /identity            Principal (the one augmentation target), Caller, CurrentCaller, TenantId, DeploymentId, ActorRef
├── /actors              actor contracts and the Effect-facing handle API (browser-safe)
├── /actors/server       actor backend: turn(), receipts, outbox, X.entity, Actor.layer compat
├── /workflows           Workflow.make contracts (browser-safe)
├── /workflows/server    ClusterWorkflowEngine wiring + the actor↔workflow integration (start intent, activity commandId, waitFor)
├── /runtime             DurableRuntime.layer, Topology, RuntimeControl
├── /pg                  Database, Postgres/Neki adapter, migrations
├── /http                serve, Auth, connections transport, OpenAPI/llms.txt
├── /ai                  toolkit, mcp
├── /client              Promise client, TransportError
├── /admin               ActorAdmin (dead letters, migrations, drain)
├── /testing             ActorTest (= DurableTest), harnesses per primitive
└── /server              DurableServer.serve: the opinionated composition of the above
```

Absent from v1: `/events`, `Topic`, `Projection`, `/react`, S3 segment APIs, `Topology.k8s`.

**Type → owner**

| Type / API | Owner |
| --- | --- |
| `TenantId`, `Tenant`, `DeploymentId`, `Principal`, `Caller`, `CurrentCaller`, `ActorRef` | `/identity` (browser-safe; `Caller.System` references `ActorRef`, so it lives here — no universal `ResourceRef`) |
| `CommandId`, `Actor.commandId`, `CommandConflict`, `NotCreated`, `ActorUnavailable`, `Turn`, contexts, policies, events, intents | `/actors` |
| `ExecutionId`, `WorkflowRun`, `WorkflowInterrupted`, `WorkflowContext` | `/workflows` |
| `Database` | `/pg` |
| `Topology`, runtime options, `RuntimeControl` | `/runtime` |
| `Auth` | `/http` |
| `Unauthorized`, `InvalidInput` | root boundary errors |
| `TransportError`, call options | `/client` |
| dead-letter ops | `/admin` |
| `TurnHooks`, `TurnReport`, activity fault hooks | actors/workflows internally; re-exported only by `/testing` |
| `ActorToolkit`, tool name types | `/ai` |

```ts
// one augmentation target; every other path re-exports the same interface
declare module "@rika/durable/identity" {
  interface Principal { readonly userId: UserId; readonly orgId: OrgId; readonly roles: ReadonlyArray<"member" | "admin"> }
}
```

### `server.ts` after the split

Same registrations as [example/server.ts](example/server.ts); the runtime boundary is explicit, HTTP and MCP share one
`auth`, and there is no process-wide anonymous caller.

```ts
import { Layer } from "effect"
import { DeploymentId, TenantId } from "@rika/durable/identity"
import { DurableRuntime, Topology } from "@rika/durable/runtime"
import { Database } from "@rika/durable/pg"
import * as ActorServer from "@rika/durable/actors/server"
import * as WorkflowServer from "@rika/durable/workflows/server"
import { Auth } from "@rika/durable/http"
import { DurableServer } from "@rika/durable/server"

const RuntimeLive = DurableRuntime.layer({
  deployment: DeploymentId.make("chat-production"),
  principal: PrincipalSchema,
  tenant: (p) => TenantId.make(p.orgId),
  topology: Topology.fromConfig(),
  shardGroup: (tenant) => (tenant.startsWith("eu-") ? "eu" : "default"),
  shardGroups: ["default", "eu"],
  pollInterval: "1 second"
}).pipe(Layer.provideMerge(Database.layerConfig()))

const FrameworkLive = WorkflowServer.layer.pipe(Layer.provideMerge(ActorServer.layer), Layer.provideMerge(RuntimeLive))

const Registrations = Layer.mergeAll(
  ChatLive, ChatReads, CounterLive, CounterReads, AgentSessionLive, CursorLive, DocLive, DocReads, OnboardLive, NightlyLive, ReaperLive
).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive, ModelLive, ToolsLive)),
  Layer.provideMerge(FrameworkLive)
)

const auth = Auth.bearer(verify)

export const AppLive = DurableServer.serve({
  listen: { host: "0.0.0.0", port: 3000 },
  actors: [Chat, Counter, AgentSession, Cursor, Doc],
  workflows: [Onboard],
  auth,
  docs: true,
  mcp: { actors: [Chat, Counter, Doc], name: "durable-actors", version: "1", path: "/mcp" } // same auth, per invocation
}).pipe(Layer.provide(Registrations))

export const main = Layer.launch(AppLive)
```

`DurableRuntime.layer` requires exactly one `Database`; it takes no `objectStorage`, no `auth`, no executor bag, no
migration callbacks. `Actor.layer` remains the settled spelling on `/actors/server` and forwards to it.

## 4. The verbs inside a turn (no `publish`, no universal `dispatch`)

Each verb encodes a different recovery rule; collapsing them saves autocomplete entries and loses types.

| Verb | Meaning | Rides the transaction? |
| --- | --- | --- |
| `ctx.emit(event)` | append a fact to *this actor's* history | yes (live delivery after COMMIT) |
| `ctx.self.X.send / after / at`, `ctx.actors.get(A, id).X.send` | durable delivery to a known actor | yes (`cluster_messages`, decision 46) |
| `ctx.workflows.start / cancel` | a workflow control intent | yes (a specialized intent) |
| `ctx.perform(effect)` | run an external side effect at least once | yes (outbox row) |
| `ctx.connections.broadcast(frame)` | best-effort live hint | **no** — a process can die between COMMIT and broadcast |

```ts
Place: Effect.fn(function*(ctx, input) {
  yield* ctx.rows(orders).insert({ /* … */ })
  yield* ctx.emit(new OrderPlaced({ domain: input.domain }))
  yield* ctx.actors.get(SalesProjection, projectionIdFor(ctx.id)).OrderPlaced.send({ orderId: ctx.id, domain: input.domain })
  yield* ctx.workflows.start(Fulfil, { orderId: ctx.id, ...input })
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

**Caller at layer build for toolkit/MCP (fixed at the type level; MCP bridge gated).** `Tool.make({ dependencies })`
exists in rc.116, so the caller is a per-*call* dependency and `AgentTools.layer` needs only `Actors`. For MCP,
`McpServer.registerToolkit` excludes only `McpRequestContext` from startup requirements and that context carries no
headers, so the adapter must provide `CurrentCaller` inside each invocation itself: over HTTP with the same `Auth`
as `serve`; on stdio with an explicit `as`. The `Layer.succeed(CurrentCaller, Caller.anonymous)` workaround is gone.

```ts
Actor.mcp({ actors: [Chat, Counter, Doc], name, version, transport: { _tag: "http", path: "/mcp", auth } })
Actor.mcp({ actors: [Chat, Counter, Doc], name, version, transport: { _tag: "stdio", as: localAgent } })
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
export { ActorTest, ActorTest as DurableTest }
const test = yield* DurableTest
const room = yield* test.actor(Chat, roomId)
yield* test.workflow(Onboard).crashActivity("welcome", { at: "afterBodyBeforeResult", times: 1 })
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
authorization; operator capability (`/admin`) separate from customer endpoints.

```ts
interface RuntimeControl {
  readonly ready: Effect.Effect<void>
  readonly status: Effect.Effect<{ deployment: DeploymentId; state: "starting" | "ready" | "draining"; shardGroups: ReadonlyArray<string> }>
  readonly drain: Effect.Effect<void>
}
export const deployment = { contracts: { actors: [Chat, Counter], workflows: [Onboard] }, registrations: Registrations }
```

Managed runners and bring-your-own runners use the same contract; start with BYO if platform scope matters.
Arbitrary customer code sharing a process and a credential is a separate sandboxing project.

## 9. DX findings, ruled

| Finding | Verdict |
| --- | --- |
| plain `Schema.Class` frames cannot switch on `_tag` | real; mixed-frame connections use `TaggedClass` (`MessageFrame \| Typing`); a single-frame connection may stay plain |
| toolkit/MCP need `CurrentCaller` at layer level | real bug; fixed above |
| singleton/`run` need `catchCause` for `E = never` | the `E = never` is right; a *blanket* catch is wrong — it turns a failed loop into a completed worker. Handle expected failures; no `X.onRun` helper |
| ephemeral queries carry `ActorUnavailable` | correct: their state lives only on the activation |
| `ReadOptions.where` has no ranges | acceptable v1 sugar as long as `ctx.db` is the typed escape hatch; no second SQL DSL |
| `ctx.state.set` is `Partial` | correct patch semantics; document omitted-vs-deleted keys |
| `Actor.tenant` on a bound handle is a no-op | correct binding; apply it at `get` (documented) |

## 10. Ranked next changes to `Actor.ts`

1. runtime turn-boundary enforcement in `turn()` and on captured handles — **done (sketch)**
2. workflow tenant/deployment key + persisted caller, plus a cross-tenant isolation test — **factory done; test pending**
3. AI caller ownership; typed tools (today the toolkit map is `Tool.Any`, which erases parameter/success/error types) — **layer fixed; typing pending**
4. read-only blobs off-turn; compaction as a command — **done**
5. browser-safe contracts vs backend construction (`Actor.make` currently builds the Entity inline; move to `/actors/server`) — pending
6. `DurableRuntime.layer` boundary; `Actor.layer` forwards — pending
7. `Workflow.make`, `Durable.cron/singleton` aliases — **done**
8. `/admin` for dead letters; `/http`, `/ai` adapters — pending
9. narrow the public barrel — pending
10. reconcile fixtures: migrate `example/*.test.ts` and `typecheck.ts` to 89–150, implement `test.actor`/`Options.as`, drop React/k8s — pending
