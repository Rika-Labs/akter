# Durable Actors — DX / AX audit (v4, round 5, 2026-09-21)

> **Superseded on 2026-09-21 by decisions 151–171** where this round proposed kinds, AI adapters or served
> documentation: there is one kind (`Actor.make`, with `singleton: true` and `Cron.every` in `lifecycle`), no
> `Actor.toolkit` / `Actor.mcp` / `llms.txt` / `docs` option, `vars` instead of a `memory` declaration,
> workflows as members of their owner, framework-minted ids when no `id` is declared, one framework error
> (`ActorError` with a `reason`), and an ambient `CurrentCaller` that the edge sets per request. The findings
> below are kept as written history; each affected section carries its own note and its code blocks have been
> updated to the current spelling.

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
| Machine-readable docs come from the contract, not from prose kept in sync by hand. | llmstxt.org (rejected for this framework by decision 153: `/openapi.json` only) | 116, 121 |
| AGENTS.md carries runnable verification commands; SKILL.md ≤ 500 lines, third-person description. | agents.md, Anthropic skills | 121, 122 |
| Effect conventions: `X.make`, `X.toLayer`, `X.of`, `layer` / `layerConfig`, `Context.Service` ids `"pkg/Name"` matching the export, `Context.Reference` for ambient defaults, `Effect.withSpan("Module/op")`, `@since` / `@category` JSDoc. | effect-smol source | 93, 111, 112, 118, 123 |
| Restate: a *shared* context is structurally read-only; retry-after on retryable errors; rpc options carry the idempotency key. | Restate TS SDK | 103, 105 |
| Rivet / DO: `state` vs `vars`, connections only on action contexts, errors with `code` + public metadata, `getByName`. | Rivet actors, Durable Objects | 100, 105 |

## 2. Findings and proposals (89–124)

Format: **now** → **proposal** → source / decision touched → **pick**. Code is in the shape it would have in
`Actor.ts`; identifiers not shown are unchanged.

### Caller and tenant

**89. The caller is ambient, and bound at `get`; it is never piped into every call.**

> Refined on 2026-09-21 by decision 154: the caller reference is a `Context.Reference` defaulting to
> `Anonymous`, so no handle ever has it in `R` and nothing has to be provided at all. The default path is "the
> auth middleware set it for this request"; `X.get(id, { as })` binds an explicit caller per handle; the
> pipeable is a scoped override for scripts and tests.

Then: every handle method carried the caller as a requirement, so [usage.ts](example/usage.ts) had to pipe a
caller onto every call and streams needed `Stream.provideService(…)`. Now: `get` resolves the runtime, reads
the ambient caller once and binds it into the handle; every method is a plain Effect with `R = never`.

```ts
readonly get: (id: Id["Type"], options?: GetOptions) => Effect.Effect<Handle<…>, never, Actors>
interface GetOptions { readonly tenant?: TenantId; readonly as?: Principal | Caller }

// usage: the edge already set the caller — nothing to pass
const counter = yield* Counter.get(id)
yield* counter.Increment(1)                                   // R = never
// an explicit caller for one handle: a script, an ops tool, a test
const room = yield* Chat.get(roomId, { as: principal })
const transcript: Stream.Stream<Message, NotAMember | ActorError> = room.Transcript()
// a scoped override for a whole program (a CLI, a seed script)
yield* program.pipe(Actor.as(principal))
```
Decision 36 ("every outside call attributed") holds: attribution moves from the call to the handle, and a
handle always has a caller — `Anonymous` if nobody said otherwise. Decision 81 (Anonymous default in tests)
holds. Source: Encore (lowest-effort path is correct), Azure (credential bound at client construction).
**Pick: a** (ambient default + `{ as }`).

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
`onBehalfOf` of a system caller). A workflow start reads the ambient caller exactly like `get` does.

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
The caller reference was keyed `"durable-actors/Caller"` while the export was named differently. Effect keys
every service `"pkg/ExportName"`; error output prints the key. → `"durable-actors/CurrentCaller"`. **Pick: a.**

**94. `id` is required on `Actor.make`.**

> Superseded on 2026-09-21 by decision 164: `id` is *optional* again, but omitting it no longer means "any
> string" — it means the framework mints the id. No `id` ⇒ minted (`X.create()` returns a handle to a fresh
> UUIDv7, `X.id` is the branded `${Name}Id` schema); `id: Schema` ⇒ named (`X.get(id)`); `singleton: true` ⇒
> `X.get()` with no id. The unbranded default this finding objected to is gone either way.

