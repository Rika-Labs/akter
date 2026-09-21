# Durable Actors vs Rivet's Effect SDK vs Cloudflare Durable Objects (2026-09-21)

Three actor runtimes, one concept at a time, with the same code in each. The last section ranks them.

**Read this first.** The three are not at the same stage, and the ranks say so twice.

| | Status | Runtime | Effect |
| --- | --- | --- | --- |
| **Durable Actors** (this repo, `research/v4`) | typechecked sketch; every runtime function is `declare`d; zero lines execute | one Postgres (or PlanetScale Neki) per deployment, Effect Cluster for placement | native (`effect` 4.0.0-rc.116) |
| **Rivet `@rivetkit/effect` 2.3.17** | official, published, **beta** ("the API may change between releases"); a typed wrapper over `rivetkit` | Rivet Engine, one KV + SQLite per actor | native (`effect ^4.0.0-beta.66`) |
| **Cloudflare Durable Objects** | GA since 2021, SQLite-backed since 2024 | Cloudflare's edge, one SQLite per object | none (Promise / class API) |

Every Rivet claim below was checked against `rivet-dev/rivet@main` (`rivetkit-typescript/packages/effect/src/*.ts`, `test/e2e.test.ts`, `test/fixtures/actors.ts`, `docs/content/docs/quickstart/effect.mdx`). Every DO claim was checked against developers.cloudflare.com. Every Durable Actors claim is a design claim backed by a typechecked contract in [framework/Actor.ts](framework/Actor.ts) and a verification gate in [DECISIONS.md](DECISIONS.md) §3 — not by a running system.

Our own caveat, stated by the owner and repeated here: **every Durable Actors turn is a database round trip.** A command is `BEGIN … SELECT FOR UPDATE … COMMIT` on Postgres, so a turn costs the network distance to the database (sub-millisecond co-located, 5–30 ms cross-AZ, more on a hosted Neki) plus a Cluster hop when the caller is not on the owning runner. Rivet and DO apply a command in process memory and persist afterwards (Rivet on a 1 s interval, DO through its output gate). We will not win a latency benchmark; we are choosing transactional turns over that.

---

## 1. The judging table

Legend: 🟢 first-class and typed · 🟡 possible, but manual, untyped, or through an escape hatch · 🔴 absent · ⚪ not applicable. The Durable Actors column describes the design; the "runs today" reality is in §4.

| Concept | Durable Actors (design) | Rivet Effect SDK 2.3.17 | Cloudflare DO |
| --- | --- | --- | --- |
| Contract / implementation split | 🟢 `X.ts` (schemas, members, policies) vs `X.server.ts` (`X.toLayer`) | 🟢 `Action.make` / `Actor.make` vs `X.toLayer` | 🔴 one class; clients need the class type or a hand-written interface |
| Identity | 🟢 branded id schema, minted UUIDv7 by default (`X.create()`), `singleton: true` | 🟡 `getOrCreate(string \| string[])`; untyped key; no `get` / `create` in the Effect SDK | 🟡 `idFromName` / `newUniqueId` / `getByName`; `DurableObjectId`, not branded per class |
| State durability | 🟢 keyed JSONB row, committed with the turn, `≤ State.maxBytes`, versioned + migrated | 🟡 `State` module (linearized by a semaphore) but persisted by rivetkit's 1000 ms `stateSaveInterval`, not configurable from the SDK; `rawRivetkitContext.saveState({ immediate: true })` to force | 🟢 `ctx.storage` KV + SQLite, write-coalesced, durable before the reply leaves (output gate) |
| Tables / SQL | 🟢 `Actor.table`, `ctx.rows(t)` scoped to `(tenant_id, actor_id)`, drizzle on the turn transaction | 🟡 `db: db({ onMigrate })` on `toLayer`, then `rawRivetkitContext.db.execute("…")` — `any`-typed raw SQL | 🟢 `ctx.storage.sql.exec(...)` typed cursor, `transactionSync` |
| Commands + typed errors | 🟢 `errors: [..]` union in `E`; framework failures are one `ActorError.Of<reason>` narrowed per method | 🟢 `error:` schema in `E`, plus `RivetError` (25 reasons, `isRetryable`) | 🔴 Workers RPC throws `Error`; class and fields are lost on the wire |
| Queries without the actor | 🟢 `Actor.query` + `X.toQueryLayer` run on the caller's node against committed rows | 🔴 every action wakes the actor | 🔴 every method wakes the object (and pins it to its region) |
| Events + cursor replay | 🟢 `events: [..]`, `ctx.emit`, `x.events(E, { after })` from `actor_events` then live | 🔴 "not yet wrapped"; `rawRivetkitContext.broadcast` is fire-and-forget | 🔴 nothing; build it on `ctx.storage.sql` + WebSockets |
| Effects / outbox / dead letters | 🟢 `effects: [..]`, `ctx.perform`, executors after COMMIT, `Effects.retry`, `onEffectFailed`, dead-letter retry | 🔴 do the side effect inside the action | 🟡 `ctx.waitUntil`; no outbox, no retry, no dead letters |
| Cross-actor calls | 🟢 inside a turn only durable intents (`.send/.after/.at`, committed with the turn); request/reply outside and in workflows | 🟡 `X.client` from inside a handler is request/reply; no durability | 🟡 `env.NS.get(id).method()` request/reply; no durability |
| Timers | 🟢 keyed timers `ctx.self.X.after(d, { key })`, `ctx.timers.cancel`, survive restarts | 🔴 "not yet wrapped"; `rawRivetkitContext.schedule.after/at` untyped | 🟡 exactly **one** alarm per object (`setAlarm`), retried with backoff |
| Cron | 🟢 `Cron.every(expr, Command)` policy on any actor; singletons for cluster-wide | 🔴 "not yet wrapped" | 🟡 Cron Triggers on the Worker, then call into an object |
| Workflows | 🟢 `Actor.workflow` member: activities, durable sleep, `ctx.waitFor(Event)`, crash-resumable | 🔴 "not yet wrapped" | 🟡 Cloudflare Workflows is a separate product (`step.do`, `step.sleep`, `step.waitForEvent`); it can call objects, objects can start it |
| Connections | 🟢 `Actor.connection` typed frames both ways, `ctx.connections.broadcast`, `conn.state` | 🔴 "not yet wrapped"; `rawRivetkitContext.conns` untyped | 🟢 WebSocket Hibernation API, tags, `getWebSockets(tag)` |
| Hibernation with sockets open | 🟢 `Connections.park` (default): activation sleeps, edge holds sockets + `conn.state ≤ 16 KiB`, next frame re-runs the handler with `resumed = true` | 🔴 open connections keep the actor awake | 🟢 `acceptWebSocket`, evicted while connected, `serializeAttachment ≤ 16,384 bytes` |
| Activation-local values | 🟢 `vars: {..}` schema'd, `ctx.vars`, dropped on hibernation | 🟡 the `toLayer` build effect's closure (`Ref`, services) — works, but nothing names it | 🟡 instance fields; reset on eviction |
| Background loop | 🟢 `run: (ctx) => …` forked with the activation, restarted on wake | 🟡 `Effect.forkScoped` in the build effect; no name, no wake semantics | 🟡 `ctx.waitUntil` / instance promises; killed on eviction |
| Caller / auth | 🟢 ambient `CurrentCaller`; `ctx.caller: User \| System(source)`; app-augmented `Principal`; `Actor.auth.bearer` at the edge | 🔴 nothing in the SDK; do it in the Worker/HTTP layer or the action payload | 🔴 nothing; do it in the Worker |
| Multi-tenancy | 🟢 `tenant_id` on every row, derived from the principal once, `Actor.tenant` for cross-tenant admin | 🔴 namespaces are a deployment concept, not per-call | 🔴 nothing; encode in the id name |
| Idempotency / receipts | 🟢 client-minted `commandId`, `actor_receipts`, replay returns the stored reply, `CommandConflict` on a different payload | 🔴 | 🔴 |
| Testing | 🟢 `ActorTest`: real turns on PGlite/Postgres/Neki, `TestClock`, held effects, crash points, N-runner cluster, workflow crash injection, seeded state, conformance suite | 🟡 `Registry.test` against a **real engine** (`inject("rivetEngine")`), wall-clock polling with `TestClock.withLive`, no fault injection, registry leaked to process exit (documented) | 🟢 `@cloudflare/vitest-pool-workers`: `runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`; no virtual time for alarms beyond firing them now |
| Transport / hosting | 🟢 embedded (no HTTP), `Actor.serve({ actors, auth })` (HTTP + OpenAPI + Promise client), or hosted | 🟢 `Registry.serve`, `toWebHandler`, `toHttpEffect`; Rivet Cloud or self-hosted engine | 🟢 Workers only |
| Observability | 🟢 one span per turn / effect / activity, `TurnReport` in tests | 🟢 client+server spans propagated over the wire (verified in `e2e.test.ts`), `RivetLogger` bridge | 🟡 Workers Trace Events / Logpush; no automatic spans |
| Point-in-time recovery | 🔴 (Postgres PITR is at the database level, not per actor) | 🔴 | 🟢 `getCurrentBookmark` / `onNextSessionRestoreBookmark` per object |
| Per-actor storage ceiling | 🟢 the database's (state row ≤ 16 KiB by policy; tables unbounded) | 🟡 per-actor SQLite | 🟡 10 GB SQLite per object |
| Latency of a command | 🔴 one DB transaction + optional Cluster hop | 🟢 in-memory, persisted every 1 s | 🟢 in-memory, persisted per event |
| Runs today | 🔴 | 🟢 (beta) | 🟢 |

