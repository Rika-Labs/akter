# Durable Actors — DX / AX audit (v4, round 5, 2026-09-21)

A nitpicky pass over [framework/Actor.ts](framework/Actor.ts), [framework/Testing.ts](framework/Testing.ts)
and the examples, against decisions 1–88 in [DECISIONS.md](DECISIONS.md) (none re-opened) and against
published SDK / agent-experience guidance. Every finding has: where it is now, what to do instead
(code), which guideline it comes from, which decision it touches, and my pick. §4 shows the whole
framework in the proposed shape. §5 is the pick list to answer.

Verified this round (typecheck probes, deleted afterwards): phantom per-actor handler registration
(forgetting a handler layer is a type error naming the actor), a literal-string type error for
request/reply inside a turn (the message prints in `tsc` output), caller captured at `get`, an
`internal: [...]` list that removes commands from the outside handle and rejects non-members, and
`Schema.TaggedError` with `override get message()`. rc.116 facts used below were read from
`node_modules/effect/src`: `Stream.fromPubSub` returns `Stream<A>` (no `Scope` in `R`);
`Schema.TaggedError` yields `Class<Self, TaggedStruct, YieldableError>`; `Tool.make(name, { description,
parameters, success, failure, failureMode })` and `Toolkit.make` / `McpServer.toolkit` exist;
`OpenApi.Description / Summary / Deprecated` are `Context.Service` annotation keys; `Config.Redacted`;
`WorkflowEngine.poll / interrupt / resume`.

## 1. Research → rules

| Rule | Source | Applied in |
| --- | --- | --- |
| The SDK generates the repeatability id; it is stable across the SDK's own retries and it is not a user parameter. | Azure SDK guidelines (repeatability), Stripe idempotency keys, Google AIP-155 | 113 |
| Options bag last, named `<Method>Options`; every async call accepts `abortSignal`; `timeoutInMs` on the client. | Azure SDK guidelines | 114 |
| Errors carry the request id and enough to act; add a new error type only when the caller acts differently. | Azure SDK guidelines, AIP-193 (machine-readable `reason`) | 105, 106, 107 |
| Long-running operations return a poller / handle, not a bare id. | Azure `begin*` pattern | 119 |
| Consistency across the ladder: the same argument order and option names everywhere. | Auchenberg, "API design as UX" | 108, 109, 102 |
| Parse, don't validate: decode at the boundary, hand typed values inward. | Alexis King | 97, 106 |
| Tool descriptions read as docstrings; params namespaced and `_id` suffixed; error text tells the model what to do next; output size is budgeted. | Anthropic tool-use guide, MCP spec (`isError` results are not protocol errors) | 96, 115 |
| Type errors are the agent's feedback loop: the lowest-effort path must be the correct one. | Encore "agent experience" | 89, 95, 98, 110, 113 |
| `llms.txt`: H1, blockquote summary, H2 sections of links, `## Optional`; `.md` twins of every page. | llmstxt.org | 116, 121 |
| AGENTS.md carries runnable verification commands; SKILL.md ≤ 500 lines, third-person description. | agents.md, Anthropic skills | 121, 122 |
| Effect conventions: `X.make`, `X.toLayer`, `X.of`, `layer` / `layerConfig`, `Context.Service` ids `"pkg/Name"` matching the export, `Context.Reference` for ambient defaults, `Effect.withSpan("Module/op")`, `@since` / `@category` JSDoc. | effect-smol source | 93, 111, 112, 118, 123 |
| Restate: a *shared* context is structurally read-only; retry-after on retryable errors; rpc options carry the idempotency key. | Restate TS SDK | 103, 105 |
| Rivet / DO: `state` vs `vars`, connections only on action contexts, errors with `code` + public metadata, `getByName`. | Rivet actors, Durable Objects | 100, 105 |

## 2. Findings and proposals (89–124)

Format: **now** → **proposal** → source / decision touched → **pick**. Code is in the shape it would have in
`Actor.ts`; identifiers not shown are unchanged.

### Caller and tenant