Then: `id` defaulted to an unbranded string schema, and decision 6 chose branded ids, so the default silently
opted out of the decision. **Pick: a** (no unbranded default).

### Contract

**95. `internal: [...]` commands.**
Now: [AgentSession.ts#L30-L37](example/AgentSession.ts#L30-L37) exposes `ModelReplied` and `ToolFinished`
(results of effect executors) on the outside handle, the Promise client and HTTP: a browser can
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
absent from `Handle`, `PromiseHandle` and HTTP (type-level `Exclude<Cs[number], Is[number]>`,
verified), and `turn()` rejects a non-System caller with a defect. **Pick: a.**

**96. `description` on actors, commands, queries, streams, workflows.**

> Refined on 2026-09-21 by decision 153: descriptions stay, and the only consumer is `/openapi.json` (plus
> humans reading the contract). There is no toolkit to gate, so the "type error without a description"
> proposal has nothing to attach to; the examples describe every public member by convention.

Optional string. It flows to `OpenApi.Description` on the Rpc and to the generated OpenAPI document, which is
what an agent's tool layer is built from. A description is the one thing every tool-use guide insists on, so
write one for every member a client can call.

```ts
export const SendMessage = Actor.command("SendMessage", {
  description: "Append a message to the room. Fails with NotAMember if the caller is not in the room.",
  input: { body: Schema.String }, output: Message, errors: [InvalidMessage, NotAMember]
})
```
**Pick: a** (optional, by convention everywhere public). Alt b: required by the type.

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
Now: an `address` field on the handle and on `ctx`, `Caller.System.actor`, and app services like `RoomAccess.requireMember(caller,
room: EntityAddress)` all import `effect/unstable/cluster`. Proposal: `ActorRef = { actor: string; tenant: TenantId;
id: string }` as a `Schema.Class` (serializable, printable, usable as a map key via `ActorRef.key(ref)`), exposed as
`handle.ref` / `ctx.ref`; `EntityAddress` stays internal. **Pick: a.**

**101. `Policy` namespace, individual exports kept.**
`Hibernate`, `Mailbox`, `Defects`, `Delivery`, `Effects`, `Commands`, `Receipts`, `Events`, `Cron`, `Lifecycle` are
ten top-level exports next to `Actor`; an agent typing `Actor.` cannot find them. Add `Policy = { Hibernate, … }`
(re-export) and give it its own `@category` in the generated docs. Names from decisions 21–23/30 unchanged. `Effects.retry` reads oddly next to
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

> Superseded on 2026-09-21 by decision 167: the separate classes below collapsed into **one** framework error,
> `ActorError { reason, isRetryable, retryAfter, … }` with `reason` in
> `ActorUnavailable | MailboxFull | Timeout | CommandConflict | NotCreated | Unauthorized | InvalidInput | TransportError`.
> Handles are typed `ActorError.Of<…>`, narrowed per method, and call sites use
> `Effect.catchReasons("ActorError", { NotCreated: …, … })`. Note that `catchReasons` without an `orElse` keeps
> the full error in `E`: exhaustive handling at a call site needs an `orElse`. Everything this finding asked
> for — actionable `message`, literal-union `reason`, `retryAfter`, HTTP status — is on that one error.

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
Verified: `InsideTurn<R>` turns an `Effect<…, …, Actors>` used in a handler into a literal type
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
`turn()` never generates. Raw HTTP callers that omit the header get one minted by the server; the OpenAPI
description of the header says "send `x-command-id` to make retries safe". Azure: repeatability ids are SDK-generated and stable
across retries; Stripe: the key is reused on retry. **Pick: a** (this one is a bug, not taste).

**114. Promise client options.**
```ts
const chat = Chat.client({ baseUrl, headers: { authorization: `Bearer ${token}` }, timeoutInMs: 10_000, fetch })
const msg = await chat.get(roomId).SendMessage({ body }, { commandId: key, signal })      // trailing options
for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) …    // AsyncIterable
```
Thrown errors are the contract's `Schema.TaggedError` instances (decision 79) plus `InvalidInput | Unauthorized |
TransportError`. **Pick: a.**

**115. A generated tool surface (`toolkit` / MCP).**

> Superseded on 2026-09-21 by decision 153: there is **no AI-specific surface**. No `Actor.toolkit`, no
> `Actor.mcp`. The primitives are what make agents easy to build — typed contracts, events with a cursor,
> effects with dead letters, workflows with `waitFor`, connections — and `/openapi.json` is what a tool layer
> is generated from, in any language, by tooling we do not own.

The proposal was a generated Effect `Toolkit` (one tool per public command/query, `Actor_Command` names, the id
as a parameter, declared errors returned as tool results rather than protocol errors) plus an MCP server over
the same list. What we ship instead: the OpenAPI document, and an actor whose `run` loop and workflow members
make the *agent itself* a durable actor (see [example/CodingAgent.ts](example/CodingAgent.ts)).

**116. `Actor.serve` also serves documentation.**

> Superseded on 2026-09-21 by decision 153: `Actor.serve({ actors, auth, openapi?, path? })` serves the actors
> and `/openapi.json`. There is no `docs` option, no `llms.txt` and no per-actor markdown page — one generated
> artifact that cannot drift, instead of three.

The proposal was a documentation bundle at the edge: an `llms.txt` index, the OpenAPI document, and a markdown
page per actor with curl examples. Only the middle one survived. **Pick: OpenAPI only.**

**117. `deprecated: true` on a command, query or stream** → `OpenApi.Deprecated` in the generated document.
**Pick: a.**

**118. Configuration is Effect configuration.**
```ts
Database.layer({ url: Redacted.make("postgres://…"), neki: false, migrate: "auto" })
Database.layerConfig()   // DATABASE_URL (redacted), DATABASE_NEKI, DATABASE_MIGRATE
Topology.fromConfig()    // ACTORS_TOPOLOGY=single|http, ACTORS_LISTEN_*, ACTORS_ADVERTISE_*
```
`url: string` today ([Actor.ts#L128](framework/Actor.ts#L128)) prints secrets in error output. **Pick: a.**

**119. Workflows return a run handle, not a string.**

> Refined on 2026-09-21 by decision 158: a workflow is a *member* of the actor that owns it, so it is started
> on that actor's handle (`user.Onboard.start(input, { key })`), rehydrated with `user.Onboard.run(key)`, and
> started from inside a turn as an intent (`ctx.self.Onboard.start(input, { key })`). The run handle below is
> unchanged.

```ts
const user = yield* User.get(alice.userId)
const run = yield* user.Onboard.start({ roomId }, { key: roomId })   // one live run per (owner, key)
run.id                                                    // ExecutionId (branded)
run.key
yield* run.result                                         // Effect<Out, Err | WorkflowInterrupted>
yield* run.poll                                           // Effect<Option<Exit<Out, Err>>>
yield* run.interrupt
const again = yield* user.Onboard.run(roomId)             // rehydrate: Option<WorkflowRun<…>>
```
Azure `begin*` pollers; compiles to `WorkflowEngine.poll / interrupt / resume`. Decision 24's `start` keeps its
name; its return type changes. **Pick: a.**

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

**121. Ship an AGENTS.md snippet and a skill.**

> Superseded in part on 2026-09-21 by decision 153: no `llms.txt` ships and none is served. The AGENTS.md
> snippet and the skill stay; the generated `/openapi.json` is the machine-readable artifact.

An `AGENTS.md` block with `bunx tsc --noEmit -p …` / `bun test` commands, and
`skills/building-durable-actors/SKILL.md` (≤ 500 lines, third-person description, a contract/server/test template
and the ten rules: branded ids, `internal`, descriptions, intents not calls in turns, `x-command-id`, …). **Pick: a.**

**122. Examples are single-operation and run in CI.** Each `README` snippet is one operation copied verbatim from a
file under `examples/` that `bun test` executes against PGlite. (Azure: "copy-pasteable, tested".) **Pick: a.**

**123. `@since` / `@category` JSDoc on every export**, categories `constructors | contexts | policies | errors |
clients | testing`, so the generated API docs come from one source. **Pick: a.**

**124. Kept after review (no change).** `(ctx, input)` handler order; `X.of(handlers, { hooks, effects })`; declared
`errors` (not inferred) — inference would leak implementation errors into the contract and the Rpc error schema needs
the list anyway; `Actor.commandId` pipe for user-supplied keys; `Turn` ambient service; `Hibernate.after`; separate
`commands / queries / streams` arrays; `test.faults.*` names (87); `TurnHooks` sealed (88).

## 3. What changes where

| Item | `Actor.ts` | `Testing.ts` | examples | DECISIONS |
| --- | --- | --- | --- | --- |
| 89–91 | `GetOptions.as`, `get` R, `Caller.System.onBehalfOf`, `ctx.principal`, `layer({ tenant })` | `layer({ as })` | usage, tests, Chat.server | 8, 35, 36, 81 (extend) |
| 92–94 | `serve({ auth })` required, `Actor.auth.none/bearer/header`, key rename, id modes (minted / named / singleton) | | usage, sdk.test, Counter | 6 (enforce), 164 |
| 95–102 | `internal`, `description`, `AnyError`, `Policy<C>`, `after`, `ActorRef`, `Policy` ns, `toQueryLayer` | | AgentSession, Chat, Chat.queries | 5, 22, 49c (names) |
| 103–104 | `ScopedRead`, `Scoped.one/all/insert/upsert` | | Counter.server, Chat.server | 9, 10 (sugar) |
| 105–107 | error classes, `InvalidInput`, `TransportError`, `x-request-id` | `serve` | sdk.test | 26 (extend) |
| 108–112 | executors `(ctx, effect)`, `hooks`, `InsideTurn`, `Actors` shape, spans | | all server files | 11 (key name), 12/13 (message) |
| 113–115 | commandId minting, `client(options)`; no AI adapters (153) | `serve` | browser, usage | 15, 20, 40, 153 |
| 116–119 | `serve({ openapi })`, `deprecated`, `layerConfig`, `Topology.fromConfig`, `WorkflowRun` | | usage, User | 24 (start type), 153, 158 |
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

### `User.ts` / `User.server.ts` — a workflow as a member of its owner
```ts
// contract: the workflow is declared next to the commands and listed in `workflows`
export const Onboard = Actor.workflow("Onboard", {
  description: "Welcome the user in a room, wait a day for their first message, nudge them by email otherwise.",
  input: { roomId: RoomId },
  output: Schema.Struct({ nudged: Schema.Boolean }),
  errors: [NotAMember]
})
export const User = Actor.make("User", {
  description: "One actor per user: room memberships, first-message tracking, and the onboarding workflow.",
  id: UserId,
  commands: [Join, NoteMessage],
  internal: [NoteMessage],
  workflows: [Onboard],
  events: [Joined, FirstMessage],
  state: { rooms: Schema.Record(RoomId, Schema.Boolean).pipe(Schema.withDecodingDefault(Effect.succeed({}))) },
  lifecycle: [Hibernate.after("1 minute"), Events.keep("forever")]
})

// server: the body lives next to the command handlers, with `(ctx, input)`
export const UserLive = User.toLayer(
  Effect.gen(function*() {
    const mailer = yield* Mailer
    return User.of({
      Join: Effect.fn(function*(ctx, { roomId }) {
        if (roomId in ctx.state.rooms) return
        yield* ctx.state.set({ rooms: { ...ctx.state.rooms, [roomId]: false } })
        yield* ctx.emit(new Joined({ roomId }))
        yield* ctx.self.Onboard.start({ roomId }, { key: roomId })          // intent: started after COMMIT
      }),
      NoteMessage: Effect.fn(function*(ctx, { roomId, messageId }) {
        if (ctx.state.rooms[roomId] === true) return
        yield* ctx.state.set({ rooms: { ...ctx.state.rooms, [roomId]: true } })
        yield* ctx.emit(new FirstMessage({ roomId, messageId }))
      }),
      Onboard: Effect.fn(function*(ctx, { roomId }) {
        const room = ctx.actors.get(Chat, roomId)                           // request/reply is allowed here
        yield* ctx.activity("welcome", {
          output: Message,
          errors: [InvalidMessage, NotAMember],
          run: room.SendMessage({ body: `welcome, ${ctx.owner.id}` }),
          retry: Schedule.exponential("1 second")
        }).pipe(Effect.catchTag("InvalidMessage", () => Effect.void))
        // waits on the OWNER actor's events (decision 166) → Option<FirstMessage>
        const first = yield* ctx.waitFor(FirstMessage, { where: (e) => e.roomId === roomId, timeout: "1 day" })
        if (Option.isSome(first)) return { nudged: false }
        yield* ctx.activity("nudge", {
          output: Schema.Void,
          errors: [],
          run: mailer.send(ctx.owner.id, "still there?").pipe(Effect.orDie)
        })
        return { nudged: true }
      })
    })
  })
)
```

### `usage.ts` — Effect client
```ts
export const program = Effect.gen(function*() {
  // the caller is ambient: over HTTP the auth middleware set it, in a test `ActorTest.layer({ as })` did
  const room = yield* Chat.get(RoomId.make("room-1"))
  const msg = yield* room.SendMessage({ body: "hi" })                 // E = InvalidMessage | NotAMember | ActorError
  yield* room.SendMessage({ body: "hi again" }).pipe(Actor.commandId(httpIdempotencyKey))
  const recent = yield* room.Recent({ limit: 20 })                    // E = NotAMember (no cluster hop)
  const live: Stream.Stream<Message, NotAMember | ActorError> = room.Transcript()

  // an explicit caller for one handle, instead of the ambient one
  const admin = yield* Chat.get(RoomId.make("room-1"), { as: adminPrincipal })
  yield* admin.SendMessage({ body: "pinned" })

  // a workflow is started on its owner's handle, keyed per room (decision 158)
  const user = yield* User.get(alice.userId)
  const run = yield* user.Onboard.start({ roomId: RoomId.make("room-1") }, { key: "room-1" })
  const outcome = yield* run.result                                   // Effect<{ nudged }, NotAMember | WorkflowInterrupted>

  // reasons, not classes (decision 167); `catchReasons` without `orElse` keeps ActorError in E
  const resilient = yield* room.SendMessage({ body: "retry me" }).pipe(
    Effect.catchReasons("ActorError", { MailboxFull: () => Effect.succeed(msg), Timeout: () => Effect.succeed(msg) })
  )
  return { msg, recent, live, outcome, runId: run.id, resilient }
})

// a script or a CLI with no edge in front of it: one scoped override for the whole program
export const seed = program.pipe(Actor.as(alice))
```

### `browser.ts` — Promise client
```ts
const chat = Chat.client({ baseUrl: "https://actors.example.com", headers: { authorization: `Bearer ${token}` }, timeoutInMs: 10_000 })
export const send = (roomId: RoomId, body: string, signal?: AbortSignal) =>
  chat.get(roomId).SendMessage({ body }, { signal })                  // commandId minted here, reused on retry
export const follow = async function*(roomId: RoomId, signal: AbortSignal) {
  for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) yield e.event.message
}
// thrown: InvalidMessage | NotAMember | ActorError | InvalidInput | Unauthorized | TransportError
```

### agents — no adapter, just the primitives
There is no AI-specific surface (decision 153): no toolkit constructor, no MCP server, no `llms.txt`. An agent
consumes `/openapi.json` like any other client, and an agent *is* an actor — see
[example/CodingAgent.ts](example/CodingAgent.ts): commands for prompts and aborts, internal commands for
executor results, a `Live` connection for token deltas, a `Ship` workflow member for multi-turn jobs, `vars`
for per-activation handles and `state` for what must survive hibernation.

### `server.ts` — runtime, auth, config
```ts
export const AppLive = Layer.mergeAll(ChatLive, ChatReads, CounterLive, CounterReads, UserLive, NightlyLive).pipe(
  Layer.provide(Layer.mergeAll(RoomAccessLive, MailerLive)),
  // optional (decision 155): drop `serve` to embed the actors and call them as Effects in this process
  Layer.provideMerge(Actor.serve({
    actors: [Chat, Counter, User, Nightly],                          // singletons are listed too: /actors/Nightly/singleton/ResetAll
    auth: Actor.auth.bearer((token) => Sessions.verify(token))       // Effect<Principal, Unauthorized, Sessions>
  })),                                                               // serves every public member + /openapi.json
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

### What `Actor.serve` publishes

> Superseded on 2026-09-21 by decision 153: the `llms.txt` document this section drafted is not shipped and not
> served. One generated artifact, `/openapi.json`, carries the same information and cannot drift from the
> contract.

```
POST /actors/Chat/{roomId}/SendMessage      x-command-id: <uuid>   (reuse it when you retry)
GET  /actors/Chat/{roomId}/Recent?limit=20
GET  /actors/Chat/{roomId}/events?after=0   text/event-stream
GET  /actors/Chat/{roomId}/Live             WebSocket (a connection member)
POST /actors/CodingAgent                    mint an id (minted-id actors only)
GET  /openapi.json                          descriptions, inputs, declared errors, `deprecated`
```
Declared errors return 4xx with `{ _tag, ...fields, message }`; an `ActorError` with a retryable reason returns
503 with `Retry-After`.

## 5. Pick list

Everything above defaults to **a**. Answer only where you disagree.

> Resolved on 2026-09-21 by decisions 151–171. Rows superseded by the outcome: **94** (id modes: minted /
> named / singleton, 164), **96** and **116** (no toolkit to gate, no `docs` option — OpenAPI only, 153),
> **130** (no `durable-actors/react`; `framework/React.ts` was deleted), **132** and **133** (no kinds: one
> `Actor.make`, `singleton: true`, `vars`, 157/160/164).

| # | a | b |
| --- | --- | --- |
| 89 | ambient caller + `get(id, { as })` | `{ as }` only |
| 90 | `Actor.layer({ tenant })` derivation | keep per-call `Actor.tenant` only |
| 91 | `onBehalfOf` + `ctx.principal` | keep `Caller.principal(caller)` only |
| 92 | `auth` required, `Actor.auth.none` explicit | keep optional |
| 94 | ~~`id` required~~ → id modes: minted / named / singleton (164) | keep an unbranded default |
| 95 | `internal: [...]` | separate `Actor.internalCommand` constructor |
| 96 | optional `description` (no toolkit to gate, 153) | required everywhere |
| 97 | default 422 for declared errors | require `httpApiStatus` on every error |
| 101 | add `Policy` namespace | leave ten top-level exports |
| 102 | `toQueryLayer` / `queries` | keep `queries()` / `queryDefs` |
| 104 | `one / all / insert / upsert` sugar | pass-throughs only |
| 109 | server key `hooks:` | keep `lifecycle:` on both sides |
| 113 | client mints commandId, stable across retries | keep server-generated (double-apply on retry) |
| 116 | ~~docs endpoints~~ → `/openapi.json` only (153) | no generated docs at all |
| 119 | `WorkflowRun` handle | keep `start → string` |
| 120 | `test.actor` + `layer({ as })` | flat API only |
| 125 | keyed state in `actor_state`, sync reads | one JSONB blob (c: no state) |
| 126 | `Actor.connection` sessions | streams + events only |
| 127 | `run` loop on the activation | workflows only |
| 129 | 1 s poll + sleep-then-poll + `NOTIFY` | poll interval only |
| 130 | SSE events + OpenAPI (~~+ a React subpath~~: dropped) | OpenAPI only |
| 131 | `Actor.blob` | `bytea` table, no helper |
| 132 | ~~add a singleton kind~~ → `singleton: true` on `Actor.make` (157) | a separate constructor |
| 133 | ~~an ephemeral kind~~ → an actor with `vars` and no durable members (157, 160) | a `durable: false` flag |

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

> Refined on 2026-09-21 by decision 163: connections are a *member* kind, not a fourth actor kind, and DO-style
> hibernation *is* offered — `Connections.park` (the default) lets the activation hibernate while the sockets
> stay open at the edge, and the next frame wakes it; `Connections.keepAwake` is the opt-out. The handler reads
> `ctx.conn.state` (≤ 16 KiB, survives hibernation like DO's `serializeAttachment`) and `ctx.conn.resumed`.

Gap: DO WebSocket hibernation and Rivet `c.conn` / `broadcast`. Proposal: a connection member.

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
is an in-memory registry in the activation closure. Whether an open connection keeps the actor awake is a
policy: `Connections.park` (default) parks the socket at the edge and lets the activation hibernate, so
per-connection durability lives in `ctx.conn.state`; `Connections.keepAwake` keeps it resident. Promise client:
`const live = chat.get(id).Live({ since }, { signal }); for await (const f of live) …; live.send(new Typing(…))`.
**Pick: a.** Alt b: no connections; streams + events only.

**127. `run`: a long-lived activation loop that stays inside the transaction rule.**

> Refined on 2026-09-21 by decisions 159, 165 and 169: `run` is an option of
> `X.toLayer(handlers, { hooks, effects, run, shardGroup, spanAttributes })`, and it is sugar for a
> `forkScoped` fiber inside the activation scope — started on wake, interrupted on sleep. The loop's `ctx`
> carries `vars` (not a `memory` declaration) and `ctx.state.changes`, a `Stream` of committed state snapshots.

Gap: Rivet `run: async (c) => for await (const msg of c.queue.iter())`. Proposal: `X.toLayer(handlers, { run })`.

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
`ctx` here is the wake context plus `events` (live, cursor-able), `state` (committed snapshot, plus
`ctx.state.changes` as a stream), `self` / `actors` intents, `connections` and `vars`. The loop never opens a transaction;
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
`/openapi.json` (116) feeds `openapi-ts` / `openapi-generator` for typed Python/Swift/Rust clients.

> Superseded on 2026-09-21 by decision 151: the React subpath proposed here does not exist and
> `framework/React.ts` was deleted. A UI cache/subscription layer proves nothing about durable actors; browsers
> use the Promise client from `durable-actors/client` plus the SSE and WebSocket endpoints directly.

```ts
// what a browser actually writes (durable-actors/client)
const chat = Chat.client({ baseUrl, headers: { authorization: `Bearer ${token}` } })
await chat.get(roomId).SendMessage({ body })
for await (const e of chat.get(roomId).events(MessageAdded, { after: 0, signal })) render(e.event)
```
**Pick: SSE + OpenAPI + the Promise client.**

**131. Blobs: large per-actor binaries outside the state cap.**
Gap: DO/Rivet keep a CRDT document or an embedding matrix as a file in the object's SQLite. Proposal:
`Actor.blob("doc")` → `blobs: [doc]`; rows in `actor_blobs(tenant_id, actor_id, key, seq, data bytea)`; loaded
lazily inside the turn (`ctx.blob(doc).get: Effect<Option<Uint8Array>>`, `.set`, `.append(update)` for
update-log CRDTs, `.compact(merge)` from `onWake`); streamed over HTTP at `GET /actors/{name}/{id}/blobs/doc`;
exempt from `State.maxBytes`. **Pick: a.** Alt b: `Actor.table` with `bytea` and no helper.

## 7. Kinds, members, runtime: the taxonomy under `Actor.` (132–134)

> **Superseded on 2026-09-21 by decisions 157, 160, 164, 170 and 171**: the answer to "how many kinds?" turned
> out to be **one**. `Actor.make` is the only kind; there is no `Actor.ephemeral`, `Actor.cron`,
> `Actor.singleton` or `Actor.job`, and no `durable: false` flag either. Durability is not a flag and not a
> kind: an actor that declares no `state`, `tables`, `events` or `effects` touches none of those rows.
> `singleton: true` gives `X.get()` with no id plus cluster-wide cron and `run`; cron is the lifecycle policy
> `Cron.every(expr, Cmd, { skipIfOlderThan })` on a zero-input command of the same actor (per-actor timer for
> named and minted actors, `Sharding.registerSingleton` for singletons); a workflow is a *member*. The
> `Members` bag is `commands, internal, queries, streams, connections, workflows, events, effects, tables,
> blobs, state, vars, migrations, lifecycle`. The section below is kept for the argument; its code has been
> rewritten to the surface that shipped.

The question "should there be `Actor.job` / `Actor.connection` as actor types?" comes from `Actor.` holding three
levels with nothing marking which is which: **kinds** that `toLayer` and that Cluster places; **members**
(`command`, `query`, `stream`, `connection`, `workflow`, `table`, `blob`, `migration`) that only mean
something inside a kind; and **runtime** (`layer`, `serve`, `auth`, `as`, `anonymous`, `tenant`, `commandId`).
Effect's own `HttpApiEndpoint → HttpApiGroup → HttpApi` is the same three-level ladder, in three modules. Decisions
2/24/30 fixed the names under one namespace, so the fix is to make the levels visible, not to rename.

**132. One kind, and neither a job nor a cron is one.**

| Spelling | One per | Turn model | Compiles to | Use when |
| --- | --- | --- | --- | --- |
| `Actor.make` | id (tenant, id) | transaction per command, receipts, state/tables/events/effects | `Entity` (`Persisted: true`) | it has an identity and receives commands over time |
| `Actor.make`, no `id` | minted id | as above; `X.create()` mints a UUIDv7 | `Entity` | the id belongs to the framework, not the app |
| `Actor.make({ singleton: true })` | cluster | as above, plus a resident boot activation for cron and `run` | `Entity` + `Sharding.registerSingleton` | a leader/poller/reaper that must run exactly once cluster-wide |
| `Actor.make` with only `vars` | id | serialized turns, no durable rows | `Entity` | presence, cursors, rate-limit lanes: anything that may forget on restart |
| `Actor.workflow` in `workflows: [...]` | (owner, key) | durable steps, one linear run | `Workflow` + `ClusterWorkflowEngine` | a process with a start and an end: onboarding, a payment, *a job* |

A "job" is a workflow member (`X.W.start(input, { key })` → run handle, retries from `Activity`), a per-actor
delayed job is `ctx.self.X.after(d, input)`, and a recurring one is `Cron.every(...)` in `lifecycle`. A separate
`Actor.job` would be a fourth spelling of the same thing. **Pick: one kind.**

```ts
// a singleton whose work is a `run` loop (example/Reaper.ts, example/Reaper.server.ts)
export const Reaper = Actor.make("Reaper", {
  description: "Retries young dead letters and logs old ones, cluster-wide, once a minute.",
  singleton: true,                                   // Reaper.get() takes no id; a boot activation stays resident
  commands: [Pause, Resume],
  state: { paused: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))) }
})
export const ReaperLive = Reaper.toLayer({
  Pause: (ctx) => ctx.state.set({ paused: true }),
  Resume: (ctx) => ctx.state.set({ paused: false })
}, {
  run: (ctx) => sweepOnce(ctx).pipe(Effect.delay("1 minute"), Effect.forever)
})

// a cluster-wide cron: a lifecycle policy on a zero-input command (example/Nightly.ts)
export const Nightly = Actor.make("Nightly", {
  singleton: true,
  commands: [ResetAll],
  lifecycle: [Cron.every("0 3 * * *", ResetAll, { skipIfOlderThan: "1 hour" })]
})
```

**133. No durability without a kind: `vars` and nothing else declared.**
This is what closes the latency gap for workloads that do not need durability, and it needs no new constructor.
The same `command / query / stream / connection` members, the same handle shape, the same `Actor.serve`; declare
no `state`/`tables`/`events`/`effects` and the turn writes no rows. `ctx.vars` is the only mutable state and
`Hibernate.after` drops it. A query cannot see `vars` (queries run on the caller's node against committed
rows), so expose a stream instead.

```ts
export const Cursor = Actor.make("Cursor", {
  description: "Live cursor positions for one document. Forgets everything when idle.",
  id: DocId,
  // per-activation memory (decision 160): typed, defaulted from the schema, dropped on hibernation
  vars: { cursors: Schema.Record(UserId, Position).pipe(Schema.withDecodingDefault(Effect.succeed({}))) },
  commands: [Move],
  streams: [Positions],
  connections: [Live],
  lifecycle: [Hibernate.after("30 seconds"), Mailbox.capacity(1000), Connections.park]
})
// Cursor.server.ts
Move: Effect.fn(function*(ctx, position) {
  const principal = yield* Option.match(ctx.principal, { onNone: () => new NotSignedIn(), onSome: Effect.succeed })
  yield* ctx.vars.update((v) => ({ cursors: { ...v.cursors, [principal.userId]: position } }))
  yield* ctx.connections.broadcast(new Moved({ userId: principal.userId, position }))
}),
Positions: (ctx) => Stream.succeed(ctx.vars.cursors)
```
Commands still serialize through the mailbox (`concurrency: 1`), so such an actor is a single-writer in-memory
object placed by Cluster: the Rivet/DO model, per actor, with the same contracts. Testing: `ActorTest` works
unchanged (`inspect` returns `vars` instead of rows). **Pick: `vars`, no kind and no flag.**

**134. Make the levels visible without renaming.**
JSDoc `@category kinds | members | policies | runtime | clients | testing` (123) drives the generated API docs;
`Actor.make` carries `_kind: "actor"` with a `mode: "minted" | "named" | "singleton"`, and members carry
`_kind: "command" | "query" | "stream" | "connection" | "workflow" | "table" | "blob" | "migration"`; the
skill's first section is the table in 132 ("which spelling?"). Members never appear in
`Actor.serve({ actors })` (type error). **Pick: a.**