---

## 2. Every concept, in all three

The same actor throughout: a counter that overflows at 20, has a durable history, and emails someone when it overflows.

### 2.1 Definition

```ts
// Durable Actors — Counter.ts (contract) and Counter.server.ts (implementation)
export class Overflow extends Schema.TaggedError<Overflow>()("Overflow", { limit: Schema.Number }) {}
export class CountChanged extends Schema.TaggedClass<CountChanged>()("CountChanged", { count: Schema.Number }) {}
export class NotifyOverflow extends Schema.TaggedClass<NotifyOverflow>()("NotifyOverflow", { count: Schema.Number }) {}

export const Increment = Actor.command("Increment", { input: Schema.Number, output: Schema.Number, errors: [Overflow] })
export const GetCount = Actor.query("GetCount", { output: Schema.Number })

export const Counter = Actor.make("Counter", {
  id: CounterId,                       // branded; omit it and `Counter.create()` mints a UUIDv7
  commands: [Increment],
  queries: [GetCount],
  events: [CountChanged],
  effects: [NotifyOverflow],
  state: { count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
  lifecycle: [Hibernate.after("1 minute"), Events.keep("30 days")]
})

// Counter.server.ts
export const CounterLive = Counter.toLayer({
  Increment: Effect.fn(function*(ctx, n) {
    const next = ctx.state.count + n
    if (next > 20) {
      yield* ctx.perform(new NotifyOverflow({ count: next }))   // outbox row, executed after COMMIT
      return yield* new Overflow({ limit: 20 })                  // the turn rolls back; the outbox row with it
    }
    yield* ctx.state.set({ count: next })
    yield* ctx.emit(new CountChanged({ count: next }))
    return next
  })
}, {
  effects: { NotifyOverflow: (_ctx, e) => Mailer.send("ops@acme.com", `counter hit ${e.count}`) }
})
export const CounterReads = Counter.toQueryLayer({ GetCount: (ctx) => Effect.succeed(ctx.state.count) })
```

```ts
// Rivet Effect SDK — verified against test/fixtures/actors.ts
export class Overflow extends Schema.TaggedErrorClass<Overflow>()("Overflow", { limit: Schema.Number }) {}

export const Increment = Action.make("Increment", { payload: { amount: Schema.Number }, success: Schema.Number, error: Overflow })
export const GetCount = Action.make("GetCount", { success: Schema.Number })
export const Counter = Actor.make("Counter", { actions: [Increment, GetCount] })

export const CounterLive = Counter.toLayer(
  ({ state }) =>
    Effect.gen(function*() {
      const mailer = yield* Mailer
      return Counter.of({
        Increment: ({ payload }) =>
          Effect.gen(function*() {
            const { count } = yield* State.get(state).pipe(Effect.orDie)     // State<A, SchemaError, R>
            const next = count + payload.amount
            if (next > 20) {
              yield* mailer.send("ops@acme.com", `counter hit ${next}`)      // no outbox: runs now, inside the action
              return yield* new Overflow({ limit: 20 })
            }
            yield* State.set(state, { count: next }).pipe(Effect.orDie)     // in memory now; on disk within ~1 s
            return next
          }),
        GetCount: () => State.get(state).pipe(Effect.map((s) => s.count), Effect.orDie)
      })
    }),
  { state: { schema: Schema.Struct({ count: Schema.Number }), initialValue: () => ({ count: 0 }) } }
)
```

```ts
// Cloudflare Durable Objects
export class Counter extends DurableObject<Env> {
  async increment(amount: number): Promise<number> {
    const count = (await this.ctx.storage.get<number>("count")) ?? 0
    const next = count + amount
    if (next > 20) {
      this.ctx.waitUntil(this.env.MAILER.fetch("https://mail/", { method: "POST", body: `counter hit ${next}` }))
      throw new Error("Overflow: limit 20")            // the client receives Error("Overflow: limit 20"); no class, no fields
    }
    await this.ctx.storage.put("count", next)          // durable before the reply is released (output gate)
    return next
  }
  async getCount(): Promise<number> {
    return (await this.ctx.storage.get<number>("count")) ?? 0
  }
}
```

What differs: Rivet's `toLayer` accepts exactly `state`, `db`, `name`, `icon` (`Actor.ts` L30–68); everything the Durable Actors contract declares in arrays has no home there. DO has no contract at all: the class *is* the contract, and its errors are strings.

### 2.2 Getting a handle and calling