**89. The caller is captured at `get`, not piped into every call.**
Now: [Actor.ts#L322-L327](framework/Actor.ts#L322-L327) — every handle method has `R = CurrentCaller`, so
[usage.ts](example/usage.ts) pipes `Actor.as(principal)` onto every call and streams need
`Stream.provideService(CurrentCaller, …)`. Proposal: `get` requires `Actors | CurrentCaller` and binds the
caller into the handle; methods have `R = never`. Both spellings work: ambient (`Actor.as` on `get` or on
the whole program, the HTTP middleware, `ActorTest.layer({ as })`) and explicit `get(id, { as })`.

```ts
readonly get: (id: Id["Type"], options?: GetOptions) => Effect.Effect<Handle<…>, never, Actors | CurrentCaller>
interface GetOptions { readonly tenant?: TenantId; readonly as?: Principal | Caller }

// usage
const counter = yield* Counter.get(id).pipe(Actor.as(principal))
yield* counter.Increment(1)                                   // R = never
const room = yield* Chat.get(roomId, { as: principal })
const transcript: Stream.Stream<Message, NotAMember | ActorUnavailable> = room.Transcript()
```
Decision 36 ("every outside call attributed") holds: attribution moves from the call to the handle, and a
handle without a caller cannot exist. Decision 81 (Anonymous default in tests) holds. Source: Encore
(lowest-effort path is correct), Azure (credential bound at client construction). **Pick: a** (both
ambient and `{ as }`). Alt b: `{ as }` only, no ambient.

**90. Tenant is derived from the principal once, in `Actor.layer`.**
Now: `Tenant` is a `Context.Reference` defaulting to `"default"` ([Actor.ts#L99](framework/Actor.ts#L99));
apps that scope by principal must pipe `Actor.tenant` per call. Proposal:

```ts
Actor.layer({
  principal: PrincipalSchema,
  tenant: (principal) => principal.orgId,      // optional; default: Tenant reference
  topology: Topology.fromConfig()
})
```
`get(id, { tenant })` and `Actor.tenant(id)` stay as overrides (decision 8). **Pick: a.**

**91. System callers remember who they act for.**
Now: `Caller.System` has `source` and an optional Cluster `EntityAddress`; a timer armed by Alice runs as
`System("timer")` and the handler has lost Alice. Proposal: `{ _tag: "System"; source; ref?: ActorRef;
onBehalfOf: Option<Principal> }`, propagated into intents, timers, cron ticks, workflow starts and effect
executors from the turn that created them; plus `ctx.principal: Option<Principal>` (the user, or the
`onBehalfOf` of a system caller). `W.start` requires `CurrentCaller` like `get`.

```ts
SendMessage: Effect.fn(function*(ctx, input) {
  const authorId = Option.getOrElse(ctx.principal, () => "system")   // was a 3-line _tag match
```
Touches 35/36 (extends, does not change). **Pick: a.**

**92. `Actor.serve` requires `auth`; anonymous is explicit.**
Now: `auth?` optional ([Actor.ts#L886](framework/Actor.ts#L886)) — forgetting it serves every actor to
anyone. Proposal: `auth: Auth<R>` required; `Actor.auth.none` for public endpoints; `Actor.auth.bearer(verify)`
and `Actor.auth.header(name, decode)` helpers. **Pick: a.**

**93. Service ids match export names.**
`CurrentCaller` is keyed `"durable-actors/Caller"` ([Actor.ts#L96](framework/Actor.ts#L96)). Effect keys
every service `"pkg/ExportName"`; error output prints the key. → `"durable-actors/CurrentCaller"`. **Pick: a.**

**94. `id` is required on `Actor.make`.**
Now: defaults to `Schema.String` ([Actor.ts#L643](framework/Actor.ts#L643)); decision 6 chose branded ids and
the default silently opts out. `id: Schema.String` stays allowed, but written. **Pick: a.**

### Contract

**95. `internal: [...]` commands.**
Now: [AgentSession.ts#L30-L37](example/AgentSession.ts#L30-L37) exposes `ModelReplied` and `ToolFinished`
(results of effect executors) on the outside handle, the Promise client, HTTP and any toolkit: a browser can
forge a model reply. Proposal:

```ts
export const AgentSession = Actor.make("AgentSession", {
  id: SessionId,
  commands: [SendPrompt, Cancel, ApproveTool, ModelReplied, ToolFinished],
  internal: [ModelReplied, ToolFinished],     // Is extends ReadonlyArray<Cs[number]>
  …
})
```
Internal commands exist on `ctx.self`, `ctx.actors`, workflow handles and `EffectContext.self`; they are
absent from `Handle`, `PromiseHandle`, HTTP, `Actor.toolkit` (type-level `Exclude<Cs[number], Is[number]>`,
verified) and `turn()` rejects a non-System caller with a defect. **Pick: a.**

**96. `description` on actors, commands, queries, streams, workflows.**
Optional string. It flows to `OpenApi.Description` on the Rpc, `Tool.make({ description })` in `Actor.toolkit`,
MCP tool listings, `/llms.txt` and `/actors/{name}.md`. `Actor.toolkit([...])` is a *type error* when an
included actor or non-internal command has no description (same literal-type technique as 110), because a
tool without a description is the one thing every tool-use guide forbids.

```ts
export const SendMessage = Actor.command("SendMessage", {
  description: "Append a message to the room. Fails with NotAMember if the caller is not in the room.",
  input: { body: Schema.String }, output: Message, errors: [InvalidMessage, NotAMember]
})
```
**Pick: a** (optional + toolkit gate). Alt b: required everywhere.

**97. `errors` are yieldable tagged errors with an HTTP status; default 422.**
Now: `Errors extends ReadonlyArray<Schema.Top>` accepts any schema, so `errors: [Schema.String]` compiles
and cannot be yielded. Proposal: `ReadonlyArray<AnyError>` where `AnyError = Schema.Top & { Type: { _tag: string }
& Cause.YieldableError }`; a declared error without `httpApiStatus` maps to 422 (Unprocessable) on HTTP;
framework errors keep their own (401/404/409/503/400/502). **Pick: a.**

**98. A policy that names a command must name one of *this* actor's commands.**
Now: `Cron.every(expr, Cmd)` and `Lifecycle.createdBy(Cmd)` accept any command; the mismatch surfaces at
runtime. Proposal: `Ps extends ReadonlyArray<Policy<Cs[number]>>` on `Actor.make`, plus a runtime check that
command tags are unique within one actor (two commands named `Reset` would collide in the Rpc group).
**Pick: a.**

**99. `events({ after })`, no `Scope` in the stream.**
Now: `EventsOptions.from` "exclusive" ([Actor.ts#L292](framework/Actor.ts#L292)) and the stream type is
`Stream<…, never, Scope.Scope>`. `from` reads inclusive; `after: 0` (sequences start at 1) reads as intended.
rc.116 streams own their scope (`Stream.fromPubSub: Stream<A>`), so `R = never`. **Pick: a.**

**100. `ActorRef` replaces Cluster's `EntityAddress` in user code.**
Now: `handle.address`, `ctx.address`, `Caller.System.actor`, and app services like `RoomAccess.requireMember(caller,
room: EntityAddress)` all import `effect/unstable/cluster`. Proposal: `ActorRef = { actor: string; tenant: TenantId;
id: string }` as a `Schema.Class` (serializable, printable, usable as a map key via `ActorRef.key(ref)`), exposed as
`handle.ref` / `ctx.ref`; `EntityAddress` stays internal. **Pick: a.**

**101. `Policy` namespace, individual exports kept.**
`Hibernate`, `Mailbox`, `Defects`, `Delivery`, `Effects`, `Commands`, `Receipts`, `Events`, `Cron`, `Lifecycle` are
ten top-level exports next to `Actor`; an agent typing `Actor.` cannot find them. Add `Policy = { Hibernate, … }`
(re-export) and list it in `llms.txt`. Names from decisions 21–23/30 unchanged. `Effects.retry` reads oddly next to
the `effect` package and `effects: [...]`; kept because it is decided (23), noted here so nobody trips on it later.
**Pick: a** (add namespace). Alt b: leave as is.

**102. `X.toQueryLayer(...)`; the contract field is `queries`.**
Now: the def field is `queryDefs` because the builder took the name `queries` ([Actor.ts#L494](framework/Actor.ts#L494)).
Every other builder is `toLayer`; the query one should be `toQueryLayer`, which frees `queries` to mean the same thing
on the definition as on `Actor.make`. Decision 49c unchanged. **Pick: a.**

### Handler contexts

**103. Read-only contexts are structurally read-only.**
`QueryContext`, `StreamContext`, `WakeContext` currently expose the same `rows(table)` as the turn. Proposal:
`ScopedRead<T>` (select only) there; `Scoped<T>` (select/insert/update/delete/upsert) only on `CommandContext`. A write
from a query fails to compile rather than running outside the fence (Restate's `ObjectSharedContext`). **Pick: a.**

**104. `ctx.rows(table)` sugar; `ctx.db` stays the escape hatch.**
Decision 9a/10 stand. The pre-scoped builder gets the four calls every handler makes:

```ts
const row = yield* ctx.rows(counters).one()                 // Option<Row>, scoped to (tenant, actor)
yield* ctx.rows(counters).upsert({ value: (row?.value ?? 0) + n })
const all = yield* ctx.rows(messages).all({ orderBy: "sent_at", limit: 50 })
yield* ctx.rows(messages).insert({ id, body })
// joins and anything else: drizzle on the same transaction
yield* ctx.db.select().from(messages).innerJoin(…)
```
**Pick: a.** Alt b: only `select/insert/update/delete` pass-throughs, no `one/upsert/all`.

### Errors

**105. Framework errors say what happened and what to do.**
Now: `CommandConflict { commandId }`, `ActorUnavailable { reason, cause }`, `NotCreated { id }`, `Unauthorized { reason:
string }` have no `message`, no actor/command context, no retry hint. Proposal (all `Schema.TaggedError`, all with
`httpApiStatus`, all with `override get message()`):

```ts
export class CommandConflict extends Schema.TaggedError<CommandConflict>()("CommandConflict", {
  ref: ActorRef, command: Schema.String, commandId: Schema.String
}, { httpApiStatus: 409 }) {
  readonly retryable = false
  override get message() {
    return `${this.ref.actor}/${this.ref.id}: commandId ${this.commandId} was already used for ${this.command} with a different input. Reuse the same input to replay, or use a new commandId.`
  }
}
export class ActorUnavailable extends Schema.TaggedError<ActorUnavailable>()("ActorUnavailable", {
  ref: ActorRef, command: Schema.String,
  reason: Schema.Literals(["mailbox_full", "already_processing", "persistence", "not_assigned"]),
  retryAfter: Schema.Option(Schema.Duration),
  cause: Schema.Union([MailboxFull, AlreadyProcessingMessage, PersistenceError, EntityNotAssignedToRunner])
}, { httpApiStatus: 503 }) {
  readonly retryable = true
  override get message() { return `${this.ref.actor}/${this.ref.id}: ${this.command} not delivered (${this.reason}); retry after ${…}` }
}
export class Unauthorized … { reason: Schema.Literals(["missing_credentials", "invalid_credentials", "expired"]) }  // 401
export class NotCreated  … { ref: ActorRef, createdBy: Schema.String }                                             // 404
```
`reason` fields are literal unions (AIP-193), `retryable` is a plain property (not serialized, derivable from
`_tag`). Coding agents get the next step in the message; humans get the same in logs. **Pick: a.**

**106. Boundary errors exist only on the boundary.**
`InvalidInput { command, issues }` (400) when the HTTP body fails the input schema, and `TransportError { status,
requestId, body }` (network / non-actor responses) are thrown by the Promise client and served over HTTP. The Effect
handle never has them in `E`: its inputs are typed and it talks to Cluster, whose failures are already
`ActorUnavailable`. **Pick: a.**

**107. `x-request-id` = commandId.**
The HTTP layer echoes the commandId as `x-request-id` on every response; `TransportError.requestId` and the framework
errors' `commandId` are the same string the caller can search logs for. **Pick: a.**

### Server file

**108. Effect executors take `(ctx, effect)`.**
Now `(effect, ctx)` ([Actor.ts#L444](framework/Actor.ts#L444)); every other handler in the framework is `(ctx, input)`.
One argument order across the ladder. **Pick: a.**

**109. Server-side `lifecycle:` becomes `hooks:`.**
Now: the contract has `lifecycle: [Hibernate.after(…)]` (policies, data) and the server file has `lifecycle:
[Chat.onWake(…)]` (hooks, code) — the same key for two different things ([Chat.server.ts#L44](example/Chat.server.ts#L44)).
Decision 11 put hooks in the server file; it did not require the key name. **Pick: a.**

**110. Request/reply inside a turn is a *readable* type error.**
Verified: `InsideTurn<R>` turns `Effect<…, …, Actors | CurrentCaller>` used in a handler into a literal type
`"Request/reply inside a turn is not allowed: use ctx.actors.get(Other, id).Command.send(...)"`. Decisions 12/13 gain a
message instead of a generic "not assignable". **Pick: a.**

**111. `Actors` is `{ get, deadLetters }`; internals move to `ActorRuntime`.**
Now: `Actors` exposes `sharding / database / engine` ([Actor.ts#L626-L628](framework/Actor.ts#L626-L628)). Users never
need Cluster's `Sharding`. `ActorRuntime` (not on the public entry, used by `Actor.serve`, workflows and the test
harness) keeps them. **Pick: a.**

**112. Logs and spans come from the framework; examples stop interpolating ids.**
`turn()` wraps the handler in `Effect.withSpan("durable-actors/turn", { attributes: { actor, id, tenant, command,
commandId, caller, trigger, replayed } })` and `Effect.annotateLogs({ actor, id, commandId })`; executors and queries
likewise. `Actor.make({ spanAttributes })` passes through to `Entity.toLayer`. Handlers then log
`Effect.logInfo("email sent")` instead of `` `email to ${effect.to} for ${ctx.id}` ``. **Pick: a.**

### Clients

**113. The client generates the commandId, once, and keeps it across retries (correctness).**
Now: `CommandId` defaults to `undefined` = "server generates" ([Actor.ts#L100](framework/Actor.ts#L100)). With
`Delivery.retry`, a resend after commit-unknown is a *new* envelope with a *new* server-generated id, so the receipt
does not match and the command applies twice. Proposal: the handle method mints a UUID when it *runs* (inside
`Effect.suspend`, so the same Effect value re-run mints again, but the `Delivery.retry` loop around one run reuses
it); `Actor.commandId(key)` overrides (decision 15); the Promise client does the same and sends `x-command-id`;
`turn()` never generates. Raw HTTP callers that omit the header get one minted by the server and a warning in
`/llms.txt`: "send `x-command-id` to make retries safe". Azure: repeatability ids are SDK-generated and stable
across retries; Stripe: the key is reused on retry. **Pick: a** (this one is a bug, not taste).

**114. Promise client options.**
```ts
const chat = Chat.client({ baseUrl, headers: { authorization: `Bearer ${token}` }, timeoutInMs: 10_000, fetch })
const msg = await chat.get(roomId).SendMessage({ body }, { commandId: key, signal })      // trailing options
for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) …    // AsyncIterable
```
Thrown errors are the contract's `Schema.TaggedError` instances (decision 79) plus `InvalidInput | Unauthorized |
TransportError`. **Pick: a.**

**115. `Actor.toolkit` and `Actor.mcp`.**
```ts
export const AgentTools = Actor.toolkit([Chat, Counter])          // Effect Toolkit; requires descriptions (96)
// tools: Chat_SendMessage, Chat_Recent, Counter_Increment, … ; params = { id: RoomId } & input
// failureMode: "return" → declared errors come back as { _tag, ...fields, message } tool results, not protocol errors
export const AgentToolsLive = AgentTools.layer                     // Layer<…, never, Actors | CurrentCaller>
export const McpLive = Actor.mcp({ actors: [Chat, Counter], name: "durable-actors", version: "1" })  // McpServer.toolkit
```
Internal commands (95) and streams are excluded; queries become read-only tools; every tool response is capped by
`Actor.toolkit([...], { maxOutputBytes })`. Anthropic: namespace tools, `_id` params, actionable error text. **Pick: a.**

**116. `Actor.serve` also serves documentation.**
`/llms.txt` (H1, blockquote, `## Actors`, `## Errors`, `## Optional`), `/openapi.json` (from the Rpc groups, with
`description` and `deprecated`), `/actors/{name}.md` (one page per actor: commands, inputs, errors, curl example with
`x-command-id`). Off by default? No: on by default, `docs: false` to disable. **Pick: a.**

**117. `deprecated: true` on a command, query or stream** → `OpenApi.Deprecated`, tool description prefix, `llms.txt`
section. **Pick: a.**

**118. Configuration is Effect configuration.**
```ts
Database.layer({ url: Redacted.make("postgres://…"), neki: false, migrate: "auto" })
Database.layerConfig()   // DATABASE_URL (redacted), DATABASE_NEKI, DATABASE_MIGRATE
Topology.fromConfig()    // ACTORS_TOPOLOGY=single|http|k8s, ACTORS_LISTEN_*, ACTORS_ADVERTISE_*
```
`url: string` today ([Actor.ts#L128](framework/Actor.ts#L128)) prints secrets in error output. **Pick: a.**

**119. Workflows return a run handle, not a string.**
Now: `Onboard.start(input)` returns `Effect<string>`. Proposal:
```ts
const run = yield* Onboard.start({ userId, roomId })      // Effect<WorkflowRun<Out, Err>, never, Actors | CurrentCaller>
run.id                                                    // ExecutionId (branded)
yield* run.result                                         // Effect<Out, Err | WorkflowInterrupted>
yield* run.poll                                           // Effect<Option<Exit<Out, Err>>>
yield* run.interrupt
const again = yield* Onboard.run(run.id)                  // rehydrate from an id
```
Azure `begin*` pollers; compiles to `WorkflowEngine.poll / interrupt / resume`. Decision 24 keeps `execute` and
`start`; `start`'s return type changes. **Pick: a.**

### Testing

**120. A bound harness plus `ActorTest.layer({ as })`.**
Now: `test.inspect(Chat, id)`, `test.turns.of(Chat, id)`, `test.effects.pending(Chat, id)` repeat `(Chat, id)` and
`ActorTest.layer({ caller: { _tag: "User", principal: member } })` spells the union by hand. Proposal (flat API stays):
```ts
ActorTest.layer({ as: member })                    // Principal | Caller; default Anonymous (decision 81)
const room = yield* test.actor(Chat, id)           // { handle, ref, inspect, turns, next, effects, rows, crash, pause }
yield* room.handle.SendMessage({ body: "hi" })
expect((yield* room.inspect).events).toHaveLength(1)
yield* room.crash({ at: "beforeCommit", command: "SendMessage" })
```
**Pick: a.**

### Documentation for agents

**121. Ship `llms.txt`, an AGENTS.md snippet and a skill.** `packages/durable-actors/llms.txt` (mirrors the served
one), `AGENTS.md` block with `bunx tsc --noEmit -p …` / `bun test` commands, and
`skills/building-durable-actors/SKILL.md` (≤ 500 lines, third-person description, a contract/server/test template
and the ten rules: branded ids, `internal`, descriptions, intents not calls in turns, `x-command-id`, …). **Pick: a.**

**122. Examples are single-operation and run in CI.** Each `README` snippet is one operation copied verbatim from a
file under `examples/` that `bun test` executes against PGlite. (Azure: "copy-pasteable, tested".) **Pick: a.**

**123. `@since` / `@category` JSDoc on every export**, categories `constructors | contexts | policies | errors |
clients | testing`, so generated docs and `llms.txt` sections come from one source. **Pick: a.**

**124. Kept after review (no change).** `(ctx, input)` handler order; `X.of(handlers, { hooks, effects })`; declared
`errors` (not inferred) — inference would leak implementation errors into the contract and the Rpc error schema needs
the list anyway; `Actor.commandId` pipe for user-supplied keys; `Turn` ambient service; `Hibernate.after`; separate
`commands / queries / streams` arrays; `test.faults.*` names (87); `TurnHooks` sealed (88).

## 3. What changes where

| Item | `Actor.ts` | `Testing.ts` | examples | DECISIONS |
| --- | --- | --- | --- | --- |
| 89–91 | `GetOptions.as`, `get` R, `Caller.System.onBehalfOf`, `ctx.principal`, `layer({ tenant })` | `layer({ as })` | usage, tests, Chat.server | 8, 35, 36, 81 (extend) |
| 92–94 | `serve({ auth })` required, `Actor.auth.none/bearer/header`, key rename, `id` required | | usage, sdk.test, Counter | 6 (enforce) |
| 95–102 | `internal`, `description`, `AnyError`, `Policy<C>`, `after`, `ActorRef`, `Policy` ns, `toQueryLayer` | | AgentSession, Chat, Chat.queries | 5, 22, 49c (names) |
| 103–104 | `ScopedRead`, `Scoped.one/all/insert/upsert` | | Counter.server, Chat.server | 9, 10 (sugar) |
| 105–107 | error classes, `InvalidInput`, `TransportError`, `x-request-id` | `serve` | sdk.test | 26 (extend) |
| 108–112 | executors `(ctx, effect)`, `hooks`, `InsideTurn`, `Actors` shape, spans | | all server files | 11 (key name), 12/13 (message) |
| 113–115 | commandId minting, `client(options)`, `toolkit`, `mcp` | `serve` | AgentSession.client, usage | 15, 20, 40 |
| 116–119 | `serve({ docs })`, `deprecated`, `layerConfig`, `Topology.fromConfig`, `WorkflowRun` | | usage, Onboard | 24 (start type) |
| 120–123 | | `test.actor` | all tests | 62–88 (extend) |

## 4. The framework in full force (proposed shape)

### `Principal.ts`
```ts
import { Schema } from "effect"

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
export const OrgId = Schema.String.pipe(Schema.brand("OrgId"))
export type OrgId = typeof OrgId.Type

declare module "durable-actors" {
  interface Principal {
    readonly userId: UserId
    readonly orgId: OrgId
    readonly roles: ReadonlyArray<"member" | "admin">
  }
}
export const PrincipalSchema = Schema.Struct({ userId: UserId, orgId: OrgId, roles: Schema.Array(Schema.Literals(["member", "admin"])) })
```

### `Chat.ts` — contract (clients import this)
```ts
import { Schedule, Schema } from "effect"
import { Actor, Delivery, Effects, Events, Hibernate } from "durable-actors"

export const RoomId = Schema.String.pipe(Schema.brand("RoomId"))
export type RoomId = typeof RoomId.Type

export class Message extends Schema.Class<Message>("Message")({
  id: Schema.String, authorId: Schema.String, body: Schema.String, sentAt: Schema.DateTimeUtc
}) {}

// declared errors: yieldable, tagged, carry their own HTTP status (default 422)
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.Literals(["empty", "too_long"])
}) {
  override get message() { return `message rejected: ${this.reason}` }
}
export class NotAMember extends Schema.TaggedError<NotAMember>()("NotAMember", { userId: UserId }, { httpApiStatus: 403 }) {
  override get message() { return `${this.userId} is not a member of this room` }
}

export class MessageAdded extends Schema.TaggedClass<MessageAdded>()("MessageAdded", { message: Message }) {}
export class EmailDelivered extends Schema.TaggedClass<EmailDelivered>()("EmailDelivered", { messageId: Schema.String }) {}
export class SendEmail extends Schema.TaggedClass<SendEmail>()("SendEmail", { messageId: Schema.String, to: Schema.String, body: Schema.String }) {}

export const messages = Actor.table("chat_messages", { id: "text", author_id: "text", body: "text", sent_at: "timestamptz" })

export const SendMessage = Actor.command("SendMessage", {
  description: "Append a message to the room. The caller must be a member.",
  input: { body: Schema.String },                 // struct fields → object argument
  output: Message,
  errors: [InvalidMessage, NotAMember]
})
export const MarkDelivered = Actor.command("MarkDelivered", {
  description: "Executor callback: the email for a message was delivered.",
  input: { messageId: Schema.String }
})
export const Recent = Actor.query("Recent", {
  description: "The last `limit` messages, oldest first.",
  input: { limit: Schema.Number },
  output: Schema.Array(Message),
  errors: [NotAMember]
})
export const Transcript = Actor.stream("Transcript", {
  description: "Live feed of messages from now on.",
  output: Message,
  errors: [NotAMember]
})

export const Chat = Actor.make("Chat", {
  description: "A chat room. One actor per room; messages are rows, membership is checked per call.",
  id: RoomId,
  commands: [SendMessage, MarkDelivered],
  internal: [MarkDelivered],                      // reachable from executors / turns only
  queries: [Recent],
  streams: [Transcript],
  events: [MessageAdded, EmailDelivered],
  effects: [SendEmail],
  tables: [messages],
  lifecycle: [
    Hibernate.after("5 minutes"),
    Events.keep("30 days"),
    Delivery.retry(Schedule.exponential("100 millis").pipe(Schedule.compose(Schedule.recurs(5)))),
    Effects.retry(Schedule.spaced("1 second").pipe(Schedule.compose(Schedule.recurs(10))))
  ]
})
```

### `Chat.server.ts` — handlers, hooks, executors
```ts
import { Context, Effect, Option, Ref, Stream } from "effect"
import type { ActorRef, Caller } from "durable-actors"
import { Chat, InvalidMessage, Message, MessageAdded, EmailDelivered, messages, NotAMember, SendEmail } from "./Chat.ts"
import { Counter, CounterId } from "./Counter.ts"
import { Mailer } from "./Mailer.ts"

export class RoomAccess extends Context.Service<RoomAccess, {
  readonly requireMember: (caller: Caller, room: ActorRef) => Effect.Effect<void, NotAMember>
}>()("app/RoomAccess") {}

export const ChatLive = Chat.toLayer(
  Effect.gen(function*() {
    const access = yield* RoomAccess
    const mailer = yield* Mailer
    const typing = yield* Ref.make(new Set<string>())        // per-activation state: a closure

    return Chat.of({
      SendMessage: Effect.fn(function*(ctx, input) {
        yield* access.requireMember(ctx.caller, ctx.ref)
        const body = input.body.trim()
        if (body.length === 0) return yield* new InvalidMessage({ reason: "empty" })
        if (body.length > 4000) return yield* new InvalidMessage({ reason: "too_long" })

        const authorId = Option.getOrElse(ctx.principal, () => "system")
        const message = new Message({ id: ctx.commandId, authorId, body, sentAt: ctx.now })
        yield* ctx.rows(messages).insert({ id: message.id, author_id: authorId, body, sent_at: ctx.now })
        yield* ctx.emit(new MessageAdded({ message }))
        yield* ctx.perform(new SendEmail({ messageId: message.id, to: "room@example.com", body }))
        yield* ctx.actors.get(Counter, CounterId.make("messages-sent")).Increment.send(1)   // intent, same transaction
        yield* Effect.logInfo("message appended")                                          // actor/id/commandId annotated by turn()
        return message
      }),
      MarkDelivered: (ctx, { messageId }) => ctx.emit(new EmailDelivered({ messageId })),
      Transcript: (ctx) =>
        Stream.fromEffect(access.requireMember(ctx.caller, ctx.ref)).pipe(
          Stream.flatMap(() => ctx.events(MessageAdded)),        // stream ctx can read events, not rows
          Stream.map((e) => e.event.message)
        )
    }, {
      hooks: [
        Chat.onWake(() => Ref.set(typing, new Set())),
        Chat.onEffectFailed((ctx, effect, cause) => Effect.logError("effect dead-lettered", cause))
      ],
      effects: {
        SendEmail: (ctx, effect) =>
          mailer.send(effect.to, effect.body).pipe(
            Effect.andThen(ctx.self.MarkDelivered.send({ messageId: effect.messageId }))   // result returns as an intent
          )
      }
    })
  })
)
```

### `Chat.queries.ts` — read side, `Database` only
```ts
export const ChatReads = Chat.toQueryLayer({
  Recent: Effect.fn(function*(ctx, { limit }) {
    yield* access.requireMember(ctx.caller, ctx.ref)
    const rows = yield* ctx.rows(messages).all({ orderBy: "sent_at", limit })       // ScopedRead: no insert here
    return rows.map((r) => new Message({ id: r.id, authorId: r.author_id, body: r.body, sentAt: r.sent_at }))
  })
})
```

### `Onboard.ts` / `Onboard.server.ts` — workflow with a run handle
```ts
export const Onboard = Actor.workflow("Onboard", {
  description: "Create the user's first room, wait for their first message, nudge after a day.",
  input: { userId: UserId, roomId: RoomId },
  output: Schema.Struct({ nudged: Schema.Boolean }),
  errors: [NotAMember],
  idempotencyKey: ({ userId }) => userId
})

export const OnboardLive = Onboard.toLayer(Effect.fn(function*(ctx, { userId, roomId }) {
  const room = yield* ctx.actors.get(Chat, roomId)                                  // System("workflow", onBehalfOf: starter)
  yield* room.SendMessage({ body: "welcome" })
  const first = yield* ctx.waitFor(room.events(MessageAdded, { after: 0 }), (e) => e.event.message.authorId === userId)
    .pipe(Effect.timeoutOption("1 day"), ctx.activity("wait-first-message"))
  if (Option.isSome(first)) return { nudged: false }
  yield* ctx.activity("nudge", Mailer.send(userId, "still there?"))
  return { nudged: true }
}))
```

### `usage.ts` — Effect client
```ts
export const program = Effect.gen(function*() {
  const room = yield* Chat.get(RoomId.make("room-1"))                 // caller: ambient (see bottom)
  const msg = yield* room.SendMessage({ body: "hi" })                 // E = InvalidMessage | NotAMember | CommandConflict | ActorUnavailable
  yield* room.SendMessage({ body: "hi again" }).pipe(Actor.commandId(httpIdempotencyKey))
  const recent = yield* room.Recent({ limit: 20 })                    // E = NotAMember (no cluster hop)
  const live: Stream.Stream<Message, NotAMember | ActorUnavailable> = room.Transcript()

  const admin = yield* Chat.get(RoomId.make("room-1"), { as: adminPrincipal })
  yield* admin.SendMessage({ body: "pinned" })

  const run = yield* Onboard.start({ userId: alice.userId, roomId: RoomId.make("room-1") })
  const outcome = yield* run.result                                   // Effect<{ nudged }, NotAMember | WorkflowInterrupted>
  return { msg, recent, live, outcome, runId: run.id }
}).pipe(Actor.as(alice))
```

### `browser.ts` — Promise client
```ts
const chat = Chat.client({ baseUrl: "https://actors.example.com", headers: { authorization: `Bearer ${token}` }, timeoutInMs: 10_000 })
export const send = (roomId: RoomId, body: string, signal?: AbortSignal) =>
  chat.get(roomId).SendMessage({ body }, { signal })                  // commandId minted here, reused on retry
export const follow = async function*(roomId: RoomId, signal: AbortSignal) {
  for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) yield e.event.message
}
// thrown: InvalidMessage | NotAMember | CommandConflict | ActorUnavailable | InvalidInput | Unauthorized | TransportError
```

### `agent.ts` — tools and MCP
```ts
export const AgentTools = Actor.toolkit([Chat, Counter], { maxOutputBytes: 32_000 })
// Chat_SendMessage({ id: RoomId, body }), Chat_Recent({ id, limit }), Counter_Increment({ id, n }) …
export const AgentToolsLive = AgentTools.layer          // Layer<Toolkit handlers, never, Actors | CurrentCaller>
export const McpLive = Actor.mcp({ actors: [Chat, Counter], name: "durable-actors", version: "1" })
```

### `server.ts` — runtime, auth, docs, config
```ts
export const AppLive = Layer.mergeAll(ChatLive, ChatReads, CounterLive, CounterReads, OnboardLive, NightlyLive).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive)),
  Layer.provideMerge(Actor.serve({
    actors: [Chat, Counter],
    workflows: [Onboard],
    auth: Actor.auth.bearer((token) => Sessions.verify(token)),     // Effect<Principal, Unauthorized, Sessions>
    docs: true                                                       // /llms.txt, /openapi.json, /actors/Chat.md
  })),
  Layer.provide(Actor.layer({ principal: PrincipalSchema, tenant: (p) => TenantId.make(p.orgId), topology: Topology.fromConfig() })),
  Layer.provide(Database.layerConfig())                              // DATABASE_URL (Redacted), DATABASE_NEKI, DATABASE_MIGRATE
)
```

### `Chat.test.ts`
```ts
const TestLive = Layer.mergeAll(ChatLive, ChatReads, CounterLive).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessTest, MailerTest)),
  Layer.provideMerge(ActorTest.layer({ as: member }))
)

it.layer(TestLive)("Chat", (it) => {
  it.effect("a member's message is a row, an event, a held effect and a counter intent", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const room = yield* test.actor(Chat, RoomId.make("r1"))
      const msg = yield* room.handle.SendMessage({ body: "hi" })
      expect(msg.authorId).toBe(member.userId)

      const state = yield* room.inspect
      expect(state.events.map((e) => e.event._tag)).toEqual(["MessageAdded"])
      expect((yield* room.effects.pending).map((p) => p.effect._tag)).toEqual(["SendEmail"])
      expect((yield* room.rows(messages)).length).toBe(1)

      yield* test.effects.run                                              // executor → MarkDelivered intent → EmailDelivered
      yield* test.settle
      expect((yield* room.inspect).events.map((e) => e.event._tag)).toEqual(["MessageAdded", "EmailDelivered"])
    }))

  it.effect("a stranger is rejected with a receipt and no event", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const room = yield* test.actor(Chat, RoomId.make("r2"), { as: stranger })
      const denied = yield* room.handle.SendMessage({ body: "hi" }).pipe(Effect.flip)
      expect(denied).toEqual(new NotAMember({ userId: stranger.userId }))
      expect((yield* room.inspect).events).toHaveLength(0)
    }))

  it.effect("a crash before commit applies exactly once after redelivery", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const room = yield* test.actor(Chat, RoomId.make("r3"))
      yield* room.crash({ at: "beforeCommit", command: "SendMessage", times: 1 })
      yield* room.handle.SendMessage({ body: "once" })
      expect((yield* room.turns).map((t) => t.trigger)).toEqual(["call", "redelivery"])
      expect((yield* room.rows(messages)).length).toBe(1)
    }))

  it.effect("the browser cannot call an internal command", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const { http } = yield* test.serve({ actors: [Chat], auth: Actor.auth.none })
      const res = yield* http.post("/actors/Chat/r1/MarkDelivered", { messageId: "m" })
      expect(res.status).toBe(404)
    }))
})
```

### `llms.txt` (served and shipped)
```
# durable-actors

> Durable actors on one relational database, built on Effect. Contract files declare commands, queries,
> streams, events and effects; server files implement them; every command is one transaction.

## Actors
- [Chat](/actors/Chat.md): A chat room. Commands: SendMessage. Queries: Recent. Streams: Transcript.
- [Counter](/actors/Counter.md): …

## Rules
- Send `x-command-id` (any UUID) with every command and reuse it when you retry.
- Declared errors return 4xx with `{ _tag, ...fields, message }`; `ActorUnavailable` (503) is retryable.

## Optional
- [OpenAPI](/openapi.json)
```

## 5. Pick list

Everything above defaults to **a**. Answer only where you disagree.

| # | a | b |
| --- | --- | --- |
| 89 | ambient `Actor.as` on `get` *and* `get(id, { as })` | `{ as }` only |
| 90 | `Actor.layer({ tenant })` derivation | keep per-call `Actor.tenant` only |
| 91 | `onBehalfOf` + `ctx.principal` | keep `Caller.principal(caller)` only |
| 92 | `auth` required, `Actor.auth.none` explicit | keep optional |
| 94 | `id` required | keep `Schema.String` default |
| 95 | `internal: [...]` | separate `Actor.internalCommand` constructor |
| 96 | optional `description`, toolkit requires it | required everywhere |
| 97 | default 422 for declared errors | require `httpApiStatus` on every error |
| 101 | add `Policy` namespace | leave ten top-level exports |
| 102 | `toQueryLayer` / `queries` | keep `queries()` / `queryDefs` |
| 104 | `one / all / insert / upsert` sugar | pass-throughs only |
| 109 | server key `hooks:` | keep `lifecycle:` on both sides |
| 113 | client mints commandId, stable across retries | keep server-generated (double-apply on retry) |
| 116 | docs endpoints on by default | opt-in `docs: true` |
| 119 | `WorkflowRun` handle | keep `start → string` |
| 120 | `test.actor` + `layer({ as })` | flat API only |
| 125 | keyed state in `actor_state`, sync reads | one JSONB blob (c: no state) |
| 126 | `Actor.connection` sessions | streams + events only |
| 127 | `run` loop on the activation | workflows only |
| 129 | 1 s poll + sleep-then-poll + `NOTIFY` | poll interval only |
| 130 | SSE events + OpenAPI + `durable-actors/react` | OpenAPI only |
| 131 | `Actor.blob` | `bytea` table, no helper |
| 132 | no `Actor.job`; add `Actor.singleton` | neither |
| 133 | `Actor.ephemeral` kind | `Actor.make(…, { durable: false })` |

## 6. Closing the gaps against Rivet / Durable Objects (125–131)

Context: with keyed state (125) the remaining places we are behind are realtime connections, long-running
loops, placement, timer precision, client reach and large blobs. The three structural weaknesses (commit
latency per turn, one database as failure domain, isolation by predicate) are not addressed here; they
follow from F1 and are the price of the design. rc.116 facts used: `entityMessagePollInterval` defaults to
10 s; `Sharding.pollStorage` forces a storage read; the idle reaper only counts an entity idle when
`activeRequests.size === 0`, and a forked stream is an active request until it ends; `ClusterSchema.ShardGroup`
is `(entityId) => string` and `ShardingConfig.shardGroups` selects which groups a runner serves;
`RpcServer.layerProtocolWebsocket`, `RpcClient.layerProtocolSocket`, `HttpServerRequest.upgradeChannel`.

**125. Keyed state next to tables** (from the follow-up review; supersedes the "no state" half of 9a).
`state: { key: Schema }` on `Actor.make`; rows in `actor_state(tenant_id, actor_id, actor, key, value jsonb)`,
same shard key as every `actor_*` table; loaded after the generation fence inside the turn transaction (one
`SELECT`), synchronous reads (`ctx.state.count: number`), `yield* ctx.state.set({ count })` writes only dirty
keys at commit; read-only snapshot on query/stream/wake contexts; `State.maxBytes("64 KiB")` default policy
(exceeding is a defect: "move `x` to a table"); decode failure on load is a defect naming the key. Rivet and DO
both had to add a relational store next to their blob; we add a small keyed store next to our tables.

```ts
export const Counter = Actor.make("Counter", {
  id: CounterId,
  state: { count: Schema.Number, lastReset: Schema.optionalKey(Schema.DateTimeUtc) },
  commands: [Increment, Reset], queries: [GetCount]
})
Increment: (ctx, n) => ctx.state.set({ count: ctx.state.count + n }).pipe(Effect.as(ctx.state.count + n))
GetCount:  (ctx)    => Effect.succeed(ctx.state.count)          // query: committed snapshot, no set
```
Later optimization, not a decision: the activation may cache the last snapshot with the generation it read it
under and skip the `SELECT` when the fence returns the same generation. **Pick: a** (keyed, sync reads).
Alt b: one JSONB blob per actor. Alt c: keep 9a, no state.

**126. Connections: typed bidirectional sessions on the activation.**
Gap: DO WebSocket hibernation and Rivet `c.conn` / `broadcast` / `useActor`. Proposal: a fourth contract kind.

```ts
// Chat.ts
export class Typing extends Schema.TaggedClass<Typing>()("Typing", { userId: UserId }) {}
export const Live = Actor.connection("Live", {
  description: "Live room session: messages and typing indicators.",
  params: { since: Schema.optionalKey(Schema.Number) },
  server: Schema.Union([Message, Typing]),      // actor → client frames
  client: Typing,                               // client → actor frames (ephemeral signals; durable changes are commands)
  state: { typingSince: Schema.optionalKey(Schema.DateTimeUtc) },   // per-connection, in memory on the activation
  errors: [NotAMember]
})
export const Chat = Actor.make("Chat", { …, connections: [Live] })

// Chat.server.ts — runs on the activation, forked past the mailbox like a stream
Live: (ctx, params, inbound) =>
  Stream.merge(
    ctx.events(MessageAdded, { after: params.since ?? 0 }).pipe(Stream.map((e) => e.event.message)),
    inbound.pipe(Stream.tap((t) => ctx.connections.broadcast(t, { except: ctx.conn.id })), Stream.drain)
  ).pipe(Stream.ensuring(ctx.connections.broadcast(new Left({ userId: ctx.conn.userId }))))

// inside a command: broadcast is queued and flushed after COMMIT, like emit but not persisted
SendMessage: Effect.fn(function*(ctx, input) { …; yield* ctx.connections.broadcast(new Typing(…)) })
// presence
Members: (ctx) => ctx.connections.list.pipe(Effect.map((cs) => cs.map((c) => c.caller)))
```
Runtime: the client opens a WebSocket to any HTTP runner (`RpcServer.layerProtocolWebsocket`); the runner
subscribes to the actor over the existing non-persisted forked stream rpc and forwards inbound frames as
non-persisted `Live$frame` rpcs correlated by connection id (`Rpc.fork`, outside the mailbox). `ctx.connections`
is an in-memory registry in the activation closure. An open connection keeps the actor awake (verified: forked
requests stay in `activeRequests`); DO-style "hibernate with sockets attached" is not offered. Promise client:
`const live = chat.get(id).Live({ since }, { signal }); for await (const f of live) …; live.send(new Typing(…))`.
**Pick: a.** Alt b: no connections; streams + events only.

**127. `run`: a long-lived activation loop that stays inside the transaction rule.**
Gap: Rivet `run: async (c) => for await (const msg of c.queue.iter())`. Proposal: `X.of(handlers, { run })`.

```ts
run: (ctx) =>                       // started on wake, interrupted on sleep; no db, no rows: durable effects are intents
  ctx.events(PromptQueued, { after: ctx.state.processedUpTo }).pipe(
    Stream.mapEffect((e) =>
      model.stream(e.event.prompt).pipe(
        Stream.tap((token) => ctx.connections.broadcast(new Token({ turnId: e.event.turnId, token }))),
        Stream.mkString,
        Effect.flatMap((text) => ctx.self.ModelReplied.send({ turnId: e.event.turnId, text })),
        Effect.raceFirst(ctx.events(Cancelled).pipe(Stream.filter((c) => c.event.turnId === e.event.turnId), Stream.runHead))
      )),
    Stream.runDrain
  )
```
`ctx` here is the wake context plus `events` (live, cursor-able), `state` (committed snapshot, refreshed after
each turn), `self` / `actors` intents, `connections`, `memory` (the closure). The loop never opens a transaction;
`ModelReplied` is a normal turn that advances `processedUpTo`, so a crash replays from the cursor. A `run` fiber
does not keep the actor awake; use `ctx.self.Tick.after(...)` if it must. **Pick: a.** Alt b: workflows only.

**128. Placement: compute follows the tenant's shard group.**
Gap: DO places objects near the first request; Rivet has regions. `Actor.layer({ shardGroup: (tenant) => … })`
already exists; make it first-class:

```ts
Actor.layer({ …, shardGroup: (tenant) => Regions.of(tenant) })        // ClusterSchema.ShardGroup on every entity
// runner in eu-west: ACTORS_SHARD_GROUPS=eu   (ShardingConfig.shardGroups)
```
Compute placement closes; data placement does not: every region still writes to the one database. On Neki,
shard groups can map to physical shards per region only if PlanetScale supports it (gate, not a claim).
**Pick: a.**

**129. Timer precision: milliseconds for self-armed timers, `NOTIFY` for the rest.**
Gap: `entityMessagePollInterval` is 10 s by default, so `ctx.self.Reset.after("5 seconds")` fires between 5
and 15 s. Proposal: (1) `Actor.layer({ pollInterval: "1 second" })` default; (2) after COMMIT of an intent with
`deliverAt`, the writing runner keeps an in-memory `Effect.sleep(until)` then `sharding.pollStorage`, so timers
armed by the owning runner fire on time; (3) `turn()` runs `NOTIFY actor_wake, '<shardId>'` after COMMIT and every
runner `LISTEN`s, calling `pollStorage` for shards it owns, so cross-runner intents arrive at commit + RTT rather
than at the next poll. Postgres only; on Neki (2) stands and (3) is a gate. **Pick: a.**

**130. Client reach: SSE for events, OpenAPI for languages, a React hook for browsers.**
Gap: Rivet ships JS/Python/Rust/Swift clients and `useActor`. Proposal: `Actor.serve` exposes
`GET /actors/{name}/{id}/events?after=<seq>` as Server-Sent Events (no client library needed in any language),
`/openapi.json` (116) feeds `openapi-ts` / `openapi-generator` for typed Python/Swift/Rust clients, and a
`durable-actors/react` subpath:

```ts
const room = useActor(Chat, roomId)                       // Promise client + events, suspense-free
const recent = useQuery(room.Recent, { limit: 50 })       // refetch on MessageAdded
const live = useConnection(room.Live, { since: 0 })       // frames + send
await room.SendMessage({ body })
```
**Pick: a.**

**131. Blobs: large per-actor binaries outside the state cap.**
Gap: DO/Rivet keep a CRDT document or an embedding matrix as a file in the object's SQLite. Proposal:
`Actor.blob("doc")` → `blobs: [doc]`; rows in `actor_blobs(tenant_id, actor_id, key, seq, data bytea)`; loaded
lazily inside the turn (`ctx.blob(doc).get: Effect<Option<Uint8Array>>`, `.set`, `.append(update)` for
update-log CRDTs, `.compact(merge)` from `onWake`); streamed over HTTP at `GET /actors/{name}/{id}/blobs/doc`;
exempt from `State.maxBytes`. **Pick: a.** Alt b: `Actor.table` with `bytea` and no helper.

## 7. Kinds, members, runtime: the taxonomy under `Actor.` (132–134)

The question "should there be `Actor.job` / `Actor.connection` as actor types?" comes from `Actor.` holding three
levels with nothing marking which is which: **kinds** (`make`, `workflow`, `cron`) that `toLayer` and that Cluster
places; **members** (`command`, `query`, `stream`, `table`, and proposed `connection`, `blob`) that only mean
something inside a kind; and **runtime** (`layer`, `serve`, `auth`, `as`, `tenant`, `commandId`, `toolkit`, `mcp`).
Effect's own `HttpApiEndpoint → HttpApiGroup → HttpApi` is the same three-level ladder, in three modules. Decisions
2/24/30 fixed the names under one namespace, so the fix is to make the levels visible, not to rename.

**132. Four kinds, and `Actor.job` is not one of them.**

| Kind | One per | Turn model | Compiles to | Use when |
| --- | --- | --- | --- | --- |
| `Actor.make` | id (tenant, id) | transaction per command, receipts, state/tables/events/effects | `Entity` (`Persisted: true`) | it has an identity and receives commands over time |
| `Actor.workflow` | execution (idempotency key) | durable steps, one linear run | `Workflow` + `ClusterWorkflowEngine` | a process with a start and an end: onboarding, a payment, *a job* |
| `Actor.cron` | cluster | one `execute` per tick | `ClusterCron.make` | recurring cluster-wide work |
| `Actor.singleton` (new) | cluster | one long-lived `run` | `Singleton.make(name, run, { shardGroup })` | a leader/poller/reaper that must run exactly once cluster-wide |
| `Actor.ephemeral` (new, 133) | id | in memory, no transaction, no receipts | `Entity` (`Persisted: false`, Cluster's default) | presence, cursors, game ticks, anything that may forget on restart |

A "job" is a workflow with one activity (`W.start(input)` → run handle, retries from `Activity`), a per-actor delayed
job is `ctx.self.X.after(d, input)`, and a recurring one is `Actor.cron`. A separate `Actor.job` would be a fourth
spelling of the same thing. **Pick: a** (no `Actor.job`; add `Actor.singleton`). Alt b: also no `singleton`, express
it as `Actor.cron` with a continuous `run`.

```ts
export const Reaper = Actor.singleton("Reaper", {
  description: "Purges expired receipts and events cluster-wide.",
  shardGroup: "default"
})
export const ReaperLive = Reaper.toLayer(Effect.forever(purgeOnce.pipe(Effect.delay("1 minute"))))   // R: Database
```

**133. `Actor.ephemeral`: the same contract kinds, none of the durability.**
This is the kind that closes the latency weakness for workloads that do not need durability. Same `command / query /
stream / connection` members, same handle shape, same `Actor.serve`; but no `state:`/`tables:`/`events:`/`effects:`,
no `db` on the context, no receipts, so the handle's `E` is `ErrOf<C> | ActorUnavailable` (no `CommandConflict`, no
`NotCreated`), `ctx.memory` is the only state, and `Hibernate.after` drops it. `Cron`, `Delivery.retry`, `Mailbox`,
`Commands.timeout` policies apply; `Events.keep`, `Receipts.keep`, `Effects.retry`, `Lifecycle.createdBy` are
rejected at the type level (`Policy<Kind>`).

```ts
export const Cursor = Actor.ephemeral("Cursor", {
  description: "Live cursor positions for one document. Forgets everything when idle.",
  id: DocId,
  memory: { cursors: Schema.Record(UserId, Position) },        // typed in-memory state, initial from Schema defaults
  commands: [Move],
  connections: [Live],
  lifecycle: [Hibernate.after("30 seconds"), Mailbox.capacity(1000)]
})
// Cursor.server.ts
Move: (ctx, pos) => ctx.memory.update((m) => ({ cursors: { ...m.cursors, [ctx.principalOrDie.userId]: pos } }))
                     .pipe(Effect.andThen(ctx.connections.broadcast(new Moved({ pos }))))
```
Commands still serialize through the mailbox (`concurrency: 1`), so an ephemeral actor is a single-writer in-memory
object placed by Cluster: the Rivet/DO model, opt-in per actor, with the same contracts. Testing: `ActorTest` works
unchanged (`inspect` returns `memory` instead of rows). **Pick: a.** Alt b: `Actor.make(name, { durable: false })`
(rejected by me: a flag that changes `E`, `ctx` and allowed policies is a kind, and kinds deserve a constructor).

**134. Make the levels visible without renaming.**
JSDoc `@category kinds | members | policies | runtime | clients | testing` (123) drives the generated docs and the
`llms.txt` sections; `Actor.make` and friends carry `_kind: "actor" | "ephemeral" | "workflow" | "cron" | "singleton"`
and members `_kind: "command" | "query" | "stream" | "connection" | "table" | "blob"`; the skill's first section is the
table in 132 ("which kind?"). Members never appear in `Actor.serve({ actors })` or `Actor.toolkit([...])` (type error).
**Pick: a.**