```ts
// Durable Actors
const counter = yield* Counter.get(CounterId.make("c-1"))         // Effect<Handle, never, Actors>
const n = yield* counter.Increment(5)                             // Effect<number, Overflow | ActorError.Of<DeliveryReason>>
const count = yield* counter.GetCount()                           // Effect<number, never> — no actor hop
const fresh = yield* Session.create()                             // minted id; nothing is written until the first command
yield* counter.Increment(5).pipe(Actor.commandId(httpIdempotencyKey))
```

```ts
// Rivet Effect SDK — verified: Accessor has only `getOrCreate`
const counter = (yield* Counter.client).getOrCreate("c-1")        // requires Client.Client; key is string | string[]
const n = yield* counter.Increment({ amount: 5 })                 // Effect<number, Overflow | RivetError, ServicesClient>
const count = yield* counter.GetCount()                           // also an action: wakes the actor
```

```ts
// Cloudflare DO
const stub = env.COUNTER.getByName("c-1")                          // or .get(env.COUNTER.idFromName("c-1"))
const n = await stub.increment(5)                                  // Promise<number>; throws Error
const count = await stub.getCount()
```

The `(yield* Counter.client).getOrCreate(...)` shape — a nested yield to reach the accessor before the call — is the one the owner ruled out for us (decision 89: one yield for the handle, plain Effects after); the Rivet SDK requires it because the accessor is a service-dependent value. Rivet also has no way to say "this must already exist" from the Effect SDK; `getOrCreate` is the only verb.

### 2.3 Errors

```ts
// Durable Actors — one framework error, the reason narrowed per method
yield* counter.Increment(5).pipe(
  Effect.catchTag("Overflow", () => Effect.succeed(20)),
  Effect.catchReasons("ActorError", {                             // exhaustive for *this* method's reasons
    MailboxFull: (e) => Effect.fail(e),
    Timeout: () => Effect.succeed(-1),
    ActorUnavailable: (e) => e.isRetryable ? retry : Effect.fail(e),
    CommandConflict: (e) => Effect.die(e)
  })
)
```

```ts
// Rivet Effect SDK — verified: 25 reasons, `catchReasons` is Effect's, `retryAfter` only for ActorRestarting
yield* counter.Increment({ amount: 5 }).pipe(
  Effect.catchTag("Overflow", () => Effect.succeed(20)),
  Effect.catchReasons("RivetError", {
    ActorOverloaded: () => Effect.succeed(-1),
    ActorRestarting: (e) => Effect.sleep(e.retryAfter ?? "1 second").pipe(Effect.andThen(again))
    // …the other 23 reasons are still in E; the union is not narrowed per action
  })
)
```

```ts
// Cloudflare DO
try { await stub.increment(5) } catch (e) {
  if (e instanceof Error && e.message.startsWith("Overflow")) { /* string matching */ }
}
```

Durable Actors and Rivet both keep declared errors as their own classes in `E` (Rivet's `e2e.test.ts` asserts `instanceOf CounterOverflowError` after the wire). The difference is the framework side: `ActorError.Of<reason>` collapses to the reasons a method can actually produce (a query has none); `RivetError` is the full 25-reason union on every call.

### 2.4 State

```ts
// Durable Actors — a JSONB row in `actor_state`, written in the turn transaction
state: { count: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))) },
migrations: [Actor.migration(StateV1, StateV2, (old) => ({ ...old, model: "default" }))],
lifecycle: [State.maxBytes("16 KiB")]
// in a command
yield* ctx.state.set({ count: 1 })        // part of the transaction; visible to the next turn only after COMMIT
ctx.state.count                           // the snapshot this turn started from
ctx.state.changes                         // Stream of committed snapshots, for the run loop
```

```ts
// Rivet Effect SDK — verified in internal/ActorStateAdapter.ts: `c.state = encoded`, never `saveState`
yield* State.update(state, (s) => ({ ...s, count: 1 }))   // linearized by Semaphore(1); durable on the 1 s interval
yield* Effect.promise(() => rawRivetkitContext.saveState({ immediate: true }))   // the only way to force it
State.changes(state)                                       // PubSub with replay: 1
```

```ts
// Cloudflare DO
await this.ctx.storage.put("count", 1)     // coalesced; committed before any reply leaves the object
this.ctx.storage.sql.exec("UPDATE kv SET v = ? WHERE k = 'count'", 1)
await this.ctx.storage.transaction(async (txn) => { … })
```

A crash between a Rivet `State.set` and the next interval flush loses the write; the action already replied. That is the exact hole transactional turns close, and the price is the round trip.

### 2.5 Tables

```ts
// Durable Actors
export const messages = Actor.table("chat_messages", { id: "text", body: "text", sent_at: "timestamptz" })
yield* ctx.rows(messages).insert({ id, body, sent_at: ctx.now })          // scoped to (tenant_id, actor_id)
const recent = yield* ctx.rows(messages).all({ orderBy: { column: "sent_at", direction: "desc" }, limit: 20 })
ctx.db   // drizzle on the same transaction, for joins across the actor's tables
```

```ts
// Rivet Effect SDK — verified in fixtures: `db: db({ onMigrate })`, then raw SQL through the raw context
{ db: db({ onMigrate: async (c) => { await c.execute("CREATE TABLE IF NOT EXISTS events (…)") } }) }
const db = rawRivetkitContext.db                                          // widened to `any`
yield* Effect.tryPromise(() => db.execute("INSERT INTO events (event) VALUES (?)", payload.event)).pipe(Effect.orDie)
```

```ts
// Cloudflare DO
this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, body TEXT, sent_at INTEGER)")
this.ctx.storage.sql.exec("INSERT INTO messages VALUES (?, ?, ?)", id, body, Date.now())
const rows = this.ctx.storage.sql.exec<{ id: string; body: string }>("SELECT * FROM messages ORDER BY sent_at DESC LIMIT 20").toArray()
```

DO's SQLite is the strongest of the three for a single actor (typed cursor, PITR, 10 GB). Ours is a shared Postgres, so the same rows are also reachable by ordinary reports and joins across actors — DO and Rivet cannot query across objects at all.

### 2.6 Events with a cursor

```ts
// Durable Actors
yield* ctx.emit(new CountChanged({ count: next }))                   // row in actor_events, in the turn
const history = counter.events(CountChanged, { after: 0 })           // Stream<ActorEvent<CountChanged>>: replay then live
yield* counter.events().pipe(Stream.runForEach((e) => Effect.log(e.sequence, e.event._tag)))
```

```ts
// Rivet Effect SDK — not wrapped; raw broadcast, no history
yield* Effect.sync(() => rawRivetkitContext.broadcast("countChanged", { count: next }))   // untyped, to live conns only
```

```ts
// Cloudflare DO — build it: a table + a WebSocket fan-out
this.ctx.storage.sql.exec("INSERT INTO events (seq, type, body) VALUES (?, ?, ?)", seq, "CountChanged", JSON.stringify({ count }))
for (const ws of this.ctx.getWebSockets("events")) ws.send(JSON.stringify({ seq, type: "CountChanged", count }))
```

### 2.7 Effects, outbox, dead letters

```ts
// Durable Actors
effects: [SendEmail],
lifecycle: [Effects.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 })))]
// command: durable intent to do it, committed with the turn
yield* ctx.perform(new SendEmail({ to, body }))
// server: executed after COMMIT, at least once
effects: { SendEmail: (ctx, e) => mailer.send(e.to, e.body) },
hooks: [Chat.onEffectFailed((ctx, effect, cause) => ctx.emit(new EmailFailed({ id: effect.messageId })))]
// ops: `test.inspect(Chat, id).deadLetters`, `deadLetters.retry(id)`
```

```ts
// Rivet Effect SDK / DO — the side effect runs inside the action / method
yield* mailer.send(to, body)       // Rivet: if the actor dies after this and before the 1 s flush, the state that said "sent" is gone
this.ctx.waitUntil(sendEmail())    // DO: runs after the reply; not retried, not recorded
```

### 2.8 Cross-actor calls

```ts
// Durable Actors — inside a turn only intents (committed with the turn); request/reply only outside
yield* ctx.actors.get(User, authorId).NoteMessage.send({ roomId: ctx.id, messageId })   // durable, delivered after COMMIT
yield* ctx.self.Idle.after("15 minutes", { key: "idle" })
// outside a turn or in a workflow: full request/reply, one yield for the handle, plain Effects after
const user = yield* User.get(authorId)
yield* user.Join({ roomId })
```

```ts
// Rivet Effect SDK — request/reply from inside an action; requires Client.Client in the handler's R
const user = (yield* User.client).getOrCreate(authorId)
yield* user.NoteMessage({ roomId, messageId })     // if this actor then crashes, nothing remembers the call was made
```

```ts
// Cloudflare DO
await this.env.USER.getByName(authorId).noteMessage(roomId, messageId)   // same: request/reply, not durable
```

### 2.9 Timers and cron

```ts
// Durable Actors — many keyed timers per actor; cron as a policy
yield* ctx.self.Idle.after("15 minutes", { key: "idle" })
yield* ctx.self.Remind.at(dueDate, { key: `remind:${id}` })
yield* ctx.timers.cancel("idle")
lifecycle: [Cron.every("0 3 * * *", Sweep)]                      // per actor; `singleton: true` makes it cluster-wide
```

```ts
// Rivet Effect SDK — not wrapped
yield* Effect.promise(() => rawRivetkitContext.schedule.after(15 * 60_000, "idle"))   // untyped action name
```

```ts
// Cloudflare DO — one alarm per object
await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000)     // replaces the previous alarm; multiplex in storage yourself
async alarm() { … }                                            // retried up to 6× with backoff on throw
// cron: a Worker `scheduled()` handler that calls into the object
```

### 2.10 Workflows

```ts
// Durable Actors — a member of the actor; the body in the server file
export const Ship = Actor.workflow("Ship", { input: { task: Schema.String }, output: Result, errors: [TurnFailed] })
Ship: Effect.fn(function*(ctx, { task }) {
  const turnId = yield* ctx.activity("implement", { output: Schema.String, errors: [TurnFailed], run: ctx.owner.Prompt({ text: task }) })
  const reply = yield* ctx.waitFor(Replied, { where: (e) => e.turnId === turnId, timeout: "1 hour" })
  yield* ctx.sleep("1 day")
  return …
})
const run = yield* agent.Ship.start({ task }, { key: "pr-42" })    // joins the live run under the same key
const result = yield* run.result                                   // Effect<Result, TurnFailed | WorkflowInterrupted>
```

```ts
// Rivet Effect SDK — not wrapped (the Promise SDK has `workflow`, the Effect `toLayer` hard-codes the config)
// You write a state machine: state.step + schedule.after + an action per step.
```

```ts
// Cloudflare Workflows — a separate product with its own binding
export class Ship extends WorkflowEntrypoint<Env, { agentId: string; task: string }> {
  async run(event, step) {
    const turnId = await step.do("implement", async () => this.env.AGENT.getByName(event.payload.agentId).prompt(event.payload.task))
    const reply = await step.waitForEvent<{ text: string }>("reply", { type: `replied:${turnId}`, timeout: "1 hour" })
    await step.sleep("cooldown", "1 day")
    return …
  }
}
await env.SHIP.create({ id: "pr-42", params: { agentId, task } })  // the object must `env.SHIP.get(id).sendEvent(...)` itself
```

Cloudflare's is the strongest *running* workflow engine of the three; it is just not the same runtime as the object, so "wait for my own event" is two bindings and a manual `sendEvent`.

### 2.11 Connections and hibernation

```ts
// Durable Actors — typed frames, park by default
export const Live = Actor.connection("Live", { server: Schema.Union([Delta, Done]), client: Typing, state: { typingSince: … } })
lifecycle: [Connections.park]      // default: activation sleeps on Hibernate.after with sockets open
Live: (ctx, inbound) => inbound.pipe(Stream.tap((f) => ctx.connections.broadcast(f, { except: ctx.conn.id })), Stream.drain)
// ctx.conn.state (≤ 16 KiB) survives the park; ctx.conn.resumed is true on the first frame after a wake
// client
const conn = yield* agent.Live()             // Effect<Connection<Delta | Done, never>, ActorError, Scope>
yield* conn.frames.pipe(Stream.runForEach(render))
```

```ts
// Rivet Effect SDK — not wrapped; `rawRivetkitContext.conns`, `.broadcast`; open connections keep the actor awake
```

```ts
// Cloudflare DO — the model ours copies
async fetch(req) {
  const [client, server] = Object.values(new WebSocketPair())
  this.ctx.acceptWebSocket(server, ["live"])                  // hibernatable
  server.serializeAttachment({ joinedAt: Date.now() })        // ≤ 16,384 bytes; restored after eviction
  return new Response(null, { status: 101, webSocket: client })
}
async webSocketMessage(ws, msg) { const { joinedAt } = ws.deserializeAttachment(); … }
for (const ws of this.ctx.getWebSockets("live")) ws.send(frame)
```

### 2.12 `vars` and `run`

```ts
// Durable Actors
vars: { host: Schema.OptionFromOptionalKey(Schema.String) },     // per activation, dropped on hibernation
run: (ctx) => ctx.state.changes.pipe(Stream.switchMap(follow), Stream.runDrain)   // forked with the activation, restarted on wake
```

```ts
// Rivet Effect SDK — the build effect's scope is the activation; this works, it just has no name
Counter.toLayer(({ state }) => Effect.gen(function*() {
  const host = yield* Ref.make(Option.none<string>())            // "vars"
  yield* State.changes(state).pipe(Stream.runDrain, Effect.forkScoped)   // "run"; interrupted on sleep (verified: finalizer + interrupt in e2e)
  return Counter.of({ … })
}))
```

```ts
// Cloudflare DO
private host?: string                                            // instance field; gone on eviction
constructor(ctx, env) { super(ctx, env); this.ctx.blockConcurrencyWhile(async () => { this.host = await ctx.storage.get("host") }) }
```

This is the part of Rivet's SDK we took: the activation scope *is* the place for per-activation values and background fibers. We gave the two a schema and a name so tests can inspect them and hibernation can drop them deliberately.

### 2.13 Caller and auth

```ts
// Durable Actors — ambient for the program, typed inside the turn
program.pipe(Actor.as(alice))                       // once, for the whole program (CurrentCaller)
Effect.fn(function*(ctx, input) {
  ctx.caller                                        // User { principal } | System { source: "timer" | "cron" | "workflow" | "effect", onBehalfOf }
  if (ctx.caller._tag === "User" && !ctx.caller.principal.roles.includes("member")) return yield* new NotAMember({ … })
})
Actor.serve({ actors, auth: Actor.auth.bearer(verify) })   // HTTP: header → Principal; `Unauthorized({ code })` otherwise
```

```ts
// Rivet Effect SDK — nothing in the SDK; the raw rivetkit has `onBeforeConnect` / `createConnState` (not wrapped)
Increment: ({ payload }) => …                                // no caller in scope; put it in the payload or in an HTTP layer
```

```ts
// Cloudflare DO — nothing; the Worker in front decides
export default { async fetch(req, env) { const user = await verify(req.headers.get("authorization")); return env.COUNTER.getByName(id).increment(5, user) } }
```

### 2.14 Testing

```ts
// Durable Actors — real turn, real cluster entity, real tables; only the edges are swapped
it.layer(Layer.mergeAll(CounterLive, CounterReads).pipe(Layer.provideMerge(ActorTest.layer({ as: alice }))))("Counter", (it) => {
  it.effect("a crash after COMMIT loses only the reply; the retry hits the receipt", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const counter = yield* test.actor(Counter, CounterId.make("c-1"))
      yield* counter.crash({ at: "after-commit", command: "Increment", times: 1 })
      expect(yield* counter.handle.Increment(5)).toBe(5)                  // redelivered, same commandId, replayed from actor_receipts
      const turns = yield* counter.turns
      expect(turns.filter((t) => t.command === "Increment" && !t.replayed)).toHaveLength(1)
      expect((yield* counter.inspect).state).toEqual(Option.some({ count: 5 }))
    }))
  it.effect("the idle timer fires on virtual time", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      yield* test.clock.advance("15 minutes")
      yield* test.settle
      …
    }))
})
```

```ts
// Rivet Effect SDK — verified against test/e2e.test.ts: a real engine, wall-clock polling
const { endpoint, token, namespace, poolName } = await prepareNamespace(inject("rivetEngine").endpoint)
const TestLayer = ReadyForEnvoy.pipe(Layer.provideMerge(Registry.test.pipe(
  Layer.provideMerge(Layer.mergeAll(CounterLive, PingerLive)),
  Layer.provide(Registry.layer({ endpoint, token, namespace, sqlite: "remote" })))))

layer(TestLayer)("end-to-end", (it) => {
  it.effect("persists state across a sleep/wake cycle", () =>
    Effect.gen(function*() {
      const counter = (yield* Counter.client).getOrCreate(["t-persist-state"])
      yield* counter.PersistAndSleep({ amount: 11 })
      // no virtual time: poll a shared Map until the wake-scope finalizer ran
      yield* Effect.sync(() => flags.get("finalizer:t-persist-state")).pipe(
        Effect.repeat({ until: (v) => v === true, schedule: Schedule.spaced("100 millis") }), TestClock.withLive)
      assert.strictEqual((yield* counter.GetPersistedState()).count, 11)
    }))
})
```

```ts
// Cloudflare DO — @cloudflare/vitest-pool-workers
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test"
it("pauses the sandbox when the idle alarm fires", async () => {
  const stub = env.AGENT.getByName("a-1")
  await stub.start("github.com/acme/app")
  await runInDurableObject(stub, async (instance, state) => {
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
  expect(await runDurableObjectAlarm(stub)).toBe(true)          // runs alarm() now; no clock to advance
  await runInDurableObject(stub, async (_i, state) => expect(await state.storage.get("status")).toBe("paused"))
})
```

Rivet's suite is honest about its limits: `Registry.test` leaks the registry until process exit ("no public `shutdown()`"), sleep is observed by polling wall time, and there is no way to crash an actor at a chosen point. DO's is good and real. Ours is the widest by design and runs nowhere yet.

---

## 3. The use case: one OpenCode agent per actor, in an E2B sandbox that sleeps

The actor owns a sandbox (`Sandbox.create`, `pause`, `connect` resumes) running `opencode serve`. A `Prompt` queues a turn; deltas stream to whoever is watching; the reply is durable history; fifteen idle minutes pause the sandbox; a `Ship` job drives several turns and survives restarts. The full Durable Actors version is [example/CodingAgent.ts](example/CodingAgent.ts), [example/CodingAgent.server.ts](example/CodingAgent.server.ts), [example/services.ts](example/services.ts) and [example/CodingAgent.test.ts](example/CodingAgent.test.ts); the abridged shapes are below so the three can be read side by side.

### 3.1 Durable Actors (abridged from the example)

```ts
// CodingAgent.ts — the contract
export const CodingAgent = Actor.make("CodingAgent", {
  commands: [Start, Prompt, Abort, SandboxReady, TurnDone, Idle, SandboxLost],
  internal: [SandboxReady, TurnDone, Idle, SandboxLost],   // executors, the run loop and timers report back as intents
  queries: [Transcript],
  connections: [Live],                                     // Delta | Done frames
  workflows: [Ship],
  events: [SandboxStarted, Prompted, Replied, Aborted, SandboxPaused],
  effects: [StartSandbox, RunPrompt, AbortPrompt, PauseSandbox],
  tables: [agentTurns],
  state: StateV2.fields,
  migrations: [Actor.migration(StateV1, StateV2, (old) => ({ ...old, model: "anthropic/claude-sonnet-4" }))],
  vars: { host: Schema.OptionFromOptionalKey(Schema.String) },
  lifecycle: [Lifecycle.createdBy(Start), Hibernate.after("5 minutes"), Commands.timeout("10 seconds"),
    Effects.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 5 }))), State.maxBytes("16 KiB")]
})

// CodingAgent.server.ts — the turn is a transaction; the sandbox is an effect; following the model is `run`
Prompt: Effect.fn(function*(ctx, { text }) {
  if (Option.isSome(ctx.state.activeTurn)) return yield* new TurnInProgress({ turnId: ctx.state.activeTurn.value.turnId })
  const turnId = ctx.commandId                                    // a retried Prompt is the same turn
  yield* ctx.rows(agentTurns).insert({ turn_id: turnId, prompt: text, reply: "", status: "running", started_at: ctx.now })
  yield* ctx.state.set({ activeTurn: Option.some({ turnId, text }) })
  yield* ctx.emit(new Prompted({ turnId, text }))
  yield* ctx.timers.cancel("idle")
  yield* Option.match(Option.all({ sandboxId: ctx.state.sandboxId, sessionId: ctx.state.sessionId }), {
    onNone: () => Effect.void,                                    // SandboxReady will pick the pending turn up
    onSome: ({ sandboxId, sessionId }) => ctx.perform(new RunPrompt({ turnId, text, sandboxId, sessionId }))
  })
  return turnId
}),
TurnDone: Effect.fn(function*(ctx, { turnId, text, error }) {
  if (!Option.exists(ctx.state.activeTurn, (t) => t.turnId === turnId)) return   // aborted meanwhile: the state is the truth
  yield* ctx.state.set({ activeTurn: Option.none() })
  yield* ctx.rows(agentTurns).update({ reply: text, status: error === undefined ? "replied" : "failed" }, { where: { turn_id: turnId } })
  yield* ctx.emit(error === undefined ? new Replied({ turnId, text }) : new Aborted({ turnId, reason: error }))
  yield* ctx.connections.broadcast(new Done({ turnId }))
  yield* ctx.self.Idle.after("15 minutes", { key: "idle" })
}),
Idle: Effect.fn(function*(ctx) {
  if (Option.isSome(ctx.state.activeTurn)) return
  yield* Option.match(ctx.state.sandboxId, { onNone: () => Effect.void,
    onSome: (sandboxId) => Effect.andThen(ctx.perform(new PauseSandbox({ sandboxId })), ctx.emit(new SandboxPaused({ sandboxId }))) })
}),
Ship: Effect.fn(function*(ctx, { task }) {
  const ask = (name: string, text: string) => Effect.gen(function*() {
    const turnId = yield* ctx.activity(name, { output: Schema.String, errors: [TurnFailed],
      run: ctx.owner.Prompt({ text }).pipe(Effect.retry({ while: (e) => e._tag === "TurnInProgress", schedule: … })) })
    const reply = yield* ctx.waitFor(Replied, { where: (e) => e.turnId === turnId, timeout: "1 hour" })
    return yield* Option.match(reply, { onNone: () => new TurnFailed({ turnId, reason: "no reply within an hour" }), onSome: (e) => Effect.succeed(e.text) })
  })
  yield* ask("implement", `Implement this task, then stop: ${task}`)
  const summary = yield* ask("verify", "Run the tests, fix what you broke, commit, summarise.")
  return { turns: 2, summary }
})
// effects: StartSandbox → sandboxes.create + opencode.createSession → ctx.self.SandboxReady.send(...)
//          RunPrompt   → sandboxes.connect (resumes a paused sandbox) → opencode.prompt; SandboxGone → ctx.self.SandboxLost.send
// run: follows opencode.events for the active turn, broadcasts Delta frames, ends with ctx.self.TurnDone.send(...)
```

```ts
// CodingAgent.test.ts — nothing about the actor is mocked; E2B and OpenCode are in-memory fakes fed by the test
it.effect("a runner crash after COMMIT replays the Prompt from the receipt, and the run loop still delivers the reply", () =>
  Effect.gen(function*() {
    const test = yield* ActorTest
    const agent = yield* booted                                               // Start + held StartSandbox run + settle
    yield* agent.crash({ at: "after-commit", command: "Prompt", times: 1 })
    const turnId = yield* agent.handle.Prompt({ text: "add a health endpoint" })
    expect((yield* agent.turns).filter((t) => t.command === "Prompt" && !t.replayed)).toHaveLength(1)
    yield* streamReply(yield* Fakes, ["ok ", "done"])
    yield* test.settle
    const state = yield* agent.inspect
    expect(state.events.map((e) => e.event._tag)).toEqual(["SandboxStarted", "Prompted", "Replied"])
    expect(yield* agent.handle.Transcript({ limit: 1 })).toEqual([{ turnId, prompt: "add a health endpoint", reply: "ok done", status: "replied" }])
  }))

it.effect("fifteen idle minutes pause the sandbox and the activation hibernates; the transcript still answers", () =>
  Effect.gen(function*() {
    const test = yield* ActorTest
    const agent = yield* booted
    yield* test.clock.advance("15 minutes")
    yield* test.effects.run                                                    // the held PauseSandbox
    yield* test.settle
    expect((yield* agent.inspect).resident).toBe(false)
    expect(yield* Ref.get((yield* Fakes).paused)).toEqual([SandboxId.make("sb-1")])
  }))

it.effect("Ship survives a crash inside its first activity and does not prompt twice", () =>
  Effect.gen(function*() {
    const test = yield* ActorTest
    const agent = yield* booted
    yield* agent.workflows.crashActivity(Ship, "implement", { at: "afterBodyBeforeResult" })
    const run = yield* agent.handle.Ship.start({ task: "paginate users" })
    … // reply to both turns through the fakes
    expect((yield* run.result).turns).toBe(2)
    expect((yield* agent.inspect).events.filter((e) => e.event._tag === "Prompted")).toHaveLength(2)
  }))
```

### 3.2 Rivet Effect SDK

Everything the SDK wraps is used; everything it does not is reached through `rawRivetkitContext` and typed by hand.

```ts
export const Start = Action.make("Start", { payload: { repo: Schema.String } })
export const Prompt = Action.make("Prompt", { payload: { text: Schema.String }, success: Schema.String, error: TurnInProgress })
export const Abort = Action.make("Abort", { error: NoActiveTurn })
export const Transcript = Action.make("Transcript", { payload: { limit: Schema.Number }, success: Schema.Array(Turn) })
export const CodingAgent = Actor.make("CodingAgent", { actions: [Start, Prompt, Abort, Transcript] })

const AgentState = Schema.Struct({
  repo: Schema.String,
  sandboxId: Schema.Option(SandboxId),
  sessionId: Schema.Option(OpenCodeSessionId),
  activeTurn: Schema.Option(Schema.Struct({ turnId: Schema.String, text: Schema.String })),
  step: Schema.Option(Schema.Literals(["implement", "verify"]))          // the "workflow", by hand
})

export const CodingAgentLive = CodingAgent.toLayer(
  ({ rawRivetkitContext: raw, state }) =>
    Effect.gen(function*() {
      const sandboxes = yield* Sandboxes
      const opencode = yield* OpenCode
      const db = raw.db                                                     // any
      const host = yield* Ref.make(Option.none<string>())                  // "vars"

      // "run": follow OpenCode while a turn is active; dies with the wake scope when the actor sleeps
      yield* State.changes(state).pipe(
        Stream.map((s) => Option.all({ turn: s.activeTurn, sandboxId: s.sandboxId, sessionId: s.sessionId })),
        Stream.changesWith((a, b) => Option.getOrUndefined(a)?.turn.turnId === Option.getOrUndefined(b)?.turn.turnId),
        Stream.switchMap((t) => Option.match(t, { onNone: () => Stream.empty, onSome: ({ turn, sandboxId, sessionId }) =>
          Stream.fromEffect(Effect.gen(function*() {
            const h = yield* Effect.map(sandboxes.connect(sandboxId), (s) => s.host)
            const text = yield* opencode.connect(h).events.pipe(
              Stream.filter((e) => e.sessionId === sessionId), Stream.takeUntil((e) => e._tag !== "Delta"),
              Stream.tap((e) => e._tag === "Delta" ? Effect.sync(() => raw.broadcast("delta", { turnId: turn.turnId, text: e.text })) : Effect.void),
              Stream.runFold(() => "", (acc, e) => e._tag === "Delta" ? acc + e.text : acc))
            // no intents: write the reply here, in the run loop, and hope the 1 s flush lands before a crash
            yield* Effect.tryPromise(() => db.execute("UPDATE turns SET reply = ?, status = 'replied' WHERE turn_id = ?", text, turn.turnId)).pipe(Effect.orDie)
            yield* State.update(state, (s) => ({ ...s, activeTurn: Option.none() })).pipe(Effect.orDie)
            yield* Effect.sync(() => raw.broadcast("done", { turnId: turn.turnId }))
            yield* Effect.promise(() => raw.schedule.after(15 * 60_000, "idle"))      // untyped action name
          }).pipe(Effect.catchTag("SandboxGone", () => State.update(state, (s) => ({ ...s, sandboxId: Option.none() })).pipe(Effect.orDie)))) })),
        Stream.runDrain, Effect.forkScoped)

      return CodingAgent.of({
        Start: ({ payload }) => Effect.gen(function*() {
          yield* State.update(state, (s) => ({ ...s, repo: payload.repo })).pipe(Effect.orDie)
          const sb = yield* sandboxes.create({ repo: payload.repo }).pipe(Effect.orDie)     // inside the action: the caller waits for E2B
          const session = yield* opencode.connect(sb.host).createSession.pipe(Effect.orDie)
          yield* State.update(state, (s) => ({ ...s, sandboxId: Option.some(sb.id), sessionId: Option.some(session) })).pipe(Effect.orDie)
        }),
        Prompt: ({ payload }) => Effect.gen(function*() {
          const s = yield* State.get(state).pipe(Effect.orDie)
          if (Option.isSome(s.activeTurn)) return yield* new TurnInProgress({ turnId: s.activeTurn.value.turnId })
          const turnId = crypto.randomUUID()                                  // no client-minted id: a retried Prompt is a second turn
          yield* Effect.tryPromise(() => db.execute("INSERT INTO turns (turn_id, prompt, status) VALUES (?, ?, 'running')", turnId, payload.text)).pipe(Effect.orDie)
          yield* State.update(state, (x) => ({ ...x, activeTurn: Option.some({ turnId, text: payload.text }) })).pipe(Effect.orDie)
          const sb = yield* sandboxes.connect(Option.getOrThrow(s.sandboxId)).pipe(Effect.orDie)   // resumes; the caller waits
          yield* opencode.connect(sb.host).prompt(Option.getOrThrow(s.sessionId), payload.text).pipe(Effect.orDie)
          return turnId
        }),
        Abort: () => …,
        Transcript: ({ payload }) => Effect.tryPromise(() => db.execute<Turn>("SELECT … ORDER BY started_at DESC LIMIT ?", payload.limit)).pipe(Effect.orDie)
      })
    }),
  {
    state: { schema: AgentState, initialValue: () => ({ repo: "", sandboxId: Option.none(), sessionId: Option.none(), activeTurn: Option.none(), step: Option.none() }) },
    db: db({ onMigrate: async (c) => { await c.execute("CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, prompt TEXT, reply TEXT, status TEXT, started_at INTEGER)") } })
  }
)
// not wrapped, so: the "idle" schedule target is a raw action registered outside `CodingAgent.of`, the Live connection is
// `raw.conns` + `raw.broadcast` with hand-written frame types, and `Ship` is `state.step` + `schedule.after` + a re-entrant action.
```

```ts
// Test — a real engine, wall-clock polling, no fault injection, E2B/OpenCode fakes via Layer
layer(TestLayer)("CodingAgent", (it) => {
  it.effect("prompt → reply", () =>
    Effect.gen(function*() {
      const agent = (yield* CodingAgent.client).getOrCreate("a-1")
      yield* agent.Start({ repo: "github.com/acme/app" })
      const turnId = yield* agent.Prompt({ text: "add a health endpoint" })
      yield* streamReply(fakes, ["ok ", "done"])
      const rows = yield* Effect.sync(() => 0).pipe(                          // poll until the run loop wrote the reply
        Effect.andThen(agent.Transcript({ limit: 1 })),
        Effect.repeat({ until: (r) => r[0]?.status === "replied", schedule: Schedule.spaced("100 millis") }),
        TestClock.withLive)
      assert.strictEqual(rows[0]?.reply, "ok done")
    }))
  // not expressible: "crash after the Prompt's state write but before the 1 s flush", "advance 15 minutes", "kill the runner mid-turn"
})
```

### 3.3 Cloudflare Durable Objects (+ Workflows)

```ts
export class CodingAgent extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS turns (turn_id TEXT PRIMARY KEY, prompt TEXT, reply TEXT, status TEXT, started_at INTEGER)")
  }
  async start(repo: string) {
    const sb = await Sandbox.create()                                          // the caller waits for E2B
    await sb.commands.run(`git clone ${repo} /home/user/repo`)
    await sb.commands.run("cd /home/user/repo && opencode serve --port 4096", { background: true })
    const client = createOpencodeClient({ baseUrl: `https://${sb.getHost(4096)}` })
    const session = await client.session.create({}, { throwOnError: true })
    await this.ctx.storage.put({ repo, sandboxId: sb.sandboxId, sessionId: session.data.id })
  }
  async prompt(text: string): Promise<string> {
    const active = await this.ctx.storage.get<{ turnId: string }>("activeTurn")
    if (active) throw new Error(`TurnInProgress:${active.turnId}`)              // string-typed error
    const turnId = crypto.randomUUID()
    this.ctx.storage.sql.exec("INSERT INTO turns VALUES (?, ?, '', 'running', ?)", turnId, text, Date.now())
    await this.ctx.storage.put("activeTurn", { turnId, text })
    await this.ctx.storage.deleteAlarm()
    const { sandboxId, sessionId } = await this.ctx.storage.get<Record<string, string>>(["sandboxId", "sessionId"]) as any
    const sb = await Sandbox.connect(sandboxId)                                 // resumes; the caller waits
    const client = createOpencodeClient({ baseUrl: `https://${sb.getHost(4096)}` })
    await client.session.promptAsync({ sessionID: sessionId, parts: [{ type: "text", text }] })
    this.ctx.waitUntil(this.follow(client, sessionId, turnId))                  // "run": dies on eviction, not restarted
    return turnId
  }
  private async follow(client, sessionId: string, turnId: string) {
    let text = ""
    for await (const ev of (await client.event.subscribe()).stream) {
      if (ev.properties?.sessionID !== sessionId) continue
      if (ev.type === "message.part.delta") { text += ev.properties.delta; for (const ws of this.ctx.getWebSockets("live")) ws.send(JSON.stringify({ type: "delta", turnId, text: ev.properties.delta })) }
      if (ev.type === "session.idle") break
    }
    this.ctx.storage.sql.exec("UPDATE turns SET reply = ?, status = 'replied' WHERE turn_id = ?", text, turnId)
    await this.ctx.storage.delete("activeTurn")
    for (const ws of this.ctx.getWebSockets("live")) ws.send(JSON.stringify({ type: "done", turnId }))
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000)                   // the one alarm: idle
    await this.env.SHIP.get(turnId).sendEvent({ type: `replied:${turnId}`, payload: { text } }).catch(() => {})   // for the workflow, if any
  }
  async alarm() {
    if (await this.ctx.storage.get("activeTurn")) return
    const sandboxId = await this.ctx.storage.get<string>("sandboxId")
    if (sandboxId) await (await Sandbox.connect(sandboxId)).pause()
  }
  async fetch(req: Request) {                                                   // the Live connection
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server, ["live"])
    return new Response(null, { status: 101, webSocket: client })
  }
  async webSocketMessage() {}                                                   // client sends nothing
  transcript(limit: number) { return this.ctx.storage.sql.exec("SELECT * FROM turns ORDER BY started_at DESC LIMIT ?", limit).toArray() }
}

export class Ship extends WorkflowEntrypoint<Env, { agentId: string; task: string }> {
  async run(event, step) {
    const ask = async (name: string, text: string) => {
      const turnId = await step.do(name, () => this.env.AGENT.getByName(event.payload.agentId).prompt(text))
      const { payload } = await step.waitForEvent<{ text: string }>(`${name}:reply`, { type: `replied:${turnId}`, timeout: "1 hour" })
      return payload.text
    }
    await ask("implement", `Implement this task, then stop: ${event.payload.task}`)
    const summary = await ask("verify", "Run the tests, fix what you broke, commit, summarise.")
    return { turns: 2, summary }
  }
}
```

```ts
// Test — @cloudflare/vitest-pool-workers; E2B and OpenCode need fetch mocks (`fetchMock` from cloudflare:test)
it("pauses the sandbox on the idle alarm", async () => {
  const stub = env.AGENT.getByName("a-1")
  await stub.start("github.com/acme/app")
  await stub.prompt("hi")
  // no way to feed the follow() loop from the test except through fetchMock's SSE body
  expect(await runDurableObjectAlarm(stub)).toBe(true)
  await runInDurableObject(stub, async (_i, state) => expect(await state.storage.get("activeTurn")).toBeUndefined())
})
```

### 3.4 What the use case exposes

| Requirement | Durable Actors | Rivet Effect SDK | Cloudflare DO |
| --- | --- | --- | --- |
| `Prompt` returns before E2B resumes the sandbox | 🟢 `ctx.perform(RunPrompt)` after COMMIT | 🔴 the action awaits `Sandbox.connect` | 🔴 the method awaits `Sandbox.connect` |
| A retried `Prompt` is the same turn | 🟢 `turnId = ctx.commandId` + receipts | 🔴 second turn | 🔴 second turn |
| The reply is recorded even if the runner dies mid-follow | 🟢 `TurnDone` is an intent; `run` re-follows from committed state on wake | 🟡 the run loop dies with the scope; re-follow must be hand-written in the build effect; the write may miss the 1 s flush | 🔴 `waitUntil` is killed on eviction; nothing restarts it |
| Deltas to watchers, nothing persisted per delta | 🟢 `Live` connection + `broadcast` | 🟡 `raw.broadcast`, untyped | 🟢 hibernatable sockets |
| Idle → pause the sandbox; hibernate the activation | 🟢 keyed timer + `Hibernate.after` | 🟡 `raw.schedule.after`; sleep is the engine's `sleepTimeout` | 🟢 alarm + eviction |
| Sandbox gone → start over if a turn is pending | 🟢 `SandboxLost` intent from the executor | 🟡 catch in the run loop | 🟡 catch in `follow` |
| Multi-turn `Ship` survives restarts, no double prompt | 🟢 workflow member, `crashActivity` tested | 🔴 hand-rolled state machine | 🟢 Workflows, but two bindings and a manual `sendEvent` |
| Per-turn transcript is queryable without waking the agent | 🟢 `Transcript` query on committed rows | 🔴 | 🔴 |
| Test: crash at a chosen point, advance time, kill a runner | 🟢 by design | 🔴 | 🟡 alarms can be fired; no crash points |

---

## 4. Ranks, out of 10

Two axes because the honest answer depends on the question.

### 4.1 The design: what the API lets a team express and verify

| | Score | Why |
| --- | --- | --- |
| **Durable Actors** | **9** | Every concept in §1 has a typed home, errors never collapse, side effects and cross-actor calls are transactional, tests reach every seam. Minus one for the two things the design cannot fix: a DB round trip per turn, and a large surface (11 member kinds, 14 policies) that has to earn its keep in practice. |
| **Cloudflare DO** | **6** | The most complete *runtime* feature set of the three (SQLite, PITR, hibernatable sockets, alarms, Workflows next door) with an API that is a plain class: no typed errors over RPC, one alarm, no events, no outbox, no receipts, no caller, no tenancy, and every method wakes the object. |
| **Rivet Effect SDK** | **4** | The wrapped part is well done — typed actions, `State` with `E`, spans across the wire, `Registry.test` — and it is the part we borrowed from. But `toLayer` takes four options; connections, schedule, cron, queues, workflows, `vars`, `run`, db access and auth are "not yet wrapped" and reached through an `any`-typed raw context; state is persisted on an interval the SDK cannot set; the accessor has only `getOrCreate`; the API is declared beta. |

### 4.2 What runs today

| | Score | Why |
| --- | --- | --- |
| **Cloudflare DO** | **9** | GA, global, billed by the millisecond, five years of production behind it. Minus one for the untyped RPC errors and single alarm you live with. |
| **Rivet Effect SDK** | **5** | It runs against a real engine and the e2e suite passes; the beta label, the raw-context escape hatch on most features, and the interval persistence are real limits today. |
| **Durable Actors** | **0** | Nothing executes. `turn()`, `makeHandle`, the harness, the outbox, the intent relay are all `declare`d. The eight verification gates in [DECISIONS.md](DECISIONS.md) §3 — Neki cross-shard-group intents, generation fencing behind a pooler, PGlite under Bun, the in-process N-runner cluster — are open. |

### 4.3 The coding-agent use case specifically

| | Score | Why |
| --- | --- | --- |
| **Durable Actors** (as designed) | **9** | Every row in §3.4 is green except the latency of the turn itself, and the use case is dominated by model latency, not database latency. |
| **Cloudflare DO + Workflows** | **6** | Works end to end and hibernates properly; the follow loop is unprotected (`waitUntil` dies on eviction), a retried prompt double-prompts, and the workflow lives in a second product. |
| **Rivet Effect SDK** | **4** | The typed core is pleasant; the sandbox lifecycle, the run loop, the idle timer, the connection and the multi-turn job are all raw-context or hand-rolled, and the turn-recorded-before-crash guarantee is not available. |

### 4.4 What we should take from each, and what we should not claim

From Rivet (taken, decision 165): the activation scope as the home for per-activation values and background fibers (`vars`, `run`), `State.changes`, one error class with a `reason` and `isRetryable`, spans propagated across the wire, `Registry.test`'s "the real thing in-process" stance. From DO (taken, decision 163): hibernation with sockets parked at the edge and a small per-connection attachment, alarms-as-timers, SQL as the actor's big storage. From neither: per-actor databases. One relational database is the bet that makes cross-actor queries, tenancy-as-rows and transactional cross-actor intents possible, and the round trip is its cost.

What we must not claim until the gates close: exactly-once under crashes, intents atomic with the turn on Neki, hibernation-with-parked-sockets, the N-runner harness, and any number for latency. The design is ahead; the implementation is at zero.
