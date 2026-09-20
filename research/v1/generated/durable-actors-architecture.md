# Durable Actors — Architecture

**Company:** Rika Labs
**Status:** Final architecture direction for V1, with V2 and research items separated. Design, not implementation. Every number labeled *estimate* is an estimate; every external fact carries a read date.
**Foundation:** Effect v4 (`4.0.0-rc.116` on `main`, read 2026-09-18), Bun primary, Node 24 compatible
**Packages:** `@durable-actors/core` (programming model, runtime, Postgres/pglite store) plus `testing`, `cli`, `ingress`; later `neki`, `cloudflare`
**Supersedes:** `durable-actors-v1-surface.md`, `durable-actors-scenarios.md`, `durable-actors-adversarial-review.md`, `durable-actors-hybrid-review.md`, `durable-actors-global-distribution.md`, and the docs under `attachments/package/durable-actors/`. Where this document and an earlier one disagree, this document wins; §11 lists each change.

How to read: §0 is the whole design on two pages. §3 is the complete public surface with types. §4–§6 explain what the runtime does with those types. §11 records every decision and what we rejected. Skip §8–§10 unless you are building or operating it.

---

## 0. The design on two pages

### 0.1 One sentence

An actor is an identity with exclusive authority to change some rows in a relational database; the framework makes one command to that identity one database transaction that also commits the actor's events, its reply, and every durable thing it intends to do next.

### 0.2 Three guarantees, and the one rule that makes them cheap

```text
G1  One command = one transaction.
    state + events + receipt + outgoing intents + timers + turn counter commit together, or nothing does.

G2  One writer per actor, enforced by the database, not by a lease.
    Every turn checks the actor's fence row under lock; a stale owner cannot commit.

G3  SQL sees the world; only actors change it.
    Any process may read every table in a cell in one snapshot. Business tables are writable
    only inside a turn, through the actor that owns the row's key.
```

The rule that keeps these cheap on one Postgres and on sharded Postgres alike:

> **A turn writes only rows that carry its own actor key, plus its own receipt and outbox rows. A target outside the turn's transaction domain is reached through the outbox.**

### 0.3 The runtime, drawn once

Same code, three sizes. Nothing in the programming model knows which one it is on.

```diagram
                              ┌───────────────────────────────────────────────┐
  clients                     │ ingress (optional in V1; a Bun process or a   │
  HTTP / RPC / SSE / WS  ───▶ │ Cloudflare Worker) auth · project → cell ·    │
                              │ ETag cache · WebSocket termination            │
                              └───────────────┬───────────────────────────────┘
                                              │
              ┌───────────────────────────────┼─────────────────────────────────┐
              ▼                               ▼                                 ▼
  ┌────────────────────┐        ┌────────────────────┐            ┌────────────────────┐
  │ cell us-east       │        │ cell eu-central    │            │ cell ap-south      │
  │                    │        │                    │            │                    │
  │ actor runners ×N   │        │ actor runners ×N   │            │ actor runners ×N   │
  │ worker runners ×M  │        │ worker runners ×M  │            │ worker runners ×M  │
  │ (Bun, Effect       │        │                    │            │                    │
  │  Cluster+Workflow) │        │                    │            │                    │
  │        │           │        │        │           │            │        │           │
  │        ▼           │        │        ▼           │            │        ▼           │
  │ Postgres  or  Neki │        │ Postgres  or  Neki │            │ Postgres  or  Neki │
  │ + S3-compatible    │        │ + S3-compatible    │            │ + S3-compatible    │
  └─────────┬──────────┘        └─────────┬──────────┘            └─────────┬──────────┘
            │          outbox relay       │          outbox relay            │
            └─────────────────────────────┴──────────────────────────────────┘

  control plane (tiny, replicated, rarely written): project → home cell · cell endpoints

  local dev / CI = one cell = one process = Runner.dev + pglite + filesystem blobs
  self-hosted    = one or more cells on your Postgres
  Rika Cloud     = cells we run, Neki when a cell outgrows one primary, console over the same tables
```

Inside a cell: one command is one transaction; SQL sees the cell in one snapshot; a send to an actor in the same transaction domain commits inside the turn. Across shards or cells: the same `ctx.send` becomes an outbox row relayed at-least-once with `message_id` dedupe.

### 0.4 Where it sits

| | Rivet Actors / Cloudflare DO | Orleans / Akka | Temporal / Restate | **Durable Actors** |
|---|---|---|---|---|
| Actor boundary | = storage boundary (private SQLite/KV) | = in-memory grain; storage pluggable | workflow, not actor | = mutation authority; storage shared relational |
| Cross-actor query | fan-out RPC or your own projection | your own storage | your own storage | plain SQL over the cell, same snapshot |
| Command atomicity | per object | per grain + external store | journaled steps | one Postgres transaction incl. intents |
| Durable functions | DO alarms / Rivet workflows | none built-in | core product | Effect Workflow, bridged to actor commands |
| Local test | Miniflare / rivet dev | in-memory silo | test server | in-process cell: pglite + TestClock + fault points |
| Runtime | vendor edge | JVM/.NET | server + SDK | one Bun/Node Effect runtime everywhere |

The unusual capability is G3: **millions of independently serialized actors over one relational system, where reads ignore actor boundaries and writes respect them**. Rivet and DO make the database follow the actor. We make only writes follow it.

### 0.5 What we do not claim

- Not exactly-once side effects. At-least-once delivery with deduplicated state transitions; external effects need idempotency keys.
- Not one snapshot across cells or across Neki shards. Consistent inside a transaction domain, eventual across domains.
- Not multi-master. One writer per actor, one home cell per actor, fixed at creation in V1.
- Not intra-actor concurrency. One turn at a time per actor in V1; "serialize conflicts, not requests" is research (§13.4).
- Not a hosted general-purpose function platform, not a second query language, not an ORM.

---

## 1. Thesis: three questions, three tools, one transaction

Modern backends made compute disposable and pushed durable responsibility into databases, queues, schedulers and workflow engines. The application then reconstructs each durable thing — an order, a device, an agent — from four systems on every request. Durable Actors makes the durable thing the unit of programming and answers three distinct questions with three tools it already trusts:

```text
Who may change this state?           → the actor      (serialized, fenced authority)
How does this state relate to rest?  → the database   (relational, one snapshot per cell)
What must survive time and failure?  → the workflow   (Effect Workflow: journal, sleep, deferred)
```

Nothing in the actor literature (Hewitt 1973; Agha 1986) requires one database per actor. An actor is identity + mailbox + behavior + authority over its own transitions. "Actor = SQLite file" is an implementation choice that trades away relational observation. We keep the actor's authority and give observation back to SQL.

Consequences developers feel:

- Tomorrow's question does not need to be designed into today's protocol. Support writes SQL; then repairs through commands.
- A backfill over 10^8 actors is a keyset-paginated `SELECT` plus `send`, not a fleet traversal API.
- Fan-in of 10^6 completions is a `SUM` over sharded stats rows, not one actor consuming 10^6 messages.
- Every actor's history, mailbox, timers, and outbox are rows an operator can inspect with the same SQL.

---

## 2. Vocabulary in three tiers

Developers see the first tier. Operators see the third. The middle tier is the contract between them and is where correctness lives.

```diagram
┌─ programming model (what you write) ───────────────────────────────────────────────┐
│ Actor · command · query · event · broadcast · timer · activity · job · workflow ·   │
│ cron · Database · BlobStore · Actors · ActorRef · Placement                        │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ compiled onto
┌─ runtime model (what is guaranteed) ─▼─────────────────────────────────────────────┐
│ turn · fence (generation) · receipt · delivery (accepted/committed/delivered) ·     │
│ ordering · admission · transaction domain · outbox · activation/passivation ·      │
│ incarnation · retention                                                             │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ deployed as
┌─ topology (where it runs) ───────────▼─────────────────────────────────────────────┐
│ runner · pool · store · shard · cell · ingress · edge adapter · control plane ·    │
│ console                                                                             │
└────────────────────────────────────────────────────────────────────────────────────┘
```

| Term | Tier | One-line definition |
|---|---|---|
| actor | programming | an identity `(type, id)` with exclusive authority over rows carrying its key |
| command | programming | a serialized durable mutation of one actor; persisted, deduplicated, replied to |
| query | programming | a committed read of one actor, routed to its owner; volatile |
| event | programming | a durable, ordered fact appended in the turn; replayable |
| broadcast | programming | an ephemeral realtime signal published after commit; no history |
| timer | programming | a command to self with a delivery time, committed in the turn |
| activity | programming | one durable external side effect whose result returns to an actor as a command |
| job | programming | durable background work that is not anyone's truth |
| workflow | programming | a durable multi-step procedure with sleep, waits, and steps |
| cron | programming | recurring durable work |
| turn | runtime | the transaction that processes one command |
| fence | runtime | the `actors` row check that makes one writer per actor a database fact |
| receipt | runtime | the stored reply keyed by `message_id`; makes redelivery safe |
| transaction domain | runtime | the set of rows one transaction may write atomically: a database, or one Neki shard |
| outbox | runtime | committed intents whose target is outside the transaction domain |
| generation | runtime | the ownership epoch of an actor; increases on each activation handoff |
| incarnation | runtime | the data-lineage epoch of an actor's rows; increases on restore |
| runner | topology | one Bun/Node process running Effect Cluster; serves actor and/or worker pools |
| pool | topology | a named group of runners serving activities/jobs/workflows; maps to a Cluster shard group |
| store | topology | the `ActorStore` implementation: `pglite`, `postgres`, `neki` |
| shard | topology | one Neki Postgres shard; a transaction domain |
| cell | topology | one complete deployment of runners + store + blobs; an independent Effect cluster |
| ingress | topology | stateless entry that resolves project → cell and forwards; a Bun process or a Cloudflare Worker |
| home | programming/topology | the cell an actor lives in; chosen by `Placement` at creation |

"Cell" is deliberately not a programming-model concept. The only things that leak to application code are `placement` on `Actor.make` and the `home` field on an inspected actor.

---

## 3. Programming model: the complete surface

Design rules for the surface, in priority order:

1. `Actor.*` is the single namespace: `make`, `command`, `query`, `event`, `protocol`, `events`, `activity`, `job`, `workflow`, `cron`, `Key`. Lowercase constructors match `Actor.make` and Effect's `Rpc.make` / `Entity.make`.
2. Wrap an Effect API only when the wrapper must run inside the turn transaction, be keyed by actor identity, or route its result back to an actor. Everything else (`Schema`, `Layer`, `Config`, `HttpApi`, `Rpc`, `SqlClient`, `Migrator`, `TestClock`, `DurableDeferred`, `LanguageModel`) is used directly.
3. Illegal things are type errors where the type system can see them (waiting on another actor inside a turn) and runtime rejections where it cannot (a raw write without the actor key).
4. The definition (`Actor.make`) is separate from the implementation (`toLayer`) so clients, tests, and other services import protocols without importing handlers.

### 3.1 Identity

```ts
import { Actor } from "@durable-actors/core"

// The id part of an actor key. Branded so that a table column typed Actor.Key
// can be recognized by the framework as "this row belongs to that actor".
Actor.Key: Schema.brand<Schema.String, "ActorKey">

export interface ActorAddress {
  readonly project: string   // application + environment, e.g. "acme/prod". Supplied by the runtime, never by app code.
  readonly type: string      // "Order"
  readonly id: string        // "order_123"
}

// String forms
//   store key   `${type}/${id}`             unique inside one project's store; what every runtime table carries
//   global key  `${project}/${type}/${id}`  unique across Rika Cloud; what ingress and the control plane route on
```

A project is a closed world: actors send to actors in the same project. Cross-project integration is HTTP/RPC like any other system. Business tables never carry a project column; a project is isolated by database or schema (§9.3).

### 3.2 Tables

Tables are typed declarations over ordinary SQL tables. Migrations are SQL you write and Effect `Migrator` runs; the framework renders the initial `CREATE TABLE` from the declaration and verifies the live schema against it (`actors doctor`). There is no diffing ORM.

```ts
import { Schema } from "effect"
import { Actor, Database } from "@durable-actors/core"

export const OrderStatus = Schema.Literals(["draft", "placed", "paying", "paid", "cancelled"])

export const Orders = Database.table("orders", {
  actorId: Actor.Key,                              // leads the primary key; the future shard key; immutable
  status: OrderStatus,
  customerId: Schema.NullOr(Schema.String),        // plain column: no FK to `customers`, that is another actor's row
  totalCents: Schema.Int,
  invoiceKey: Schema.NullOr(Schema.String),        // a BlobStore reference, not bytes
  taxVersion: Schema.Int,
}).pipe(Database.primaryKey("actorId"))

export const OrderItems = Database.table("order_items", {
  actorId: Actor.Key,
  itemId: Schema.String,                           // from ctx.ids.next — never SERIAL/identity
  sku: Schema.String,
  quantity: Schema.Int,
  priceCents: Schema.Int,
}).pipe(
  Database.primaryKey("actorId", "itemId"),
  Database.index("order_items_sku_idx", ["sku"]),   // secondary indexes need not lead with the actor key
)

export const PaymentAttempts = Database.table("payment_attempts", {
  actorId: Actor.Key,
  attemptId: Schema.String,
  paymentMethodId: Schema.String,
  outcome: Schema.Literals(["pending", "captured", "declined", "unknown"]),
  receiptId: Schema.NullOr(Schema.String),
}).pipe(Database.primaryKey("actorId", "attemptId"))

export const OrderDatabase = Database.make(Orders, OrderItems, PaymentAttempts).pipe(
  Database.migrations({
    "0001_orders": Database.ddl(Orders, OrderItems, PaymentAttempts),  // rendered CREATE TABLE + PK + indexes + db_shard column + RLS policies (§5.1–5.2)
    "0002_tax_version": sql`ALTER TABLE orders ADD COLUMN tax_version INT NOT NULL DEFAULT 1`,
  }),
)
```

```ts
interface Table<Name extends string, Fields extends Schema.Struct.Fields> {
  readonly name: Name
  readonly fields: Fields
  readonly primaryKey: ReadonlyArray<keyof Fields>   // must begin with the Actor.Key column
  readonly indexes: ReadonlyArray<Index>
  readonly Row: Schema.Struct<Fields>                 // decoded row type
  readonly Insert: Schema.Struct<Omit<Fields, "actorId">>
  readonly Patch: Schema.Struct<Partial<Omit<Fields, "actorId">>>
}
interface DatabaseDef { readonly tables: ReadonlyArray<Table>; readonly migrations: Migrator.Loader }
```

Rules the framework enforces at `actors migrate` / `actors doctor` time and, where possible, at compile time. Each is a Neki requirement and a sound idea on plain Postgres:

| Rule | Why | Enforcement |
|---|---|---|
| D1 Exactly one `Actor.Key` column per actor-owned table; it leads every PK and UNIQUE | rows of one actor colocate on one shard; uniqueness is per shard on Neki | type check in `Database.table`; DDL check in `doctor` |
| D2 No database FKs between rows of different actors | cross-shard FKs are impossible on Neki; cross-actor invariants are protocols, not constraints | `doctor` rejects FK constraints whose target table has a different owner type |
| D3 No `SERIAL`/identity columns in actor tables | sequences are single-shard on Neki and a hotspot on Postgres | `doctor`; ids come from `ctx.ids.next` |
| D4 A turn writes only rows carrying its own actor key | keeps a turn a single-shard transaction; makes G2 meaningful | `Database` API by construction; row-level security on the turn role, including raw `db.sql` (§5.2) |
| D5 Cross-actor writes exist only as messages | G1 across actors would need distributed transactions | there is no API for it |

### 3.3 Protocol: commands, queries, events

```ts
export const Get = Actor.query("Get", {
  output: Schema.Struct({ id: Schema.String, status: OrderStatus, totalCents: Schema.Int, version: Schema.Int }),
})
export const Items = Actor.query("Items", { output: Schema.Array(OrderItems.Row) })

export class OrderNotDraft extends Schema.TaggedError<OrderNotDraft>()("OrderNotDraft", {
  orderId: Schema.String, status: OrderStatus,
}) {}
export class CannotPay extends Schema.TaggedError<CannotPay>()("CannotPay", { orderId: Schema.String, status: OrderStatus }) {}

export const AddItem = Actor.command("AddItem", {
  input: Schema.Struct({ sku: Schema.String, quantity: Schema.Int, priceCents: Schema.Int }),
  error: OrderNotDraft,
})
export const Place = Actor.command("Place", { input: Schema.Struct({ customerId: Schema.String }), error: OrderNotDraft })
export const Pay = Actor.command("Pay", {
  input: Schema.Struct({ paymentMethodId: Schema.String }),
  error: CannotPay,
  idempotency: ({ paymentMethodId }) => paymentMethodId,   // derived idempotency key when the caller passes none
})
export const RecalculateTax = Actor.command("RecalculateTax", { input: Schema.Struct({ version: Schema.Int }) })

// internal: only the runtime (timers, activities, jobs, workflows, other actors) may send these; transports never expose them
export const PaymentCaptured = Actor.command("PaymentCaptured", { input: Schema.Struct({ receiptId: Schema.String }), internal: true })
export const PaymentFailed   = Actor.command("PaymentFailed",   { input: Schema.Struct({ reason: Schema.String }),    internal: true })
export const InvoiceReady    = Actor.command("InvoiceReady",    { input: Schema.Struct({ invoiceKey: Schema.String }), internal: true })
export const CancelIfUnpaid  = Actor.command("CancelIfUnpaid",  { internal: true })

export const OrderPlaced    = Actor.event("OrderPlaced",    { totalCents: Schema.Int })
export const OrderPaid      = Actor.event("OrderPaid",      { receiptId: Schema.String })
export const OrderCancelled = Actor.event("OrderCancelled", { reason: Schema.String })

export const OrderProtocol = Actor.protocol(
  Get, Items, AddItem, Place, Pay, RecalculateTax, PaymentCaptured, PaymentFailed, InvoiceReady, CancelIfUnpaid,
)
export const OrderEvents = Actor.events(OrderPlaced, OrderPaid, OrderCancelled)
```

```ts
interface Command<Tag extends string, Input, Output, Error> {
  readonly kind: "Command"
  readonly tag: Tag
  readonly input: Schema.Schema<Input>            // default Schema.Void
  readonly output: Schema.Schema<Output>          // default Schema.Void
  readonly error: Schema.Schema<Error>            // default Schema.Never; domain failures, committed as rejected receipts
  readonly internal: boolean                      // default false
  readonly version: number                        // envelope schema version; default 1 (§5.5)
  readonly idempotency: Option<(input: Input) => string>
  make(input: Input): CommandMessage<this>
}
interface Query<Tag, Input, Output> { readonly kind: "Query"; /* same shape; never persisted, never errors with domain errors */ }
interface Event<Tag, Fields> { readonly kind: "Event"; readonly tag: Tag; readonly schema: Schema.Struct<Fields>; readonly version: number; make(fields): EventMessage<this> }

type Protocol = ReadonlyArray<Command | Query>   // tags unique; `Actor.protocol` fails at compile time on duplicates
```

The command/query split is semantic, not syntactic: a command is persisted and serialized; a query is volatile and routed. A command that returns data (`output`) is fine — `request` returns it after commit.

### 3.4 The actor type

```ts
export const Order = Actor.make("Order", {
  protocol: OrderProtocol,
  database: OrderDatabase,
  events: OrderEvents,
  live: Schema.Union([PaymentProblem, ItemsChanged]),      // optional: type of ctx.broadcast / ref.live; default Schema.Unknown
  // defaults shown:
  placement: Placement.project,                            // §3.15
  passivateAfter: "1 minute",                              // idle time before the owner drops the activation
  mailbox: { maxPending: 10_000 },                         // admission (§4.4)
  retention: { events: "forever", receipts: "30 days" },   // per-type override of Runner retention
})
```

```ts
interface ActorType<Name extends string, P extends Protocol, D extends DatabaseDef, E extends Events, L> {
  readonly name: Name
  readonly protocol: P
  readonly database: D
  readonly events: E
  readonly live: Schema.Schema<L>
  readonly placement: Placement
  readonly options: ActorOptions
  toLayer<R>(
    handlers: Handlers<P, E, L, R>,
    options: ToLayerOptions<D, R>,
  ): Layer.Layer<ActorImpl<Name>, never, Exclude<R, TurnServices>>
}
```

### 3.5 Implementing the actor: handlers and contexts

```ts
// orders/Order.live.ts
export const OrderLive = Order.toLayer({
  AddItem: Effect.fn("Order.AddItem")(function* ({ sku, quantity, priceCents }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "draft") return yield* new OrderNotDraft({ orderId: ctx.id, status: order.status })
    yield* db.insert(OrderItems, { itemId: yield* ctx.ids.next, sku, quantity, priceCents })
    yield* db.update(Orders, { totalCents: order.totalCents + quantity * priceCents })
  }),

  Place: Effect.fn("Order.Place")(function* ({ customerId }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "draft") return yield* new OrderNotDraft({ orderId: ctx.id, status: order.status })
    yield* db.update(Orders, { status: "placed", customerId })
    yield* ctx.events.emit(OrderPlaced.make({ totalCents: order.totalCents }))
    yield* ctx.schedule.after("30 minutes", CancelIfUnpaid.make())
    // tell another actor: send only. Same transaction domain → committed with this turn; otherwise → outbox row, same transaction.
    const customer = yield* ctx.actors.get(Customer, customerId)
    yield* customer.send(OrderPlacedForCustomer.make({ orderId: ctx.id, totalCents: order.totalCents }))
  }),

  Pay: Effect.fn("Order.Pay")(function* ({ paymentMethodId }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "placed") return yield* new CannotPay({ orderId: ctx.id, status: order.status })
    const attemptId = yield* ctx.ids.next
    yield* db.update(Orders, { status: "paying" })
    yield* db.insert(PaymentAttempts, { attemptId, paymentMethodId, outcome: "pending", receiptId: null })
    yield* ctx.activities.start(
      CapturePayment,
      { orderId: ctx.id, attemptId, paymentMethodId, amountCents: order.totalCents },
      { onSuccess: PaymentCaptured, onFailure: PaymentFailed },
    )
  }),

  PaymentCaptured: Effect.fn("Order.PaymentCaptured")(function* ({ receiptId }, ctx) {
    const db = yield* Database
    yield* db.update(Orders, { status: "paid" })
    yield* ctx.events.emit(OrderPaid.make({ receiptId }))
    yield* ctx.jobs.enqueue(RenderInvoice, { orderId: ctx.id }, { onComplete: InvoiceReady })
    yield* ctx.schedule.after("30 days", AskForReview.make())
  }),

  PaymentFailed: Effect.fn("Order.PaymentFailed")(function* ({ reason }, ctx) {
    const db = yield* Database
    yield* db.update(Orders, { status: "placed" })
    yield* ctx.broadcast(PaymentProblem.make({ orderId: ctx.id, reason }))   // ephemeral; published after commit
  }),

  InvoiceReady: Effect.fn("Order.InvoiceReady")(function* ({ invoiceKey }) {
    const db = yield* Database
    yield* db.update(Orders, { invoiceKey })
  }),

  RecalculateTax: Effect.fn("Order.RecalculateTax")(function* ({ version }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.taxVersion >= version) return                       // idempotent by state, not by dedupe alone
    const items = yield* db.many(OrderItems)
    yield* db.update(Orders, { totalCents: computeTotal(items, version), taxVersion: version })
  }),

  CancelIfUnpaid: Effect.fn("Order.CancelIfUnpaid")(function* (_, ctx) {   // timers are commands with guards
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "placed") return
    yield* db.update(Orders, { status: "cancelled" })
    yield* ctx.events.emit(OrderCancelled.make({ reason: "unpaid" }))
  }),

  Get: Effect.fn("Order.Get")(function* (_, ctx) {
    const db = yield* Database
    const o = yield* db.one(Orders)
    return { id: ctx.id, status: o.status, totalCents: o.totalCents, version: ctx.turn }
  }),
  Items: Effect.fn("Order.Items")(function* () {
    const db = yield* Database
    return yield* db.many(OrderItems)
  }),
}, {
  // runs once, inside the same transaction as the first command this id ever receives
  init: Effect.fn("Order.init")(function* () {
    const db = yield* Database
    yield* db.insert(Orders, { status: "draft", customerId: null, totalCents: 0, invoiceKey: null, taxVersion: 1 })
  }),
  // optional: warm a derived cache after this runner takes ownership. Read-only; nothing durable may happen here.
  onActivate: Effect.fn("Order.onActivate")(function* (ctx) {
    const db = yield* Database
    yield* ctx.cache.set(ItemCount, (yield* db.many(OrderItems)).length)
  }),
})
```

```ts
type Handlers<P extends Protocol, E extends Events, L, R> =
  & { readonly [C in Extract<P[number], Command> as C["tag"]]:
        (input: Schema.Type<C["input"]>, ctx: TurnContext<P, E, L>) => Effect.Effect<Schema.Type<C["output"]>, Schema.Type<C["error"]>, R> }
  & { readonly [Q in Extract<P[number], Query> as Q["tag"]]:
        (input: Schema.Type<Q["input"]>, ctx: QueryContext) => Effect.Effect<Schema.Type<Q["output"]>, never, R> }
  & NoWaitingServices<R>   // compile error if R includes Actors, BlobStore, Jobs, Workflows (services that only make sense outside a turn)

interface ToLayerOptions<D, R> {
  readonly init: (ctx: InitContext) => Effect.Effect<void, never, Database | R>
  readonly onActivate?: (ctx: ActivationContext) => Effect.Effect<void, never, Database | R>
  readonly onPassivate?: (ctx: ActivationContext) => Effect.Effect<void, never, R>   // best effort; may not run
}
```

```ts
interface TurnContext<P, E, L> {
  readonly id: string
  readonly address: ActorAddress
  readonly incarnation: number
  readonly generation: number             // ownership epoch of this activation
  readonly turn: number                   // this turn's number; after commit it is the actor's version (ETag)
  readonly now: DateTime.Utc              // fixed for the turn; from Clock (TestClock in tests)
  readonly message: {
    readonly id: string                   // message_id; uuid v7 or derived from the idempotency key
    readonly idempotencyKey: Option.Option<string>
    readonly correlationId: string        // root submission; propagates through sends, activities, jobs, workflows
    readonly causationId: Option.Option<string>
    readonly origin: "client" | "actor" | "timer" | "activity" | "job" | "workflow" | "cron" | "operator"
  }
  readonly ids: { readonly next: Effect.Effect<string> }                // uuid v7, unique, roughly time-ordered
  readonly events: { emit(event: EventMessage<E>): Effect.Effect<void> } // durable; appended in this transaction
  broadcast(value: L): Effect.Effect<void>                              // ephemeral; published only if the turn commits
  readonly schedule: {
    after(delay: Duration.Input, command: CommandMessage<P>): Effect.Effect<void>   // durable; in this transaction
    at(time: DateTime.Utc, command: CommandMessage<P>): Effect.Effect<void>
  }
  readonly actors: { get<T extends ActorType>(type: T, id: string): Effect.Effect<SendRef<T>> }   // send-only (§3.7)
  readonly activities: {
    start<A extends ActivityDef>(activity: A, input: Input<A>, routes: { onSuccess: Command; onFailure: Command }): Effect.Effect<void>
  }
  readonly jobs: {
    enqueue<J extends JobDef>(job: J, input: Input<J>, routes?: { onComplete?: Command; onFailure?: Command }): Effect.Effect<void>
  }
  readonly workflows: {
    start<W extends WorkflowDef>(workflow: W, input: Input<W>, routes?: { onComplete?: Command; onFailure?: Command }): Effect.Effect<void>
  }
  readonly cache: TurnCache               // hot, derived, per activation; dropped on passivation; never authoritative
}

interface SendRef<T extends ActorType> {
  readonly address: ActorAddress
  send(command: CommandMessage<T["protocol"]>, options?: { idempotencyKey?: string; deliverAfter?: Duration.Input }): Effect.Effect<void>
}

interface QueryContext {
  readonly id: string
  readonly address: ActorAddress
  readonly incarnation: number
  readonly turn: number                   // last committed turn at query start
  readonly cache: ReadonlyTurnCache
}

interface TurnCache {
  get<A>(key: CacheKey<A>): Effect.Effect<Option.Option<A>>
  set<A>(key: CacheKey<A>, value: A): Effect.Effect<void>
  readonly clear: Effect.Effect<void>
}
```

Everything on `ctx` that produces a durable effect (`events.emit`, `schedule.*`, `actors.get(...).send`, `activities.start`, `jobs.enqueue`, `workflows.start`) writes a row in the turn's transaction. If the handler fails with a domain error, all of those roll back and a rejected receipt commits instead. If the handler dies, everything rolls back and the message is redelivered.

### 3.6 Calling an actor

```ts
import { Actors } from "@durable-actors/core"

const program = Effect.gen(function* () {
  const actors = yield* Actors
  const order = yield* actors.get(Order, "order_123")     // no I/O; the id may never have existed

  yield* order.request(AddItem.make({ sku: "shirt", quantity: 2, priceCents: 2900 }))
  yield* order.request(Place.make({ customerId: "c1" }))

  // request: durable submit + wait for the committed result; domain errors are typed
  const paid = yield* order.request(Pay.make({ paymentMethodId: "pm_1" }), { idempotencyKey: "checkout-7f3a" }).pipe(
    Effect.catchTag("CannotPay", (e) => Effect.succeed(e)),
  )

  // submit: durable acceptance now; result later, from any process
  const submission = yield* order.submit(RecalculateTax.make({ version: 3 }))
  yield* submission.await                                   // or: (yield* actors.submission(submission.messageId)).status

  // send: durable acceptance, no handle
  yield* order.send(RecalculateTax.make({ version: 3 }))

  // query: committed read at the owner; { afterTurn } gives read-your-writes for a version you saw
  const snapshot = yield* order.query(Get.make(), { afterTurn: submission.turn })

  // events: catch-up from a cursor, then live
  yield* order.events({ from: cursor }).pipe(Stream.runForEach(persistCursor))
})
```

```ts
interface Actors {
  get<T extends ActorType>(type: T, id: string): Effect.Effect<ActorRef<T>>
  submission(messageId: string): Effect.Effect<Submission>
}

interface ActorRef<T extends ActorType> {
  readonly address: ActorAddress
  request<C extends Command>(command: CommandMessage<C>, options?: RequestOptions):
    Effect.Effect<Output<C>, Error<C> | Backpressure | IdempotencyConflict | RequestTimeout | DeadlineExceeded>
  submit<C extends Command>(command: CommandMessage<C>, options?: SubmitOptions): Effect.Effect<Submission<C>, Backpressure | IdempotencyConflict>
  send<C extends Command>(command: CommandMessage<C>, options?: SubmitOptions): Effect.Effect<void, Backpressure | IdempotencyConflict>
  query<Q extends Query>(query: QueryMessage<Q>, options?: QueryOptions): Effect.Effect<Output<Q>, ActorNotFound | RequestTimeout>
  events(options?: { from?: EventCursor }): Stream.Stream<Committed<EventOf<T>>, ActorNotFound>
  readonly live: Stream.Stream<LiveOf<T>>
  broadcast(value: LiveOf<T>): Effect.Effect<void>          // ephemeral publish from outside a turn (presence, typing)
  readonly inspect: Effect.Effect<ActorSnapshot>
}

interface RequestOptions extends SubmitOptions { readonly timeout?: Duration.Input /* default 30 s; a timeout is not a failure of the command */ }
interface SubmitOptions {
  readonly idempotencyKey?: string          // message_id = uuid5(storeKey, key); same key + same payload → same receipt
  readonly deadline?: DateTime.Utc          // if the turn has not started by then, commit a rejected receipt (DeadlineExceeded)
  readonly correlationId?: string
}
interface QueryOptions { readonly afterTurn?: number; readonly timeout?: Duration.Input }

interface Submission<C> {
  readonly messageId: string
  readonly address: ActorAddress
  readonly turn: Option.Option<number>      // known after commit
  readonly status: Effect.Effect<SubmissionStatus<C>>
  readonly await: Effect.Effect<Output<C>, Error<C> | RequestTimeout>
}
type SubmissionStatus<C> =
  | { readonly _tag: "Pending"; readonly acceptedAt: DateTime.Utc }
  | { readonly _tag: "Committed"; readonly turn: number; readonly exit: Exit.Exit<Output<C>, Error<C>>; readonly committedAt: DateTime.Utc }
  | { readonly _tag: "Expired" }            // receipt pruned by retention

interface Committed<E> { readonly cursor: EventCursor; readonly turn: number; readonly occurredAt: DateTime.Utc; readonly event: E }
interface EventCursor { readonly incarnation: number; readonly seq: number }
interface ActorSnapshot {
  readonly address: ActorAddress; readonly home: string; readonly incarnation: number; readonly generation: number
  readonly turn: number; readonly pending: number; readonly lastTurnAt: Option.Option<DateTime.Utc>; readonly resident: boolean
}
```

### 3.7 The one hard rule about talking to other actors

Inside a turn you may **send**. You may not **wait**.

```diagram
 where you are            other actors                      why
 ──────────────────────── ───────────────────────────────── ─────────────────────────────────────
 turn handler             ctx.actors.get(T, id) → SendRef   a turn holds a row lock and an open
   (command)              .send only                        transaction; waiting on another actor
                                                            = distributed lock chain, deadlocks,
                                                            long transactions, cross-shard waits
 query handler            nothing                           queries are cheap and local by contract
 init / onActivate        nothing                           same as turn
 workflow · job ·         yield* Actors → full ActorRef     they hold no transaction; a workflow
 activity · cron ·        request · submit · send · query   waiting a week for an actor is the point
 HTTP/RPC handler
```

Enforcement is two-layered. `toLayer` rejects handlers whose requirements include `Actors`, `BlobStore`, `Jobs`, or `Workflows` at the type level (`NoWaitingServices<R>`), and the turn fiber provides `Actors` as an implementation that dies with `NotAllowedInTurn` in case something reaches it through an untyped path. The pattern this pushes you to is the saga: A sends to B; B commits and sends a completion back to A; A's next turn handles it. Failures become explicit state in A instead of exceptions in a nested call.

### 3.8 Two SQL clients with two meanings

```ts
// inside turn / init / onActivate / query handlers — bound to THIS actor and THIS transaction
const db = yield* Database
db.id                                         // "order_123"
yield* db.one(Orders)                         // exactly one row with actorId = db.id, else ActorNotFound
yield* db.maybe(Orders)                       // Option
yield* db.many(OrderItems, { orderBy: "itemId" })
yield* db.insert(OrderItems, row)             // actorId injected
yield* db.update(Orders, patch)               // all rows of this actor in that table (single-row tables)
yield* db.update(OrderItems, patch, { itemId })
yield* db.delete(OrderItems, { itemId })
yield* db.sql`SELECT coalesce(sum(quantity), 0) AS n FROM order_items WHERE actor_id = ${db.id}`   // same transaction

// anywhere — read-only, cell-wide, committed reads, its own connection; never part of any turn transaction
const sql = yield* SqlClient.SqlClient
yield* sql`SELECT c.actor_id FROM customers c JOIN invoices i ON i.customer_id = c.actor_id WHERE i.status = 'overdue'`
```

| | `Database` (`db.*`, `db.sql`) | `SqlClient.SqlClient` |
|---|---|---|
| Scope | one actor's rows | every table in the cell, including runtime tables |
| Transaction | the turn's; writes commit with the turn | none; each statement (or explicit read-only tx) sees committed state |
| Writes | allowed for rows carrying `db.id` | rejected by the database role (`default_transaction_read_only = on`) |
| On Neki | `SET __neki.tx_mode = 'single'` | `tx_mode = 'multi'`, scatter joins allowed |
| Available in | turn, init, onActivate, query | everywhere, including turns (for cross-actor *reads*) |

Reading the world from inside a turn is allowed and useful (a `Pay` handler may check a `fraud_signals` table owned by another actor type). Because that read uses a separate connection, it sees committed state rather than the turn's snapshot; this is identical on pglite, Postgres, and Neki, which is why the design chooses it. G3's "only actors write" is a database fact, not a convention: the world client's role cannot write.

Internally the turn's write-capable client is bound under a distinct tag (`ActorSql`), so `SqlClient.SqlClient` always means the world client and there is no service shadowing.

### 3.9 Time: timers and cron

A timer is a command to self with a delivery time. It is written in the turn's transaction, so "the order was placed and will cancel in 30 minutes unless paid" is one atomic fact.

```ts
yield* ctx.schedule.after("30 minutes", CancelIfUnpaid.make())
yield* ctx.schedule.at(order.dueAt, SendReminder.make({ n: 1 }))
```

V1 has no cancel API: a timer handler guards on state (`if (order.status !== "placed") return`). This is simpler, always correct, and mirrors how the state machine already thinks. V2 adds named timers with replace/cancel semantics (`ctx.schedule.named("reminder").after(...)`, `.cancel()`), implemented as a `timer_name → message_id` row so cancel is a tombstone checked at fire time.

Cron is recurring work that is not owned by any actor instance. It runs on a worker pool with full `Actors` access; the common body is SQL discovery followed by sends.

```ts
export const NightlyReconcile = Actor.cron("NightlyReconcile", {
  schedule: Cron.parse("0 3 * * *", "UTC"),
  pool: "default",
  run: Effect.fn("NightlyReconcile")(function* (fire) {                  // fire: { scheduledAt, executionId }
    const sql = yield* SqlClient.SqlClient
    const actors = yield* Actors
    const stale = yield* sql<{ actor_id: string }>`
      SELECT actor_id FROM subscriptions WHERE status = 'active' AND renews_at < ${fire.scheduledAt}`
    yield* Effect.forEach(stale, ({ actor_id }) =>
      Effect.flatMap(actors.get(Subscription, actor_id), (s) => s.send(Renew.make({ asOf: fire.scheduledAt }))),
      { concurrency: 64 })
  }),
})
```

Underneath: `ctx.schedule` writes a persisted message with `deliver_at`; the store's poller only picks messages whose `deliver_at <= now()`. Cron is Effect `ClusterCron` on the configured shard group; one execution per schedule tick cluster-wide.

### 3.10 Activities: one external side effect whose result an actor needs

```ts
export const CapturePayment = Actor.activity("CapturePayment", {
  input: Schema.Struct({ orderId: Schema.String, attemptId: Schema.String, paymentMethodId: Schema.String, amountCents: Schema.Int }),
  output: Schema.Struct({ receiptId: Schema.String }),
  error: PaymentDeclined,                                        // terminal domain failure → onFailure
  pool: "default",
  retry: Schedule.exponential("1 second").pipe(Schedule.both(Schedule.recurs(8))),   // transient failures only
  timeout: "2 minutes",                                          // per attempt
  run: Effect.fn("CapturePayment")(function* ({ attemptId, paymentMethodId, amountCents }, act) {
    const stripe = yield* Stripe
    // act.executionId is stable across retries and across runner crashes: use it as the provider idempotency key
    const charge = yield* stripe.charge({ amountCents, paymentMethodId, idempotencyKey: act.executionId })
    return { receiptId: charge.id }
  }),
})
```

```ts
interface ActivityDef<Name, Input, Output, Error> {
  readonly name: Name; readonly input: Schema<Input>; readonly output: Schema<Output>; readonly error: Schema<Error>
  readonly pool: string; readonly retry: Schedule; readonly timeout: Duration
  readonly run: (input: Input, ctx: ActivityContext) => Effect<Output, Error, R>
}
interface ActivityContext {
  readonly executionId: string          // stable per ctx.activities.start; the provider idempotency key
  readonly attempt: number
  readonly origin: ActorAddress         // the actor that started it
  readonly correlationId: string
  heartbeat(progress?: unknown): Effect<void>
}
```

Contract: exactly one completion command (`onSuccess` with the output, or `onFailure` with the error) is delivered to the origin actor, at least once, deduplicated by `executionId`. If retries are exhausted or the outcome is unknowable (the process died after the provider call, before the result was journaled), `onFailure` is delivered with `ActivityUnknown` as the reason. Nothing is ever silently dropped; the actor decides what "unknown" means for its domain (§9.5 runbook).

Implementation: Effect `Activity.make` inside one framework-owned generic Workflow (`ActivityBridge`) that journals the result and then sends the completion command. Activities run on worker runners; the actor runner never executes external I/O inside a turn.

### 3.11 Jobs: background work that is not anyone's truth

```ts
export const RenderInvoice = Actor.job("RenderInvoice", {
  input: Schema.Struct({ orderId: Schema.String }),
  output: Schema.Struct({ invoiceKey: Schema.String }),
  pool: "media",
  concurrency: { perRunner: 4 },
  retry: Schedule.spaced("10 seconds").pipe(Schedule.both(Schedule.recurs(5))),
  timeout: "10 minutes",
  execute: Effect.fn("RenderInvoice")(function* ({ orderId }, job) {
    const sql = yield* SqlClient.SqlClient                           // read the world (order + items + customer in one query)
    const blobs = yield* BlobStore
    const [row] = yield* sql`SELECT o.*, c.email FROM orders o JOIN customers c ON c.actor_id = o.customer_id WHERE o.actor_id = ${orderId}`
    const pdf = yield* renderPdf(row)
    const ref = yield* blobs.put(`Order/${orderId}/invoice-${job.executionId}.pdf`, pdf, { contentType: "application/pdf" })
    return { invoiceKey: ref.key }
  }),
})

// outside a turn
const jobs = yield* Jobs
const handle = yield* jobs.enqueue(RenderInvoice, { orderId })      // JobHandle: executionId, status, await
```

```ts
interface Jobs {
  enqueue<J extends JobDef>(job: J, input: Input<J>, options?: { routes?: CompletionRoutes; delay?: Duration.Input }): Effect<JobHandle<J>>
  status(executionId: string): Effect<JobStatus>
  cancel(executionId: string): Effect<void>       // cooperative: interrupts the fiber; a running side effect is not undone
}
```

Job vs activity: an activity is *one* effect whose result the origin actor needs and whose retries should be conservative; a job is throughput work (renders, exports, crawls) that may optionally report completion to an actor. Both run on worker pools; neither may write business tables (the world client is read-only), which is the mechanism that keeps "truth lives in actors" true.

### 3.12 Workflows: multi-step procedures that survive time and failure

```ts
export const RefundWithApproval = Actor.workflow("RefundWithApproval", {
  input: Schema.Struct({ orderId: Schema.String, amountCents: Schema.Int, requestedBy: Schema.String }),
  output: Schema.Struct({ status: Schema.Literals(["refunded", "rejected", "expired"]) }),
  error: RefundExceedsTotal,
  pool: "default",
  run: Effect.fn("RefundWithApproval")(function* ({ orderId, amountCents, requestedBy }, wf) {
    const order = yield* wf.actors.get(Order, orderId)                    // full ActorRef: workflows may wait
    const snapshot = yield* order.query(Get.make())
    if (amountCents > snapshot.totalCents) return yield* new RefundExceedsTotal({ orderId, amountCents })

    const approval = yield* wf.deferred("finance-approval", { success: Schema.Boolean })   // DurableDeferred
    const finance = yield* wf.actors.get(Finance, "team")
    yield* finance.send(ApprovalRequested.make({ token: approval.token, orderId, amountCents, requestedBy }))

    const decision = yield* approval.await.pipe(Effect.timeoutOption("7 days"))           // durable timeout (DurableClock)
    if (Option.isNone(decision)) return { status: "expired" as const }
    if (!decision.value) return { status: "rejected" as const }

    const refund = yield* wf.step(IssueRefund, { orderId, amountCents })                    // an activity as a journaled step
    yield* order.request(RefundRecorded.make({ refundId: refund.id, amountCents }))
    return { status: "refunded" as const }
  }),
})

// start from a turn (completion routed back as a command) or from anywhere (handle)
yield* ctx.workflows.start(RefundWithApproval, input, { onComplete: RefundFinished, onFailure: RefundFailed })
const workflows = yield* Workflows
const run = yield* workflows.start(RefundWithApproval, input)          // WorkflowHandle: executionId, status, await, signal
```

```ts
interface WorkflowContext {
  readonly executionId: string
  readonly actors: Actors                                           // full refs
  step<A extends ActivityDef>(activity: A, input: Input<A>): Effect<Output<A>, Error<A>>      // journaled; replay returns the memoized result
  sleep(duration: Duration.Input): Effect<void>                     // DurableClock
  deferred<S, E>(name: string, schema: { success: Schema<S>; error?: Schema<E> }): Effect<DurableDeferredHandle<S, E>>
  readonly now: Effect<DateTime.Utc>                                // journaled
}
interface DurableDeferredHandle<S, E> { readonly token: string; readonly await: Effect<S, E>; }
// Resolving a deferred from an actor turn is a durable intent like any other:
yield* ctx.workflows.resolve(token, Exit.succeed(true))              // written in the turn's transaction, applied after commit
```

Rules: workflow code between steps must be deterministic (Effect replays the journal); side effects go in steps (activities); workflow state is not business truth — the journal lives in runtime tables, business facts live in actors and are written through commands. Underneath: `Workflow.make`, `Activity.make`, `DurableClock`, `DurableDeferred`, `ClusterWorkflowEngine`; `wf.step` is `Activity.execute` with the framework's activity definition; `wf.deferred` is `DurableDeferred.make/token/await`.

### 3.13 BlobStore: bytes next to truth, references in the truth

```ts
interface BlobStore {
  put(key: string, data: Uint8Array | Stream<Uint8Array>, options?: { contentType?: string; metadata?: Record<string, string> }): Effect<BlobRef>
  get(key: string): Effect<Stream<Uint8Array>, BlobNotFound>
  head(key: string): Effect<BlobInfo, BlobNotFound>
  presign(key: string, options: { method: "GET" | "PUT"; expiresIn: Duration.Input; contentType?: string }): Effect<URL>
  delete(key: string): Effect<void>
  list(prefix: string): Stream<BlobInfo>
}
BlobStore.s3({ bucket, endpoint?, region?, credentials? })   // AWS S3, R2, MinIO, Tigris
BlobStore.fs({ dir })                                         // local dev
BlobStore.memory                                              // tests
```

Rules: blobs are immutable (new content → new key); the key convention is `${type}/${id}/…` so `actors purge Order/o1` can remove them by prefix; bytes are written by jobs, activities, and HTTP handlers (never inside a turn — a turn stores the reference it was handed in a completion command). Uploads from browsers use `presign("PUT")` and then a command that records the key. `BlobStore` is not a `Database` provider and has no transaction; that is why it is excluded from turns at the type level.

### 3.14 Events and realtime

```diagram
 durable                                          ephemeral
 ctx.events.emit(e)     → actor_events row        ctx.broadcast(v)   → owner runner PubSub → subscribers
   in the turn tx         seq per actor             after commit        no history, no retention
 ref.events({ from })   → catch-up rows, then     ref.live           → tail only
                          live tail                ref.broadcast(v)   → from outside a turn (presence, cursors)
```

Subscriptions are routed to the actor's owner runner as a streaming RPC. On ownership change the client transparently reconnects with its last cursor; because the catch-up reads `actor_events`, nothing is lost. Event retention defaults to forever (events are small and are the audit trail); `retention.events` per type can bound it, after which `events({ from })` with a pruned cursor fails with `CursorExpired` so the subscriber resnapshots instead of silently skipping.

The ETag read path (§7.1) uses `turn` as the version: any HTTP query response carries `ETag: "<turn>"`, a CDN revalidates with `If-None-Match`, and the owner answers `304` without running the handler when the turn is unchanged.

### 3.15 Placement

```ts
Placement.project                                         // default: the project's home cell (control-plane row)
Placement.byKey((address) => string)                     // deterministic cell from the id; ids must encode it
Placement.nearestOnCreate                                 // V2: global directory with a consistent create
```

Placement chooses the actor's **home** — the cell whose store holds its rows, mailbox, timers, events, and outbox. Home is fixed at creation in V1. With `Placement.project` every actor of a project is in one store, so cross-actor SQL for that project is one snapshot and data residency is a property of the cell. `Actors.rehome(ref, cell)` (V2) is a workflow: freeze (reject with `Rehoming`), copy rows by actor key, switch the directory, drain the outbox, unfreeze — bounded because the actor key leads every primary key.

### 3.16 Errors

All framework errors are `Schema.TaggedError` and cross transports unchanged.

| Error | Raised by | Meaning | Caller action |
|---|---|---|---|
| `ActorNotFound` | `query`, `events`, `db.one` | the id has never received a command (no rows) | create it with a command, or treat as absent |
| `Backpressure` | `request/submit/send` | `mailbox.maxPending` exceeded for the actor | retry with backoff; shard the hot actor |
| `IdempotencyConflict` | `request/submit/send` | same idempotency key, different payload digest | programming error; do not retry |
| `RequestTimeout` | `request`, `query`, `Submission.await` | caller stopped waiting; **the command may still commit** | poll `Actors.submission(id)`; never resend with a new key |
| `DeadlineExceeded` | `request` | turn had not started by `deadline`; rejected receipt committed | domain decides |
| `ProtocolMismatch` | runtime | stored envelope version undecodable by running code | deploy compatible decoder (§5.5) |
| `CursorExpired` | `events` | cursor older than retention | resnapshot |
| `Rehoming` | any call | actor is moving between cells (V2) | retry after `retryAfter` |
| `NotAllowedInTurn` | runtime defect | `Actors`/`BlobStore`/`Jobs`/`Workflows` reached inside a turn | fix code |
| `ForeignRowWrite` | runtime defect | row-level security rejected a write to a row outside the actor's key (§5.2) | fix code |
| `StaleWriter` | internal only | fence mismatch at commit; never surfaces to callers | none; the message is redelivered to the new owner |
| `ActivityUnknown` | delivered via `onFailure` | outcome unknowable after retries | domain reconciliation |
| `SchemaViolation` | `actors migrate/doctor` | D1–D3 broken in DDL | fix schema |

### 3.17 Running it: the operator-facing surface

```ts
// apps/runner/main.ts — one file; the same file in dev, self-hosted, and Rika Cloud
import { Config, Layer } from "effect"
import { BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { ActorStore, BlobStore, ClusterRuntime, Runner } from "@durable-actors/core"

export const App = Runner.layer({
  cell: Config.String("CELL").pipe(Config.withDefault("local")),
  actors: [OrderLive, CustomerLive, InventoryLive, DocumentLive, AssistantLive],
  activities: [CapturePayment, IssueRefund, CreateDnsRecord, ModelTurn, RunTool],
  jobs: [RenderInvoice, ExportCsv],
  workflows: [RefundWithApproval, ProvisionDomain, AgentRun],
  crons: [NightlyReconcile],
  pools: ["actors", "default", "media"],                 // which pools THIS process serves; omit = all
  retention: { receipts: "30 days", messages: "7 days" },
  admission: { perProject: { commandsPerSecond: 5_000 } },
})

const Production = App.pipe(
  Layer.provide(ShopHttp),                                         // §7
  Layer.provide(ActorStore.postgres()),                            // fence, events, outbox, cluster storage, WithTransaction turns
  Layer.provide(ClusterRuntime.layer),                             // Sharding + SqlMessageStorage + SqlRunnerStorage + ClusterWorkflowEngine
  Layer.provide(BlobStore.s3({ bucket: Config.String("BLOB_BUCKET") })),
  Layer.provide(PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL"), maxConnections: Config.Int("PG_POOL").pipe(Config.withDefault(20)) })),
  Layer.provide(StripeLive),
  Layer.provide(AnthropicLive),
)
BunRuntime.runMain(Layer.launch(Production))
```

```ts
// local dev and CI: same App; pglite in-process; filesystem blobs; one runner serving every pool; real clock
BunRuntime.runMain(Layer.launch(Runner.dev(App, { dataDir: ".data" })))
```

```ts
interface RunnerConfig {
  readonly cell: Config<string>                       // deployment target name; "local" in dev
  readonly actors: ReadonlyArray<Layer<ActorImpl>>
  readonly activities?: ReadonlyArray<ActivityDef>
  readonly jobs?: ReadonlyArray<JobDef>
  readonly workflows?: ReadonlyArray<WorkflowDef>
  readonly crons?: ReadonlyArray<CronDef>
  readonly pools?: ReadonlyArray<string>              // default: every pool referenced above plus "actors"
  readonly retention?: { receipts?: Duration.Input; messages?: Duration.Input; events?: Duration.Input | "forever" }
  readonly admission?: { perProject?: { commandsPerSecond: number }; perActor?: { maxPending: number } }
  readonly passivation?: { maxResident?: number /* default 10_000 */; idle?: Duration.Input /* default 1 minute */ }
  readonly turn?: { retries?: number /* defects before dead-letter; default 3 */; drainTimeout?: Duration.Input /* default 20 s */ }
}
Runner.layer(config): Layer<RunnerReady, never, ActorStore | ClusterRuntime | BlobStore | HandlerRequirements>
Runner.dev(app, { dataDir }): Layer<RunnerReady>    // provides ActorStore.pglite, ClusterRuntime.local, BlobStore.fs

ActorStore.pglite({ dir }?)                           // embedded Postgres (WASM); tests and local dev
ActorStore.postgres(options?)                         // uses the provided PgClient; transaction domain = the database
ActorStore.neki()                                     // V2: single-shard turns, db_shard-aligned cluster storage (K = shardsPerGroup = 300), outbox for cross-shard
ClusterRuntime.layer                                  // Effect Sharding over the store's SqlClient; runner registration; workflow engine
ClusterRuntime.local                                  // single-process, in-memory runner registry (dev/test)
```

Runner roles are the same binary with a different `pools` list: latency-sensitive actor runners (small, many, HTTP in front) and throughput worker runners (large memory, may scale to zero, can crash without touching a turn). `pool` maps onto Effect Cluster shard groups (`ClusterSchema.ShardGroup`; `ClusterCron` takes `shardGroup`). This is also the whole of "hosted functions": a worker is a runner with no actors registered, metered per execution-second.

### 3.18 An agent is an actor plus a workflow

Rika's next product is agents; the framework must express one without new primitives. It does:

```ts
export const Assistant = Actor.make("Assistant", { protocol: AssistantProtocol, database: AssistantDatabase, events: AssistantEvents })
// Assistant owns: conversation rows, tool grants, budget, approval state. Turns are short: record a user message, start AgentRun.

export const AgentRun = Actor.workflow("AgentRun", {
  input: Schema.Struct({ assistantId: Schema.String, runId: Schema.String }),
  run: Effect.fn("AgentRun")(function* ({ assistantId, runId }, wf) {
    const assistant = yield* wf.actors.get(Assistant, assistantId)
    while (true) {
      const plan = yield* wf.step(ModelTurn, { assistantId, runId })                 // LLM call: an activity
      if (plan.kind === "done") return yield* assistant.request(RunFinished.make({ runId, summary: plan.summary }))
      if (plan.kind === "needs-approval") {
        const approval = yield* wf.deferred(`approve-${plan.toolCallId}`, { success: Schema.Boolean })
        yield* assistant.send(ApprovalRequested.make({ runId, toolCallId: plan.toolCallId, token: approval.token }))
        if (!(yield* approval.await)) { yield* assistant.send(ToolRejected.make({ runId, toolCallId: plan.toolCallId })); continue }
      }
      const result = yield* wf.step(RunTool, { assistantId, runId, call: plan.call })   // shell/browser/API: an activity on pool "sandbox"
      yield* assistant.request(ToolResult.make({ runId, toolCallId: plan.call.id, result }))
    }
  }),
})
```

The agent stops for a week waiting on a human and resumes as the same agent because the workflow journal and the actor rows are both durable; support can `SELECT` every run awaiting approval across all assistants because those are rows.

---

## 4. Runtime model: what the guarantees are made of

### 4.1 The turn

```diagram
 client                         store (Postgres / pglite / one Neki shard)                owner runner
 ──────                         ──────────────────────────────────────────                ────────────
 request(Pay, {idempotencyKey})
   │ message_id = uuid5(storeKey, key) or uuid v7
   ├─ INSERT messages (persisted) ─────────────────▶ ON CONFLICT (message_id) DO NOTHING
   │                                                 duplicate? → return stored receipt if committed
   │                                                              → attach to pending reply otherwise
   │                                                                          ◀── poll (≤10 s) or NOTIFY ──┤
   │                                                                                                       │
   │                                                 BEGIN                                                 │
   │                                                 SELECT * FROM actors WHERE actor_key = $1 FOR UPDATE  │  ① fence
   │                                                   none → INSERT actors(…, generation = mine, turn = 0)│     first turn
   │                                                          + run init()                                 │
   │                                                   generation ≠ mine → ROLLBACK, StaleWriter           │
   │                                                 SAVEPOINT body                                        │
   │                                                   handler: UPDATE orders … WHERE actor_id = $1        │  ② state
   │                                                            INSERT actor_events (seq = next)           │  ③ events
   │                                                            INSERT messages   (sends, timers,          │  ④ intents
   │                                                                               activity/job/workflow)  │
   │                                                            INSERT actor_outbox (targets outside domain)│
   │                                                   domain error → ROLLBACK TO body                     │
   │                                                 INSERT replies (message_id, exit)                     │  ⑤ receipt
   │                                                 UPDATE actors SET turn = turn + 1 (success only),      │  ⑥ version
   │                                                                   last_turn_at = now()                 │
   │                                                 UPDATE messages SET processed = true                   │
   │                                                 COMMIT                                                 │  ← the only durable moment
   │◀──────────────────────────── reply (exit) ─────────────────────────────────────────────────────────────┤
   │                                                 after commit: publish broadcasts · apply cache writes   │
   │                                                               · NOTIFY target runners · relay outbox    │
```

Invariants:

- **Before COMMIT, nothing happened.** A crash anywhere above the commit line leaves the message unprocessed; it is redelivered.
- **After COMMIT, everything happened.** A crash after the commit line loses only the in-memory reply; redelivery finds the receipt and replies from it. No handler runs twice for one `message_id`.
- **Domain errors are outcomes, not failures.** A typed error rolls back the handler's writes (`ROLLBACK TO body`) and commits a rejected receipt. `turn` does not advance because state did not change; the ETag stays valid.
- **Defects are retried, then quarantined.** An unexpected exception rolls back the whole transaction; the runtime retries with backoff (`turn.retries`, default 3). After that it commits a `Defect` receipt (dead letter) so a poison message cannot block the actor forever; `actors replay <message_id>` reruns it after a fix.
- **Effects run only after commit.** Broadcasts, cache writes, notifications, and the outbox relay happen post-commit; if the process dies in between, the durable rows drive recovery (the relay picks up the outbox; the poller picks up the messages).

Implementation: Effect Cluster's `Entity` handler for the actor type, with persisted commands (`ClusterSchema.Persisted`), the `WithTransaction` hook so the reply is stored in the same transaction as the handler, and the `Database` service bound to that transaction's connection. `SqlMessageStorage.saveRequest` already returns `Duplicate` for a repeated `message_id`; the receipt lookup is its `repliesFor`. The fence row and `actor_events`/`actor_outbox` are ours.

### 4.2 The fence: ownership is a database fact

Effect Sharding assigns each actor's shard to one runner using leases (advisory locks or `cluster_locks`). A lease is a *hint*; a paused process can wake believing it still holds one. The fence makes the database the arbiter.

```diagram
 runner A (owner)                        actors row                      runner B (new owner after rebalance)
 ──────────────                          ──────────                      ──────────────────────────────────
 activation: UPDATE actors SET generation = generation + 1 WHERE actor_key = k RETURNING generation → 7
 turn: SELECT … FOR UPDATE; generation 7 = 7 ✓ … COMMIT
                                                                          activation: UPDATE … RETURNING 8
 (A paused mid-turn, holding FOR UPDATE)  ─ B's UPDATE waits on the row lock ─
 A COMMIT (allowed: A's turn began under 7, and the check passed inside the lock)
                                                                          B's UPDATE commits → 8
 A next turn: SELECT … FOR UPDATE; 7 ≠ 8 ✗ → ROLLBACK, StaleWriter → A drops the activation
                                                                          B: turn under 8 ✓
```

Properties: linearization happens at the row lock, not at the lease timestamp; one extra `UPDATE` per activation, none per turn beyond the `SELECT … FOR UPDATE` the turn needs anyway; a query activation installs no fence (reads need none). Generations are minted only by the store; a stale runner cannot fabricate a newer one. A restored/cloned database gets a new `incarnation`, and messages carrying an older incarnation are dead-lettered rather than applied.

### 4.3 Delivery: four states, one identifier

```text
accepted    the message row exists                        → request/submit/send return
committed   its receipt exists (turn committed)            → request returns; Submission.status = Committed
delivered   an outgoing intent reached its destination store (same domain: at commit; outbox: at relay ack)
observed    a client consumed the event/result
```

The model is at-least-once transport with deduplicated transitions, not exactly-once execution of arbitrary code:

- `message_id` is the dedupe key everywhere: client submissions, sends between actors, timers, activity/job/workflow completions, outbox relay.
- `idempotencyKey` maps deterministically to `message_id = uuid5(storeKey, key)`; the payload digest is stored so a reused key with a different payload is `IdempotencyConflict`, not a silent no-op.
- A `RequestTimeout` means the caller stopped waiting. The command is still accepted and will commit. The correct retry is the same key (returns the receipt), never a new one.
- Retention bounds dedupe: after `retention.receipts` (30 days default) a reused key executes again. Keys therefore encode the business operation (`checkout-<cartId>`), and the window is documented per deployment.

### 4.4 Ordering and admission

Ordering guarantees, exactly:

- Per actor, messages are processed one at a time in store order (`deliver_at`, insertion order). Two commands committed by the same source turn to the same target arrive in that order.
- Two clients sending concurrently have no order between them. Wall-clock timestamps do not order anything.
- Across cells or shards, the relay preserves per-source-actor order within each batch and is at-least-once; the target dedupes. There is no global order.

Admission:

- `mailbox.maxPending` (default 10,000) per actor: the store counts unprocessed messages for the actor on insert (indexed on `(entity_type, entity_id, processed)`) and rejects with `Backpressure`. The count is approximate under concurrency; it is a safety valve, not a fairness mechanism.
- `admission.perProject.commandsPerSecond` at the ingress and the runner's HTTP layer: a token bucket per project; excess is `429`/`Backpressure` before any row is written.
- In-memory: Effect's per-entity mailbox (`mailboxCapacity` 4,096) and `maxResidentEntities` (10,000) bound one runner's memory; persisted messages wait in the table, not in RAM.
- Hot actors are a design smell the framework names: fan-in goes to sharded stats actors (`${campaignId}/${hash % 256}`) and is summed with SQL.

### 4.5 Transaction domain and the outbox

A **transaction domain** is the set of rows one transaction can write atomically:

| Store | Domain | Same-domain send | Cross-domain send |
|---|---|---|---|
| `pglite`, `postgres` | the whole database | `INSERT messages` in the turn | to another cell: `INSERT actor_outbox` in the turn |
| `neki` (V2) | one shard | `INSERT messages` in the turn when `db_shard` matches | to another shard or cell: `INSERT actor_outbox` in the turn |

The application code is identical; `ctx.actors.get(T, id).send(...)` asks the store `inDomain(targetKey)` and picks the row. The relay is one loop per source domain:

```text
loop (per source domain, one leader elected via cluster singleton, others idle):
  BEGIN (source)
  rows = SELECT * FROM actor_outbox WHERE relayed_at IS NULL ORDER BY created_at, seq LIMIT 500 FOR UPDATE SKIP LOCKED
  for each target domain in rows:
    acked = transport.deliver(target, batch)            # same DB, other shard: INSERT … ON CONFLICT (message_id) DO NOTHING
                                                         # other cell: HTTPS POST /_relay to the target cell's ingress (mTLS/cell token); target inserts, returns acked ids
  UPDATE actor_outbox SET relayed_at = now() WHERE id IN (acked)
  COMMIT
wake: LISTEN outbox_<domain> (NOTIFY sent post-commit by the turn) ; fallback poll every 1 s
prune: DELETE FROM actor_outbox WHERE relayed_at < now() - retention.messages
```

Discovery is built in: an outbox row is durable progress only if something is guaranteed to poll it, and the relay leader polls every domain the cell knows about (a control-plane list, not a scan of the fleet). If the relay dies between the target's insert and the source's `relayed_at`, the next pass resends and the target's `ON CONFLICT` absorbs it.

### 4.6 Timers

`ctx.schedule.after/at` writes a persisted message with `deliver_at` (Effect's `DeliverAt` trait; `SqlMessageStorage` filters `deliver_at <= now()` when polling). The message is otherwise ordinary: same dedupe, same fence, same receipt. Lateness (fire time minus `deliver_at`) is a first-class metric because it is the honest measure of "durable future work". A restarted cell fires every due timer on its first poll; nothing is lost, only late.

### 4.7 Events, broadcasts, subscriptions

```diagram
 subscriber ── events({from: c}) ──▶ Sharding route ──▶ owner runner
                                                          ├─ SELECT actor_events WHERE actor_key = k AND (incarnation, seq) > c ORDER BY seq   (catch-up)
                                                          └─ then tail the in-process PubSub fed post-commit                                     (live)
 owner changes → stream fails with OwnerMoved → client reconnects with last cursor → catch-up covers the gap
```

- `seq` is per actor, assigned inside the turn from the `actors` row (no sequence object), so events of one actor are gap-free and totally ordered; events of different actors are not ordered relative to each other.
- Broadcast is a message on the same PubSub with no row; if no owner is resident, `ref.broadcast` from outside a turn activates one (cheap; no fence).
- Cross-actor "event subscriptions" (Customer wants Order events) are not a feature: Order sends Customer a command. Subscriptions are for clients and integrations.

### 4.8 The bridges: how activities, jobs, and workflows return to actors

All three end the same way: **a completion command inserted as a persisted message to the origin actor**, deduplicated by `executionId`, carrying the original `correlationId`.

| Primitive | Runtime mechanism | Where it runs | Completion |
|---|---|---|---|
| activity | one generic Effect Workflow (`ActivityBridge`) whose single `Activity.execute` runs the user `run`; journal stores the result | worker runner in the activity's pool | `onSuccess`/`onFailure` command; `ActivityUnknown` if unknowable |
| job | persisted message to the framework `JobWorker` entity keyed by `executionId`, in the job's pool shard group; retries via the job's `Schedule` | worker runner | optional `onComplete`/`onFailure` |
| workflow | Effect `Workflow` via `ClusterWorkflowEngine`; `wf.step` = `Activity.execute`; `wf.sleep` = `DurableClock`; `wf.deferred` = `DurableDeferred` | worker runner | optional `onComplete`/`onFailure` |

The intent to start any of them is a row written in the turn (④ in §4.1). The actual start is the worker picking that row up. If the worker cluster is down, intents queue; if the actor runner dies after commit, the intent is already durable. The actor never waits on the worker; it will get a command later.

### 4.9 Activation, passivation, hot state

```text
first message for k arrives at the assigned runner
  → activation: install fence (mutations) · run onActivate (may warm ctx.cache) · resident
  → turns …
  → idle > passivateAfter (default 1 min; Effect maxIdleTime / EntityReaper) or LRU (maxResident 10k)
  → onPassivate (best effort) · drop cache · not resident
next message → activation again (fence bumps generation)
```

The cache is coherent by construction: only the owner writes, the owner sees every commit, and cache writes performed in a turn are applied only after that turn commits. A new owner starts cold. Nothing in the cache is ever read by another runner or by SQL. If you need it queryable, it is a table.

### 4.10 Queries

A query is a volatile message routed to the owner (activating a cold actor read-only if needed). It runs in a short read-only transaction on the store, so it sees a consistent snapshot of the actor's rows as of its start; it does not take the fence lock and does not serialize with turns. `{ afterTurn: n }` makes the owner wait (bounded by `timeout`) until `actors.turn >= n`, which gives read-your-writes to a client that saw a receipt with turn `n`. Query handlers may also read the world through `SqlClient.SqlClient` (committed, separate connection). `consistency: "eventual"` served from a replica is V2.

### 4.11 Failure matrix

| Failure point | Recovery | Forbidden behavior |
|---|---|---|
| before the message row exists | caller retries with the same idempotency key | claiming accepted work exists |
| accepted, before the turn starts | poller redelivers | losing an acknowledged command |
| mid-turn (before COMMIT) | rollback; redeliver; retry budget; then dead-letter receipt | persisting partial state |
| after COMMIT, before the reply reaches the caller | redelivery finds the receipt; reply from it | running the handler twice |
| after COMMIT, before post-commit effects | relay/poller/notify recover from rows; broadcasts are lost (ephemeral by contract) | treating a broadcast as delivered |
| old owner resumes | fence check fails; message goes to the new owner | writing from a stale activation |
| relay: target inserted, source not marked | resend; target `ON CONFLICT` dedupes | minting a new `message_id` on retry |
| activity: provider succeeded, result not journaled | `ActivityUnknown` to the actor; reconcile with the provider idempotency key | blind retry of an unsafe effect |
| timer due while cell down | fires late on first poll | dropping the timer |
| subscriber's owner moved | stream ends with `OwnerMoved`; client reconnects with cursor | treating PubSub as history |
| database restored from backup | new incarnation; older-incarnation messages dead-lettered; cursors invalidated | replaying receipts of another incarnation |

### 4.12 Retention and incarnation

| Data | Default retention | Note |
|---|---|---|
| processed messages | 7 days | after that, inspection loses the mailbox history |
| receipts (replies) | 30 days | bounds idempotency dedupe |
| events | forever | per-type override; `CursorExpired` protects subscribers |
| outbox relayed rows | 7 days | |
| workflow journals | Effect engine policy; completed runs pruned with receipts | |
| dead letters | until operator resolves | metric + console view |

Incarnation increments when an actor's rows are purged and recreated or the store is restored to a point in time. Every internal message and cursor carries `incarnation`; a mismatch is dead-lettered with a reason instead of applied to the wrong lineage.

---

## 5. Storage model: the tables that are the system

Everything the runtime knows is a row in the same database as the business tables. That is the whole reason inspection, backfills, and admin queries need no second system.

### 5.1 Runtime tables

```sql
-- One row per actor that has ever taken a turn. The fence, the version, the event counter.
CREATE TABLE actors (
  actor_key      TEXT        NOT NULL,                 -- "Order/order_123" (store key)
  db_shard       INT         NOT NULL,                 -- bucket 0..K-1, see §5.4; the Neki shard key
  actor_type     TEXT        NOT NULL,                 -- "Order" (denormalized for operator queries)
  incarnation    INT         NOT NULL DEFAULT 1,       -- lineage; bumps on purge/restore
  generation     BIGINT      NOT NULL DEFAULT 0,       -- ownership fence (§4.2)
  turn           BIGINT      NOT NULL DEFAULT 0,       -- committed successful turns; the ETag
  last_event_seq BIGINT      NOT NULL DEFAULT 0,       -- next event seq = last_event_seq + 1
  home           TEXT        NULL,                     -- cell name; NULL = project default (§3.15)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_turn_at   TIMESTAMPTZ NULL,
  PRIMARY KEY (actor_key)
);
CREATE INDEX actors_type_last_turn_idx ON actors (actor_type, last_turn_at);   -- "idle Orders", "active last hour"

-- Durable history. Gap-free per actor. Never updated.
CREATE TABLE actor_events (
  actor_key      TEXT        NOT NULL,
  db_shard       INT         NOT NULL,
  incarnation    INT         NOT NULL,
  seq            BIGINT      NOT NULL,
  turn           BIGINT      NOT NULL,                 -- the turn that emitted it (several events may share one turn)
  event_type     TEXT        NOT NULL,                 -- "OrderPaid"
  event_version  INT         NOT NULL DEFAULT 1,
  payload        JSONB       NOT NULL,
  message_id     UUID        NOT NULL,                 -- causation: the command whose turn emitted it
  correlation_id TEXT        NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_key, incarnation, seq, created_at)  -- Postgres requires the partition key in the PK; (actor_key, incarnation, seq) is still the logical key
) PARTITION BY RANGE (created_at);                      -- monthly partitions; retention = DROP PARTITION
CREATE INDEX actor_events_type_created_idx ON actor_events (event_type, created_at);  -- integrations: "all OrderPaid since T"

-- Cross-domain intents written by a turn, delivered by the relay (§4.5).
CREATE TABLE actor_outbox (
  actor_key        TEXT        NOT NULL,               -- source
  db_shard         INT         NOT NULL,               -- source bucket (so the row commits with the turn)
  seq              BIGINT      NOT NULL,               -- per source turn ordering
  message_id       UUID        NOT NULL,               -- dedupe key at the target
  target_domain    TEXT        NOT NULL,               -- "cell:eu" | "shard:17"
  target_actor_key TEXT        NOT NULL,
  envelope         JSONB       NOT NULL,               -- encoded persisted message (same shape as messages.payload)
  deliver_at       TIMESTAMPTZ NULL,                   -- timers may cross domains too
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  relayed_at       TIMESTAMPTZ NULL,
  PRIMARY KEY (actor_key, message_id)
);
CREATE INDEX actor_outbox_pending_idx ON actor_outbox (db_shard, created_at) WHERE relayed_at IS NULL;

-- Quarantined messages (defect after retries, incarnation mismatch, undecodable envelope).
CREATE TABLE actor_dead_letters (
  message_id     UUID        NOT NULL,
  actor_key      TEXT        NOT NULL,
  db_shard       INT         NOT NULL,
  reason         TEXT        NOT NULL,                 -- "defect" | "incarnation" | "decode" | "protocol"
  cause          JSONB       NOT NULL,                 -- encoded Cause
  envelope       JSONB       NOT NULL,
  attempts       INT         NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMPTZ NULL,                     -- set by `actors replay` / `actors discard`
  PRIMARY KEY (message_id)
);
```

Plus Effect Cluster's stock tables, created by `SqlMessageStorage` / `SqlRunnerStorage` (names as of rc.116): `cluster_messages` (persisted requests, `message_id` unique, `processed`, `deliver_at`, `shard_id`), `cluster_replies` (receipts: encoded `Exit` per `message_id`), `cluster_runners`, `cluster_locks`. Effect's workflow engine persists its journal through the same message storage. In V1 these are used unmodified (§5.4 explains when they are replaced).

Business tables are the user's (§3.2), with one framework-managed column: `Database.ddl` appends `db_shard INT NOT NULL` to every actor-owned table, hidden from `Row`/`Insert`/`Patch`, filled by `Database.insert`. One `INT` per row buys the V2 Neki move as a topology change instead of a 100-million-row backfill.

### 5.2 Enforcing "only actors write" in the database, not in a linter

D4 (a turn writes only its own rows) is enforced with Postgres row-level security, which pglite and Postgres share and which needs no SQL parser:

```sql
-- rendered by Database.ddl for every actor-owned table
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY own_rows ON orders
  FOR ALL TO durable_actors_turn
  USING      (actor_id = current_setting('durable_actors.actor_id', true))
  WITH CHECK (actor_id = current_setting('durable_actors.actor_id', true));
```

```text
turn transaction (role durable_actors_turn):   BEGIN; SET LOCAL durable_actors.actor_id = 'order_123'; ...   → sees and writes only its rows, raw SQL included
query transaction (same role, READ ONLY):      same setting                                                   → reads only its rows
world client (role durable_actors_world):      BYPASSRLS, default_transaction_read_only = on                  → reads everything, writes nothing
migrations / CLI (role durable_actors_admin):  owner                                                          → schema and repair only
```

Consequences: a handler that forgets `WHERE actor_id = …` on an `UPDATE` updates nothing instead of everything; a handler that tries to write another actor's row gets a policy violation, which the runtime surfaces as the defect `ForeignRowWrite` with the table name; `db.sql` stays available for real SQL without giving up G2. Cost: one indexed predicate per row touched, which the PK-led queries already pay. Roles are created by `actors migrate`; `Runner.dev` creates them in pglite. Neki's RLS behavior is verified in M6 before `ActorStore.neki` ships; if unsupported there, the fallback is the parser-based dev/test guard and `doctor` checks, and the document says so at that time.

### 5.3 The `ActorStore` interface

`ActorStore` is the one adapter between the runtime and a database. Everything above it (turns, bridges, relay, inspection) is written once.

```ts
export interface ActorStore {
  readonly kind: "pglite" | "postgres" | "neki"
  readonly buckets: number                                        // K; fixed for the life of the store

  // topology
  readonly bucketOf: (storeKey: string) => number                 // db_shard
  readonly domainOf: (storeKey: string) => TransactionDomain      // "db" | `shard:${n}` — where a turn for this key commits
  readonly inDomain: (source: string, target: string) => boolean  // may a send be a plain message row?

  // the turn: runs body inside one transaction on the key's domain with fence + RLS setting applied
  readonly turn: <A, E>(
    key: StoreKey,
    owner: Generation,
    body: (tx: TurnTx) => Effect<A, E, Database>,
  ) => Effect<TurnOutcome<A, E>, StaleWriter | StoreUnavailable>

  readonly readOnly: <A, E, R>(key: StoreKey, body: Effect<A, E, R>) => Effect<A, E, R>   // query snapshot, RLS scoped

  // ownership
  readonly installFence: (key: StoreKey) => Effect<Generation>    // UPDATE … generation + 1 RETURNING; creates the row if absent

  // history and intents (used by TurnTx; exposed for inspection/CLI)
  readonly events: (key: StoreKey, from: EventCursor, limit: number) => Stream<StoredEvent>
  readonly outbox: OutboxStore                                    // claim(domain, limit) · markRelayed(ids) · prune(before)
  readonly deadLetters: DeadLetterStore                           // list · replay(messageId) · discard(messageId)

  // Effect Cluster storage on the same database and domain rules
  readonly messageStorage: Layer<MessageStorage.MessageStorage>
  readonly runnerStorage: Layer<RunnerStorage.RunnerStorage>

  // lifecycle
  readonly migrate: Effect<void, MigrationFailed>                 // runtime tables + roles + policies; idempotent
  readonly doctor: Effect<ReadonlyArray<Finding>>                 // §7.3
}

interface TurnTx {
  readonly sql: SqlClient.SqlClient                               // the turn connection, RLS-scoped (tagged ActorSql in R)
  readonly actor: ActorRow                                        // as read under FOR UPDATE
  readonly nextEventSeq: Effect<bigint>
  readonly stageMessage: (m: EncodedMessage) => Effect<void>      // same-domain intent → cluster_messages
  readonly stageOutbox: (m: EncodedMessage, target: TransactionDomain) => Effect<void>
  readonly stageReply: (messageId: MessageId, exit: EncodedExit) => Effect<void>
  readonly afterCommit: (fx: Effect<void>) => Effect<void>        // broadcasts, cache writes, NOTIFY
}

type TurnOutcome<A, E> =
  | { _tag: "Committed"; value: A; turn: bigint }
  | { _tag: "Rejected";  error: E; turn: bigint }                 // domain error; receipt committed; turn unchanged
```

`ActorStore.pglite` and `ActorStore.postgres` share one implementation (`domainOf` always returns `"db"`); `ActorStore.neki` differs in `domainOf`, in the bucket→shard map it reads from `__neki` metadata, in `SET __neki.tx_mode = 'single'` on every turn connection, and in the message-storage driver (§5.4). A conformance suite (`@durable-actors/testing/store-conformance`) runs the same scenarios against all three (§8.6).

### 5.4 Cluster storage alignment: one hash, three uses

Effect Sharding places an actor on cluster shard `|hashString(entityId)| % shardsPerGroup + 1` (300 per group by default). The store needs its own bucket for Neki routing. Defining the two with the same function removes a whole class of scatter queries:

```text
shardsPerGroup = K = 300 (store setting, fixed)
cluster shard   s(id)      = |hashString(id)| % K + 1        (Effect)
db_shard        b(id)      = s(id) - 1                       (ours; same function, pinned copy verified against Effect at startup)
Neki shard map  bucket → physical shard                      (Neki `modulo` shard index on db_shard; K buckets over N shards)
```

```diagram
                     entity id "order_123"
                              │ hashString
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
      cluster shard 42   db_shard 41    Neki: bucket 41 → shard 3
      (which runner)     (which rows)   (which Postgres)
```

Why it matters: a runner assigned cluster shards {41…60} polls `cluster_messages WHERE shard_id IN (…)`. With alignment the driver rewrites that to `db_shard IN (40…59)`, so Neki routes the poll to the few shards holding those buckets instead of fanning out to all of them; the message for an actor always lives on the actor's own shard; receipts, outbox, events, and business rows of one turn share one bucket.

Stock vs custom driver:

| | V1 (`postgres`, `pglite`) | V2 (`neki`) |
|---|---|---|
| tables | stock `cluster_*` | same schema plus `db_shard`; PK `(db_shard, id)`; unique `(db_shard, message_id)` |
| `rowid BIGSERIAL` ordering | stock | replaced by `(created_at, uuid v7 id)`; sequences are single-shard on Neki |
| locks / leases | stock advisory locks (`SqlRunnerStorage`) | `cluster_locks` rows only (advisory locks are per shard; leases must be global) |
| polling | stock (`shard_id IN …`) | `db_shard IN …` rewrite |
| transactions | stock `WithTransaction` on the pool | `WithTransaction` pinned to the key's domain, `__neki.tx_mode = 'single'` |

The V2 driver implements Effect's `MessageStorage.Encoded` and `RunnerStorage` interfaces; it is not a fork of Effect. If Effect adds a shard-key column option before M6, the custom driver shrinks to configuration.

### 5.5 Migrations and the seven things that version

| Dimension | Mechanism | Rule |
|---|---|---|
| package | semver of `@durable-actors/*` | runtime tables have their own migration chain (`actors migrate` runs framework migrations before app migrations) |
| protocol (commands/queries/events on the wire) | `Actor.command(name, { version })`; additive optional fields free | breaking change = new name (`PayV2`) or new version with both handlers registered during rollout; unknown version → `ProtocolMismatch` receipt, never a decode crash |
| code (handlers) | rolling deploy; two runner versions coexist for minutes | every message in the store must be decodable by both; `actors doctor --against <bundle>` diffs protocols |
| schema (business tables) | Effect `Migrator`, SQL you write | expand → deploy → backfill via a job → contract; every step online; Neki DDL is per-shard, so `actors migrate` waits for all shards (`__neki` status) |
| incarnation | `actors purge` / restore | new lineage; cursors and internal messages invalidated (§4.12) |
| workflow | Effect Workflow journals replay code | change a running workflow only by appending steps or by a new workflow name; instances finish on the code that started them; `RefundWithApprovalV2` is the honest name |
| event | `event_version` + upcasters registered in `Actor.events` | consumers read `payload` through the upcaster chain; storage is never rewritten |

Compatibility windows are explicit: messages live 7 days, so a protocol removal is safe only after that window or after `actors inspect --pending-of Pay` reports zero.

```diagram
 schema change, online:
  ┌────────┐   ┌──────────────┐   ┌────────────────────────┐   ┌──────────┐
  │ expand │──▶│ deploy code  │──▶│ backfill (Actor.job,    │──▶│ contract │
  │ ADD COL│   │ writes both  │   │ 1000 keys / batch, SQL  │   │ DROP COL │
  └────────┘   └──────────────┘   │ discovery → commands)   │   └──────────┘
                                  └────────────────────────┘
  each step is a normal turn per actor; the fence and receipts make a crashed backfill resumable
```

### 5.6 Backup, restore, and the meaning of incarnation

A project's truth is one database (or one Neki database). Backup is the database's backup; PITR is the database's PITR. Restoring is not free of semantics, though: the restored store may contain receipts for commands whose effects already reached other systems, and may lack messages that were accepted after the restore point. Therefore `actors restore` (a) bumps `incarnation` for every actor in the project, (b) dead-letters queued messages carrying the old incarnation, (c) invalidates event cursors, and (d) prints the set of `ActivityUnknown`-class effects (activities started after the restore point) for reconciliation. Restoring is a runbook (§9.5), never an automatic recovery path.

### 5.7 Hot-path indexes and growth

| Access | Index | Growth control |
|---|---|---|
| poll pending for my shards | `cluster_messages (shard_id, processed, deliver_at)` partial `WHERE processed = false` | processed rows pruned after `retention.messages` |
| dedupe on insert | `cluster_messages (message_id)` unique | same |
| receipt lookup | `cluster_replies (message_id)` | pruned after `retention.receipts` |
| fence / turn | `actors (actor_key)` PK | one row per actor, forever (a few hundred bytes) |
| event catch-up | `actor_events (actor_key, incarnation, seq)` PK | monthly partitions; `retention.events` = drop partition |
| relay claim | `actor_outbox` partial pending index | relayed rows pruned |
| operator "who is active" | `actors (actor_type, last_turn_at)` | — |

Rough sizes (estimates, not measurements): an actor row ≈ 200 B; an event ≈ 300 B + payload; a message ≈ 400 B + payload. 100 M actors ≈ 20 GB of `actors` rows; 10^9 events at 500 B ≈ 500 GB, which is the argument for partitions and for `retention.events` being a per-type decision rather than "forever" by reflex.

---

## 6. Topology: runners, cells, ingress, control plane

### 6.1 A runner is one process, and every runner is the same binary

```diagram
 ┌─ runner (Bun or Node; your app image) ──────────────────────────────────────────────────┐
 │ HTTP/RPC server (ActorHttp / ActorRpc, health, /_relay)                                  │
 │ ──────────────────────────────────────────────────────────────────────────────────────── │
 │ Effect Sharding ── entities: Order, Customer, … (pool "actors")                           │
 │                 ── JobWorker, ActivityBridge, workflows (pools "default", "media", …)     │
 │                 ── singletons: outbox relay leader, retention pruner, cron scheduler       │
 │ ClusterWorkflowEngine · DurableClock · DurableDeferred                                    │
 │ ──────────────────────────────────────────────────────────────────────────────────────── │
 │ ActorStore (pglite | postgres | neki) · MessageStorage · RunnerStorage · BlobStore        │
 │ OTLP exporter · metrics · structured logs                                                 │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

Roles are a config difference (`pools`), not a build difference:

| Role | `pools` | Sizing (estimates) | Scaling signal |
|---|---|---|---|
| actor runner | `["actors"]` | 1 vCPU / 1 GB serves ~1–3k turns/s if the store keeps up; keep many small for placement granularity | p95 turn latency, resident entity count, pending messages per shard |
| worker runner | `["default", "media", …]` | large memory, few instances, may scale to zero | pending job/activity intents, workflow step latency |
| all-in-one | omit | dev, CI, small self-hosted | — |

Lifecycle: on start, register in `cluster_runners`, take shard leases, begin polling; on `SIGTERM`, stop accepting new work, finish in-flight turns (bounded by `drainTimeout`, default 20 s), release leases, exit. A turn interrupted by a hard kill rolls back at the database; nothing else is needed.

### 6.2 A cell is one complete, independent system

A cell = runners + one store + one blob bucket + one Effect cluster. Two cells share nothing but the control plane and the relay protocol.

Why cells are never stretched across regions:

- Effect Sharding's leases and 10 s polls assume a low-latency store; stretching puts a WAN round trip inside every lease renewal and every message poll.
- A turn is a database transaction; a stretched cluster means turns from far runners hold row locks for a WAN round trip.
- A cell is the failure domain and the data-residency boundary; stretching blurs both.

Sizing (estimates): one Postgres primary cell handles on the order of 10^4 commands/s and low millions of actor rows per GB; when a cell outgrows one primary the store becomes Neki (same cell, more shards) rather than a second cell. Multiple cells exist for geography, residency, and blast radius, not for capacity.

### 6.3 Control plane: a few rows, read everywhere, written rarely

```sql
CREATE TABLE cells    (name TEXT PRIMARY KEY, region TEXT, ingress_url TEXT, relay_url TEXT, store_kind TEXT, status TEXT);
CREATE TABLE projects (project TEXT PRIMARY KEY, home_cell TEXT REFERENCES cells, status TEXT, created_at TIMESTAMPTZ);
CREATE TABLE grants   (grant_id TEXT PRIMARY KEY, project TEXT, subject TEXT, scopes JSONB, expires_at TIMESTAMPTZ);
```

| Deployment | Where the rows live | How ingress reads them |
|---|---|---|
| local | `Runner.dev` in-memory: one cell `local`, one project | — |
| self-hosted | a schema in your Postgres, or a YAML file mounted into ingress | cached, refreshed every 30 s |
| Rika Cloud | a small replicated Postgres, per-region read replicas | ingress cache with 30 s TTL; misses go to the nearest replica |

`Placement.project` reads `projects.home_cell`. `Placement.byKey` needs no row. Nothing on the hot path writes the control plane; creating a project or a cell is an operator action.

### 6.4 Ingress: stateless, optional, and the only place Cloudflare appears

```ts
import { Ingress, Placement } from "@durable-actors/ingress"

export default Ingress.make({
  cells: Config.fromControlPlane,          // or Config.literal([{ name: "eu", url: "https://eu.acme.internal" }])
  placement: Placement.fromControlPlane,   // project → cell
  auth: Grants.verify,                     // grant token → { project, scopes }
  cache: { queries: true },                // ETag/304 for GET /actors/:type/:id/:query
  websockets: "hibernating",               // Cloudflare Worker target only; Bun target keeps connections in memory
  limits: { perProject: { commandsPerSecond: 5_000 } },
})
```

Responsibilities, in order: terminate TLS; verify the grant; resolve project → cell; enforce project rate limits; forward the request to a runner in that cell (any runner: Effect Sharding routes to the owner internally); serve `304` for unchanged query ETags; terminate WebSockets/SSE for subscriptions and relay frames from the owner. No business logic, no state beyond caches. The same module builds as a Bun server (self-hosted) or a Cloudflare Worker (Rika Cloud edge). If a deployment has one cell, ingress is optional: runners can be fronted by any load balancer.

### 6.5 Requests, drawn with the clock running

```diagram
 EU user ── 25–35 ms ──▶ edge ingress (eu PoP) ── 1–3 ms ──▶ eu cell runner (any) ── Sharding hop ≤1 ms ──▶ owner runner
                                                                                                             │ turn 3–8 ms
                                                                                                             ▼
                                                                                                          Postgres (same AZ region)
   request → reply, in-region:            10–40 ms  (estimate)
   query, ETag hit at edge:                5–15 ms  (estimate; no cell round trip)
   cross-cell send (outbox → relay → target commit):   ~90 ms + relay wake  (estimate)
   cold actor (activation + fence + init):  +5–20 ms on the first command (estimate)
```

A US user commanding an EU-homed actor pays the transatlantic hop once per command (~80–100 ms est.), exactly as with Durable Objects, whose objects also never move. What we do not offer in V1 is creating the actor near the first request (`Placement.nearestOnCreate`, §13.2); with `Placement.project` a project's actors live where the project lives.

### 6.6 Cross-cell semantics, stated exactly

- A cell's store is the transaction domain; `SqlClient.SqlClient` sees one cell. A project whose actors span cells (`Placement.byKey`) has per-cell SQL, and the framework says so: the world client is `SqlClient` for *this cell*. The recommended default keeps a project in one cell so "SQL over the whole project" is true.
- Sends across cells are outbox rows relayed over HTTPS to the target cell's `/_relay` (authenticated with a cell credential from the control plane); at-least-once; deduplicated by `message_id`; per-source-actor order preserved.
- Requests across cells are not a thing inside a turn (§3.7). A client may address any actor in any cell through ingress.
- Events and subscriptions are owner-routed; a subscriber in another region connects through ingress to the home cell.
- Blob references are global (bucket + key); a cell's `BlobStore` writes to its own bucket; reading another cell's blob is an ordinary S3 read.

### 6.7 The three grids

| | Local / CI | Self-hosted | Rika Cloud |
|---|---|---|---|
| processes | one (`Runner.dev`) | N runners via Docker Compose or Kubernetes (Helm chart in `deploy/`) | cells we operate, per region |
| store | pglite in `.data/` | your Postgres 16+ | managed Postgres per cell; Neki when a cell needs it |
| blobs | filesystem | S3-compatible (MinIO, R2, S3) | S3-compatible per cell |
| ingress | none (direct) | optional Bun ingress | Cloudflare Worker edge + Bun ingress in each cell |
| control plane | in-memory | Postgres schema or YAML | replicated Postgres |
| console | `actors inspect` CLI + optional local console | console container against your store | hosted console, same tables |
| isolation per project | one store | database or schema per project (your choice) | database per project by default; schema per project on the shared tier |

The property to defend: **nothing in the programming model or the runtime model changes between columns**. The tests you run against pglite exercise the same turn, fence, outbox, and bridge code that runs in Rika Cloud; only `ActorStore` and the adapters differ, and the conformance suite (§8.6) pins them to one behavior.

### 6.8 What global distribution we do and do not get

```text
we get                                       we do not get (V1)
──────                                       ───────────────────
edge TLS, auth, rate limits, ETag reads      actors that live where the user is (nearestOnCreate is V2)
edge WebSocket termination (hibernating)     multi-master or geo-replicated writes for one actor
one home per actor, chosen at creation       one snapshot across cells
outbox relay between cells                   moving an actor between cells (Actors.rehome is V2)
per-cell residency by construction           cross-cell SQL
```

This is the honest comparison with Durable Objects: they also fix an object's location at creation and route every write to it; they place it near the first `get()`, which we defer. Everything DO adds beyond that (hibernating WebSockets, alarms, global routing) has a named counterpart above, and the thing DO cannot give (relational reads across millions of actors in one snapshot) is the reason the store sits in the cell instead of inside the object.

---

## 7. Transports and tooling: reaching actors from outside

Protocols are Effect schemas, so every transport is a derivation, not a hand-written adapter. The same `Order` type yields the HTTP API, the typed RPC client, the CLI, and the console views.

### 7.1 HTTP: `ActorHttp`

```ts
import { ActorHttp } from "@durable-actors/core"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"

export const ShopApi = HttpApi.make("shop").add(
  ActorHttp.group(Order,    { prefix: "/orders",    expose: [Get, AddItem, Place, Pay] }),   // internal commands cannot be listed here (type error)
  ActorHttp.group(Customer, { prefix: "/customers", expose: [GetProfile, BeginDunning] }),
  ActorHttp.group(Document, { prefix: "/documents", expose: [GetDoc, Apply], realtime: true }),
)

export const ShopHttp = HttpApiBuilder.serve(ShopApi).pipe(
  Layer.provide(ActorHttp.layer(ShopApi, { auth: Grants.verify })),     // one handler set for every group
)
```

Derived routes and their exact semantics:

| Route | Maps to | Status codes and headers |
|---|---|---|
| `POST /orders/:id/commands/Pay` | `ref.request` | `200` output; `409` typed domain error body (`_tag`); `202 {messageId}` when `Prefer: respond-async` (= `submit`); `429 Backpressure`; `504 RequestTimeout` (body carries `messageId` so the caller can poll) |
| `Idempotency-Key: <key>` header | `idempotencyKey` | same key + same body → same response replayed; different body → `422 IdempotencyConflict` |
| `GET /orders/:id/queries/Get` | `ref.query` | `200` with `ETag: "<incarnation>-<turn>"`; `If-None-Match` → `304`; `X-After-Turn: n` → `afterTurn`; `404 ActorNotFound` |
| `GET /orders/:id/events?from=<cursor>` | `ref.events` | SSE; `id:` field = cursor; `Last-Event-ID` reconnect; `410 CursorExpired` |
| `GET /documents/:id/live` (WebSocket) | `ref.live` + `ref.broadcast` | frames are `LiveOf<T>`; client → server frames are broadcasts (never commands) |
| `GET /submissions/:messageId` | `Actors.submission` | `200 Pending|Committed|Expired` |
| `GET /orders/:id` | `ref.inspect` | requires `inspect` scope |

Rules: commands are `POST` only; queries are `GET` and cacheable; a command's HTTP response is the receipt, so a retried `POST` with the same `Idempotency-Key` is safe by construction. OpenAPI is generated by Effect's `HttpApi` tooling with the actor protocol's schemas.

### 7.2 RPC: `ActorRpc`

```ts
// server: one line inside the runner
Layer.provide(ActorRpc.layer({ actors: [Order, Customer, Document], auth: Grants.verify }))

// client (another service, a BFF, a script)
const client = yield* ActorRpc.client({ url: "https://eu.acme.internal/_rpc", grant })
const order = yield* client.get(Order, "order_123")             // ActorRef<typeof Order>, identical API to in-process
yield* order.request(Pay.make({ paymentMethodId: "pm_1" }))
```

`ActorRpc` is Effect `RpcServer`/`RpcClient` over HTTP (batching) or WebSocket (streams), with `ActorRef` methods as the RPC group. In-process callers never go through it; Effect Sharding's own runner-to-runner transport handles that. The client is also what the CLI and console use, so there is exactly one remote protocol.

### 7.3 CLI: `actors`

```text
actors dev                                  run Runner.dev with file watching; prints the local console URL
actors migrate [--dry-run] [--wait-shards]  framework migrations, roles, RLS policies, then app migrations
actors doctor  [--against dist/app.js]      D1–D5 + index + protocol-compat findings; non-zero exit on violations
actors inspect Order/order_123              snapshot, pending messages, last receipts, recent events, outbox rows, dead letters
actors send    Order/order_123 Pay '{...}'  submit a command with an idempotency key (asks before non-idempotent)
actors query   Order/order_123 Get
actors events  Order/order_123 --from 1-0 --follow
actors replay  <message_id>                 re-enqueue a dead letter (same message_id, attempts reset)
actors discard <message_id>                 resolve a dead letter without running it (audited)
actors purge   Order/order_123 --yes        delete an actor's rows; new incarnation if recreated
actors retention run | status               prune per policy; show table sizes and oldest rows
actors cells   list | add | drain           control-plane operations
actors grants  create --project acme/prod --scopes command:Order,query:*  --ttl 30d
```

Every command is `ActorRpc` plus SQL over the same tables; there is no privileged side channel, so anything the CLI can show, the console shows, and anything the console can do, a script can do.

### 7.4 Auth: grants

A **grant** is a signed token (`{ project, subject, scopes, exp }`) verified at ingress and again at the runner. Scopes are `command:<Type>[.<Command>]`, `query:<Type>`, `events:<Type>`, `inspect`, `admin`. Internal commands (`Actor.command(..., { internal: true })`) have no scope and cannot be granted; they are accepted only from the runtime's own bridges, which sign envelopes with the cell credential. Application-level authorization (may *this* customer pay *this* order) belongs in the handler with `ctx.message.origin`, never in ingress.

### 7.5 Console

The console is a web UI over `ActorRpc` + the world SQL client: search actors by type/id or by SQL; timeline of a message (accepted → committed → delivered, with receipt and events); dead-letter queue with replay/discard; outbox lag per domain; timer lateness; resident/hot actors per runner; migration status per shard. It ships as a container for self-hosted and is hosted in Rika Cloud, reading the same tables in both cases.

---

## 8. Testing: the guarantees are tested, not described

The runtime that tests run is the production runtime with three substitutions: `ActorStore.pglite` (a real Postgres in-process), `TestClock` (durable time is a message with `deliver_at`, so advancing the clock fires timers deterministically), and `Faults` (named crash points inside the turn pipeline). Nothing is mocked above the store.

### 8.1 `@durable-actors/testing`

```ts
import { it } from "@effect/vitest"
import { ActorsTest, Faults } from "@durable-actors/testing"

const Test = ActorsTest.layer({
  actors: [OrderLive, InventoryLive],
  activities: [CapturePayment],
  workflows: [RefundWithApproval],
  services: [StripeTest],                       // your fakes for external services, as Layers
})
```

```ts
interface ActorsTest {
  readonly actors: Actors                       // full refs, as from an HTTP handler
  readonly settle: Effect<void>                 // run until no pending messages, timers due now, outbox rows, or running workflow steps remain
  readonly turns: (ref: ActorRef<any>) => Effect<number>
  readonly events: <T>(ref: ActorRef<T>) => Effect<ReadonlyArray<Committed<EventOf<T>>>>
  readonly receipts: (ref: ActorRef<any>) => Effect<ReadonlyArray<Receipt>>
  readonly deadLetters: Effect<ReadonlyArray<DeadLetter>>
  readonly sql: SqlClient.SqlClient             // the world client (read-only role)
  readonly clock: TestClock.TestClock           // adjust → due timers fire on the next settle
  readonly faults: Faults
  readonly cluster: (n: number) => Effect<void> // rebalance shards across n simulated runners in-process (fence handoffs happen for real)
  readonly cells: (n: number) => Effect<void>   // n pglite stores + in-process relay; Placement decides where actors live
  readonly crashRunner: (i: number) => Effect<void>
}

interface Faults {
  readonly crashOnce: (point: FaultPoint, filter?: (m: EnvelopeInfo) => boolean) => Effect<void>
  readonly pauseAt:   (point: FaultPoint, filter?: (m: EnvelopeInfo) => boolean) => Effect<Latch>   // hold a fiber there until released
  readonly failOnce:  (point: FaultPoint, error: unknown) => Effect<void>
}
type FaultPoint =
  | "turn.beforeCommit" | "turn.afterCommit" | "reply.beforeSend"
  | "activity.afterEffect" | "job.afterEffect" | "workflow.step.afterEffect"
  | "timer.afterFire" | "outbox.afterTargetInsert" | "relay.beforeMark"
```

### 8.2 Tests that a wrong implementation fails

```ts
it.effect("a rejected command commits a receipt and does not advance the turn", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    const order = yield* t.actors.get(Order, "o1")
    yield* order.request(AddItem.make({ sku: "s", quantity: 1, priceCents: 100 }))
    const before = yield* t.turns(order)

    const exit = yield* order.request(Pay.make({ paymentMethodId: "pm" })).pipe(Effect.exit)   // not placed yet
    assert(Exit.isFailure(exit) && exit.error._tag === "CannotPay")
    assert.strictEqual(yield* t.turns(order), before)                                          // ETag unchanged
    assert.strictEqual((yield* t.receipts(order)).at(-1)?.kind, "Rejected")
  }).pipe(Effect.provide(Test)))

it.effect("crash after commit, before reply: exactly one execution, caller still gets the result", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    const order = yield* placedOrder(t, "o2")
    yield* t.faults.crashOnce("reply.beforeSend", (m) => m.command === "Pay")

    yield* order.request(Pay.make({ paymentMethodId: "pm" }), { idempotencyKey: "k1", timeout: "1 second" }).pipe(Effect.ignore)
    const again = yield* order.request(Pay.make({ paymentMethodId: "pm" }), { idempotencyKey: "k1" })   // replays the receipt

    const captures = yield* t.sql`SELECT count(*)::int AS n FROM payment_attempts WHERE actor_id = 'o2'`
    assert.strictEqual(captures[0].n, 1)                                                        // the wrong implementation shows 2
    assert.strictEqual((yield* t.events(order)).filter((e) => e.event._tag === "OrderPaid").length, 1)
  }).pipe(Effect.provide(Test)))

it.effect("a stale owner cannot commit", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    yield* t.cluster(2)
    const order = yield* placedOrder(t, "o3")
    const latch = yield* t.faults.pauseAt("turn.beforeCommit", (m) => m.command === "Pay")      // old owner frozen mid-turn

    const pending = yield* order.submit(Pay.make({ paymentMethodId: "pm" }))
    yield* t.cluster(1)                                                                          // rebalance: another runner becomes owner
    yield* latch.release                                                                         // old owner resumes → StaleWriter, rolls back
    yield* t.settle

    assert.strictEqual((yield* t.receipts(order)).filter((r) => r.messageId === pending.messageId).length, 1)
    assert.strictEqual((yield* t.sql`SELECT count(*)::int AS n FROM payment_attempts WHERE actor_id = 'o3'`)[0].n, 1)
  }).pipe(Effect.provide(Test)))

it.effect("timers are durable and fire in order after a crash", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    const order = yield* paidOrder(t, "o4")                       // schedules AskForReview in 30 days
    yield* t.crashRunner(0)
    yield* t.clock.adjust("29 days"); yield* t.settle
    assert.isFalse((yield* t.events(order)).some((e) => e.event._tag === "ReviewRequested"))
    yield* t.clock.adjust("1 day"); yield* t.settle
    assert.isTrue((yield* t.events(order)).some((e) => e.event._tag === "ReviewRequested"))
  }).pipe(Effect.provide(Test)))

it.effect("an activity whose outcome is unknowable surfaces ActivityUnknown, never a blind retry", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    const order = yield* placedOrder(t, "o5")
    yield* t.faults.crashOnce("activity.afterEffect", (m) => m.activity === "CapturePayment")
    yield* StripeTest.failReadsAfter(1)                            // reconciliation read also fails → unknowable
    yield* order.request(Pay.make({ paymentMethodId: "pm" })); yield* t.settle
    const attempt = yield* order.query(GetPaymentAttempt.make())
    assert.strictEqual(attempt.outcome, "unknown")
    assert.strictEqual(yield* StripeTest.captureCalls, 1)
  }).pipe(Effect.provide(Test)))

it.effect("cross-cell send is delivered once even when the relay crashes after the target insert", () =>
  Effect.gen(function* () {
    const t = yield* ActorsTest
    yield* t.cells(2)                                              // Order in cell A, Inventory in cell B via Placement.byKey in the test layer
    yield* t.faults.crashOnce("relay.beforeMark")
    const order = yield* paidOrder(t, "o6"); yield* t.settle
    const inv = yield* t.actors.get(Inventory, "shirt")
    assert.strictEqual((yield* t.events(inv)).filter((e) => e.event._tag === "Reserved").length, 1)
  }).pipe(Effect.provide(Test)))
```

### 8.3 The invariant oracle for property tests

Random sequences of commands, crashes, rebalances, and clock jumps, checked after every `settle` against invariants that do not depend on the domain:

```text
I1  for every message_id: at most one receipt
I2  actors.turn == count(receipts where kind = Committed) for the actor
I3  actor_events.seq is exactly 1..last_event_seq with no gaps, per (actor_key, incarnation)
I4  every outbox row with relayed_at IS NULL is younger than the relay SLA after settle → none remain
I5  no row in any actor-owned table has an actor_id that was never in `actors`          (RLS + D4)
I6  every payment_attempts row has exactly one provider call recorded in StripeTest       (activity dedupe)
I7  turn(t+1) - turn(t) ∈ {0, 1} for every observed pair of consecutive receipts           (no skipped or double turns)
```

The domain part of a property test is a model (`Map<orderId, OrderModel>`) updated with the same random commands; after `settle`, `query(Get)` must equal the model for every order. The framework ships the oracle for I1–I5; the app adds I6-style checks for its activities.

### 8.4 What each layer of the pyramid is for

| Level | Runs | Catches |
|---|---|---|
| handler unit | handler functions with `Database` over pglite, no cluster | domain logic; schema mistakes; RLS violations (`ForeignRowWrite`) |
| actor integration | `ActorsTest.layer`, one runner | turn semantics, timers, events, bridges, idempotency |
| cluster | `t.cluster(n)`, `crashRunner`, `pauseAt` | fence, redelivery, receipts across owners |
| multi-cell | `t.cells(n)` | outbox relay, placement, per-cell SQL visibility |
| store conformance | same scenarios × {pglite, postgres, neki (CI nightly against a Neki branch)} | driver differences: `tx_mode`, RLS on Neki, dedupe, ordering |
| load (estimates → measurements) | `bench/` against Postgres in CI weekly | turn latency, per-actor throughput, relay lag; the numbers in §10 become measured |

### 8.5 Local development is the same runtime

`actors dev` starts `Runner.dev` with pglite in `.data/`, all pools in-process, a local console, and file watching; a change to a handler reloads the process and the data stays. There is no "dev mode" in the semantics: the fence, receipts, outbox, and RLS are all on. The only differences from production are the store adapter, in-memory runner registry, and a real clock instead of `TestClock`.

### 8.6 Store conformance suite

`@durable-actors/testing/store-conformance` is a vitest project parameterized by an `ActorStore` layer. It exercises: duplicate `message_id` on insert; fence handoff; `SAVEPOINT` rollback of a domain error; `deliver_at` polling; `FOR UPDATE SKIP LOCKED` claim semantics; RLS setting scope (`SET LOCAL` resets on commit); outbox claim/mark; retention pruning; and, for Neki, `domainOf` correctness against `__neki` metadata, `tx_mode='single'` rejection of an accidental cross-shard write, and the `db_shard IN (…)` poll rewrite. `ActorStore.neki` cannot ship until this suite is green against a real Neki branch.

---

## 9. Operations: observing, securing, and repairing a cell

### 9.1 Observability: one correlation model, bounded metrics

Effect logging/tracing/metrics exported over OTLP; a local OpenTelemetry Collector in `actors dev`; Grafana Cloud as the first managed target (evaluated, not committed).

Every span and log line carries the same fields, and high-cardinality ids go into traces and logs, never into metric labels:

```text
project · actor_type · actor_id · incarnation · generation · turn
message_id · idempotency_key (hashed) · correlation_id · causation_id · origin
runner_id · cell · shard_id · db_shard · pool
code_version · protocol_version
workflow_id / activity execution_id / job execution_id
```

Required metrics (bounded labels: `project`, `actor_type`, `cell`, `pool`, `result`):

| Metric | Why it is required |
|---|---|
| `commands_accepted / committed / rejected / dead_lettered` | the delivery funnel; rejected ≠ failed |
| `turn_duration` histogram; `turn_retry_count` | the primary latency; retries reveal defects and lock waits |
| `pending_messages` gauge and `oldest_pending_age` per shard | backlog; the alert that matters |
| `fence_rejections` | expected during rebalance, otherwise ownership disagreement |
| `outbox_pending` and `outbox_oldest_age` per target domain | relay health; cross-cell lag |
| `timer_lateness` histogram | the honest measure of durable time |
| `activity_unknown_total` | every one is a reconciliation task |
| `resident_actors`, `activations`, `passivations` per runner | memory and churn |
| `event_subscribers`, `subscription_buffer_bytes` | realtime pressure |
| `store_tx_duration`, `store_rollbacks`, `pool_wait` | the database's view |
| `admission_rejections` per project | who is being throttled |

Redaction: metadata-only logging by default; no SQL parameter values, command payloads, blob content, or grant tokens in telemetry. A debug mode that logs payloads is per-project, time-boxed, and audited.

The operator timeline (console and `actors inspect`) joins acceptance, activation, receipt, outgoing intents, relay status, and workflow/activity status for one `message_id` without pretending they were one transaction: "committed locally" and "external work still running" are different rows with different timestamps.

### 9.2 Security: threat model highlights

The MVP hosts **trusted code** per isolated application deployment. It is not a shared JavaScript VM for arbitrary tenants; that product needs a sandbox review and an incident-response owner beyond this document.

| Threat | Entry point | Control | Evidence |
|---|---|---|---|
| cross-project actor access | ingress / RPC | grant carries `project`; store key never includes it; project = database/schema | negative lookup tests |
| privileged command spoof | user-supplied command tag | `internal: true` commands have no scope; bridges sign envelopes with the cell credential | direct internal-tag request → `403` test |
| stale writer | paused runner | fence in the turn transaction | two-owner fault test (§8.2) |
| writes outside actor authority | raw SQL in a handler | RLS on the turn role (§5.2); world role read-only | `ForeignRowWrite` test; role grants audited in `doctor` |
| replay / dedupe abuse | reused `Idempotency-Key` | payload digest → `IdempotencyConflict`; incarnation in envelopes; documented retention window | same-key/different-body test |
| fan-out storm | actors sending to actors | per-actor `maxPending`, per-project token bucket, root `correlation_id` budgets (V2) | cyclic-send load test |
| blob cross-prefix access | signed URLs | per-project prefix, method-scoped short-lived signatures | traversal tests |
| credential leak | logs, receipts | metadata-only logging; receipts store encoded exits, not request headers | canary-secret scan in CI |
| supply chain / CI | publish, forks | lockfile, pinned actions, no secrets on fork builds, provenance | workflow policy audit |
| restore inconsistencies | admin recovery | incarnation bump + dead-letter of old-incarnation messages (§5.6) | restore game day |

Incident controls that must exist before hosting paying customers: suspend a project (reject at ingress, keep accepted work), revoke grants, rotate the cell credential, freeze an actor type's writes, and report for any `message_id` whether it was accepted, committed, externally executed, or unknown.

### 9.3 Multitenancy and isolation

```text
organization → application → environment (= project) → actor type → actor id → incarnation
```

- A project is the isolation unit: its own database (Rika Cloud default; self-hosted recommendation) or its own schema (shared tier). Business tables never carry a project column; a project cannot express a query over another project's rows because the connection cannot see them.
- Runtime roles (`turn`, `world`, `admin`) are per project; connection budgets are per role and per project.
- Noisy neighbors: admission per project at ingress and at the store; resident-entity caps per runner; pools separate latency-sensitive actors from throughput workers; large customers get dedicated cells.
- Hosted rollout: (1) dedicated runners per application on a managed control plane; (2) shared trusted runtime with per-application code isolation and budgets; (3) regional placement and private cells after operational evidence.
- Idle actors are not free: `actors` rows, event partitions, backups, and retention jobs cost per identity; pricing must reflect stored rows and events, not only executed turns.

### 9.4 Connection pooling and the two kinds of connections

`SET LOCAL` and `FOR UPDATE` are transaction-scoped, so turns work behind a transaction-mode pooler (PgBouncer, PlanetScale's pooler). Effect's `SqlRunnerStorage` advisory locks are session-scoped and need a direct/session connection; the runner keeps one dedicated session connection for leases and uses the pooled connection for turns. `LISTEN/NOTIFY` also needs a session connection (one per runner). `Runner.layer` allocates these three classes explicitly and `doctor` reports if the configured URL is a transaction pooler for the lease connection.

### 9.5 Runbooks

| Situation | Steps | Never |
|---|---|---|
| command stuck | `actors inspect <key>`: is the message pending (owner down? shard unassigned?), committed (receipt exists; reply lost), relayed (outbox row), or waiting on external work (activity/workflow row)? Repair the transport; return the receipt | resend with a new `message_id` |
| fence rejections spike | expected during a rebalance; if sustained, two runners disagree on ownership: collect runner ids, generations, lease rows; stop the older runner | clear `cluster_locks`/`actors.generation` by hand to "make it pass" |
| dead letters growing | read the cause; deploy a fix; `actors replay` per message or by filter; `actors discard` only with a written reason | delete the rows |
| outbox age alert | is the relay leader alive (singleton)? is the target cell reachable (`/_relay` health)? is the target rejecting (auth, protocol)? Fix and let it drain | edit `relayed_at` |
| timer lateness | poller healthy? shards assigned? store latency? Late timers fire; nothing to replay | re-schedule manually (duplicates) |
| `ActivityUnknown` | query the provider with the stored `executionId`; record the outcome via the domain command (`ConfirmCapture`/`MarkDeclined`); compensation is a new tracked operation | mark a payment failed because a fiber was interrupted |
| migration failed on Neki | `actors migrate --status` per shard; transactional DDL rolls back per shard, not across shards; deploy a corrective forward migration | edit an applied migration |
| restore | freeze the project at ingress; restore to a new incarnation; reconcile dead-lettered old-incarnation messages and open activities; run the invariant oracle (§8.3); unfreeze | treat a restore as a rollback of external effects |
| hot actor | `pending` on one key climbs while others idle; shard the write path (stats actors, per-day keys); reads move to SQL | raise `maxPending` and hope |

Before paid hosting, each runbook is executed in a staging game day with the actual commands and dashboards attached to it.

---

## 10. Capacity and cost: estimates to be replaced by measurements

Every number here is an estimate from component characteristics; M1 and M3 replace them with benchmarks (§13). They are included so that design decisions can be checked against magnitudes.

### 10.1 Latency

| Path | Estimate | Dominant term |
|---|---|---|
| turn (fence + handler + receipt + commit), warm actor, same-AZ Postgres | 3–8 ms | one transaction with 4–8 statements and fsync |
| request → reply, in-region client | 10–40 ms | turn + Sharding hop + poll/notify wake |
| first command on a cold actor | + 5–20 ms | activation, fence `UPDATE`, `init`, cache warm |
| query at owner, resident | 1–5 ms | one read-only snapshot |
| query via edge ETag hit | 5–15 ms | edge only |
| timer fire after due | ≤ poll interval (10 s) or ~ms with NOTIFY | polling cadence |
| cross-cell send end to end | ~90 ms + relay wake | WAN RTT + two commits |
| activity round trip (start → completion command) | 50 ms + provider latency | worker pickup + provider + completion insert |

### 10.2 Throughput

| Unit | Estimate | Limiter |
|---|---|---|
| one hot actor | 150–300 turns/s | serialization + turn latency (1 / turn time) |
| one Postgres primary cell | ~10^4 commands/s | commit rate, WAL, row-lock churn on `actors` |
| one actor runner (1 vCPU) | 1–3 k turns/s | Effect fiber + SQL driver CPU |
| Neki cell with N shards | ~N × 10^4 commands/s minus relay overhead | cross-shard send ratio |
| outbox relay per domain | 5–20 k msgs/s per leader | batch inserts (500/tx) |
| events per cell | bounded by the same commit rate; ~1–3 events per turn typical | |

Two consequences drive design more than any other: a single actor is a ~200 turns/s resource, so fan-in must shard; and a single Postgres primary is a ~10^4 turns/s resource, so Neki (or another cell for residency, never for capacity) is the answer above that.

### 10.3 Cost drivers for Rika Cloud

| Driver | Meter |
|---|---|
| compute | runner vCPU-seconds (actor pools) and worker execution-seconds (activity/job/workflow pools) |
| storage | rows and events retained (GB-month), blob GB-month |
| database | Postgres/Neki instance and shard count per cell |
| egress | events/subscriptions and blob reads |
| identities | `actors` rows and per-type partitions (small but nonzero; do not promise free idle actors) |

Public meters to evaluate for pricing: committed turns, stored events GB, worker seconds, active actors per month. Margin claims wait for measured cost per turn on a real cell.

---

## 11. Decision log

### 11.1 Decisions, with what they replaced

| # | Decision | Rationale | Rejected alternative | Status |
|---|---|---|---|---|
| 1 | Actor boundary = mutation authority; storage is shared relational | keeps SQL over the whole cell; no projection layer; every runtime concern is a row | actor = private database (Rivet, DO, original Turso plan) | settled |
| 2 | One command = one database transaction including events, intents, receipt, turn | G1; makes crash recovery a property of the database | app-level sagas per command; dual writes | settled |
| 3 | Ownership fence (`actors.generation`) checked under `FOR UPDATE` in the turn | leases are hints; the database must arbitrate | trust Sharding leases; advisory locks alone | settled |
| 4 | Only `send` to other actors inside a turn; `request`/`query` forbidden | no lock chains, no long transactions, shard-local turns; sagas are explicit | allow nested request with timeouts | settled, enforced by types |
| 5 | Two SQL clients: `Database` (turn, own rows) and `SqlClient` (world, read-only role) | states the model in the type system and in the DB roles | one client with conventions | settled |
| 6 | D4 enforced with row-level security on the turn role | works for raw SQL, pglite and Postgres alike, no parser | dev/test statement parser (fallback if Neki lacks RLS) | new in this doc |
| 7 | `db_shard INT` on every actor-owned table from V1; `K = shardsPerGroup = 300`; same hash as Effect's shard id | Neki move becomes a topology change; poll queries stay shard-local | add the column at Neki time (10^8-row backfill); independent hash (scatter polls) | new in this doc |
| 8 | Stock Effect cluster tables in V1; custom `MessageStorage`/`RunnerStorage` driver only for Neki | ship on Effect's tested code; Neki needs shard columns and no sequences | fork the stock driver now | settled |
| 9 | Domain errors commit a rejected receipt and do not advance `turn` | state unchanged ⇒ version unchanged; ETags stay valid | bump turn on every receipt | settled |
| 10 | Defects retry 3× then dead-letter with a `Defect` receipt | a poison message must not block an actor forever; operators replay after a fix | infinite retry; drop silently | new in this doc |
| 11 | pglite for local dev and tests | same dialect, RLS, `FOR UPDATE`, `SKIP LOCKED` as production; no Docker | SQLite (dialect drift), Docker Postgres (setup friction) | settled |
| 12 | Cells: independent clusters, never stretched; multiple cells for geography and residency, Neki for capacity | leases/polls/turns assume a local store; failure domains stay honest | one global cluster; multi-region Postgres | settled |
| 13 | Cloudflare only as optional edge ingress (Worker build of `Ingress`) | edge TLS/auth/cache/WS termination is what the edge is good at | Durable Objects as the actor host (two state systems, DO SQLite vs Neki) | settled |
| 14 | No standalone hosted functions; a worker is a runner with no actors | avoids a second product; activities/jobs/workflows already are "compute for actors" | `Function.make` product | settled (user) |
| 15 | No hybrid "Rika compute + customer Postgres over the WAN" | every turn would cross the WAN; the single runtime promise breaks | hybrid compute | settled (user) |
| 16 | Effect Cluster/Workflow for queues, timers, deferreds; no SQS/Kafka on the hot path | one runtime, one store, local testability | SQS-shaped queues | settled |
| 17 | Projections as a framework feature removed | SQL over the truth is the projection; analytics stores use the database's CDC | projection sinks to customer Postgres (hybrid docs) | changed from earlier docs |
| 18 | Hot cache is per activation, derived, applied post-commit; no shared cache tier | coherence by construction | Redis-style shared cache as read authority | changed from `CACHE.md` |
| 19 | Placement fixed at creation (`project`, `byKey`); `nearestOnCreate` and `rehome` are V2 | correctness first; both need a global directory | move actors dynamically | settled for V1 |
| 20 | Timers cannot be cancelled in V1; handlers ignore stale timers by state | cancellation needs a named-timer index; adding later is additive | named timers now | V1 scope |
| 21 | `Actor.job`, `Actor.workflow`, `Actor.activity` lower-case constructors | consistent with `Actor.command`/`Actor.query` | `Actor.Job` (user preference noted) | open for veto |
| 22 | Grants as the only auth primitive; internal commands ungrantable | small surface; bridges authenticate with the cell credential | per-command policies in ingress | settled |
| 23 | Events partitioned monthly; retention per type; `forever` explicit | 10^9-event tables need partitions to prune | flat table | new in this doc |
| 24 | Project = closed world; no project column in business tables; isolation by database/schema | cross-project queries are impossible rather than forbidden | `tenant_id` in every PK | settled |
| 25 | Bun primary, Node 24 supported, one binary for all roles | single runtime promise; role is config | separate worker binary | settled |

### 11.2 Changes relative to earlier documents

| Earlier position (document) | Now | Why |
|---|---|---|
| Turso/libSQL database per actor (`INTERFACES.md`, `DURABILITY.md`) | one Postgres per cell; actor key leads every PK | relational observation; no second state system |
| projection sinks to customer Postgres (`PROJECTIONS.md`, `PROJECTION_ACTORS.md`) | removed | truth is already relational |
| Railway/AWS/Alchemy platform discussions (`CLOUD_ARCHITECTURE.md`, hybrid review) | cells on managed Postgres, Neki when needed; platform choice deferred to M5 | architecture must not depend on the host |
| Durable Objects as physical actor host (hybrid review) | optional edge ingress only | DO SQLite would become a second authority; hibernation/eviction do not fit turn transactions |
| SQLite for local dev (`LOCAL_DEVELOPMENT.md`) | pglite | dialect parity, RLS, locking semantics |
| dev/test parser guard for raw SQL (`durable-actors-v1-surface.md`) | RLS policies | database-enforced, production too |
| `ActorStore.neki({ buckets: 256 })` (`durable-actors-v1-surface.md`) | `ActorStore.neki()`, `K = 300` aligned with Effect | shard-local polling |
| in-turn `request`/`query` "probably forbidden" (hybrid handoff) | forbidden and type-enforced | see decision 4 |
| receipts bump `turn` on rejection (implicit in scenarios) | rejection leaves `turn` unchanged | ETag correctness |
| no poison-message policy | dead letters after 3 defects | operability |
| `@durable-actors/postgres` as a separate package (earlier package lists) | Postgres store implementations live in `core` | there is one SQL dialect by design; a package boundary would be a fake abstraction |

---

## 12. Lineage and positioning

### 12.1 Where the ideas come from

| Idea in this design | Source | What we take, what we change |
|---|---|---|
| actor = identity + mailbox + behavior + authority | Hewitt, Bishop, Steiger (1973); Agha (1986) | the model; we add "authority over rows carrying its key", not "owns its storage" |
| virtual actors: exist without a process, activate on demand, single activation | Orleans (Bykov et al., 2011) | activation/passivation; our single-activation guarantee is the database fence, not a directory |
| actor database systems: actors as the unit of transactional state inside a DBMS | Shah & Salles, "Reactors" (SIGMOD 2018) | the observation that actor boundaries and query boundaries can differ; we run on stock Postgres instead of a new engine |
| durable execution: journaled steps, sleeps, external signals | Temporal; Restate; Effect Workflow | used as-is for workflows; bridged to actors by completion commands |
| outbox pattern | transactional messaging literature | the cross-domain path; the in-domain path needs no outbox because messages are rows in the same transaction |
| fencing tokens | Kleppmann's lease critique; ZooKeeper `zxid` | `generation` checked inside the transaction |
| commutativity classes, escrow | RedBlue consistency (Li et al., 2012), Sieve, O'Neil escrow (1986) | research input for "serialize conflicts, not requests" (§13.4) |
| hibernating WebSockets, alarms, edge placement | Cloudflare Durable Objects | edge adapter behaviors; not the state model |
| per-actor SQLite, typed actions in Effect | Rivet Actors (`@rivetkit/effect`) | the reminder that typed Effect actions alone are not a differentiator |

### 12.2 What to say, and what not to say

Say:

- "Millions of independently serialized durable actors over one relational database. SQL sees across actors; only actors write."
- "One command is one Postgres transaction: state, events, timers, and messages to other actors commit together."
- "The runtime you test with pglite is the runtime you ship, self-hosted or on Rika Cloud."
- "Activities, jobs, workflows, and cron are Effect Workflow with actor-shaped completion; you never wait inside a turn."

Do not say:

- "exactly-once" (say: at-least-once delivery, deduplicated state transitions)
- "globally consistent" (say: consistent per cell / per transaction domain)
- "actors move to your users" (say: actors have a home; the edge terminates connections)
- "no operations" (say: the runtime is rows you can inspect with SQL)
- any number from §10 without the word estimate until M3 measures it

### 12.3 Where it fits

```diagram
                 relational, cross-entity reads
                              ▲
      Postgres + app code     │     Durable Actors
      (stateless services)    │     (this document)
                              │
 ─────────────────────────────┼───────────────────────────── durable per-entity authority
                              │
      Temporal / Restate      │     Rivet / Durable Objects / Orleans
      (workflows, no entity   │     (entity = storage boundary)
       state model)           │
                              ▼
                  per-entity, isolated state
```

The quadrant that was empty: durable per-entity authority **and** relational cross-entity reads in one system. Everything else in this document exists to keep that quadrant honest.

---

## 13. Roadmap, gates, open questions, research

### 13.1 Milestones and exit gates

Each milestone ends with a gate that is a test or a measurement, not a demo.

| M | Deliverable | Gate |
|---|---|---|
| M0 tooling | Bun workspace, Turbo, Oxlint, `@effect/vitest`, pglite in CI, Effect pinned to a v4 rc | `bun test` green on an empty `core`; CI < 5 min |
| M1 single-actor truth | `Actor.make/command/query/event`, `Database`, RLS, fence, receipts, `Runner.dev`, `ActorsTest` with `Faults` | §8.2 tests 1–2 pass; invariant oracle I1–I3, I5 on 10^5 random ops; measured turn latency on pglite and Postgres replaces the §10 estimate |
| M2 delivery | timers, sends, `submit`/`Submission`, admission, `t.cluster(n)`, fence handoff, dead letters | §8.2 tests 3–4 pass; I7; 24 h soak with kill -9 every 30 s loses no acknowledged command |
| M3 usable app | `ActorHttp`, `ActorRpc`, CLI (`dev/migrate/doctor/inspect/replay`), console v0, example shop | example app end to end; p95 request→reply measured in-region; `doctor` catches D1–D5 in fixture schemas |
| M4 external work | `Actor.activity/job/workflow/cron`, bridges, `ActivityUnknown`, `BlobStore` | §8.2 test 5 passes; I6; a workflow survives runner restart mid-sleep and mid-deferred |
| M5 cells and ingress | outbox relay, `/_relay`, `Ingress` Bun build, control plane rows, `t.cells(n)`, Helm/Compose | §8.2 test 6 passes; cross-cell lag measured; self-hosted install from docs in < 1 h by someone outside the team |
| M6 Neki | `ActorStore.neki` driver, `db_shard IN` rewrite, `tx_mode='single'`, RLS verified, conformance suite nightly | conformance green on a real Neki branch; single-shard turn ratio ≥ 99% on the example app; cross-shard send path measured |
| M7 design partners | 3 external teams on self-hosted or Rika Cloud alpha; game days for §9.5 | each partner's stated cross-actor query answered with SQL, no projection; incident runbooks executed with evidence |

Rough sequencing (estimate): M0–M2 are the correctness core and take the longest per line of code; M3 is where the product becomes visible; M4–M5 can overlap; M6 waits for Neki GA and for M5's relay, because the relay is also the cross-shard path.

### 13.2 V2 items, all additive

| Item | What it needs | Why not V1 |
|---|---|---|
| `Placement.nearestOnCreate` | a global directory with a consistent create (`actors_directory` in the control plane, one writer per key) | correctness of the directory is a project by itself |
| `Actors.rehome` | freeze → copy rows by actor key → switch directory → drain outbox → unfreeze | needs the directory; bounded because the actor key leads every PK |
| named, cancellable timers | `actor_timers (actor_key, name)` index and cancel semantics in the turn | additive; V1 handlers ignore stale timers by state |
| `consistency: "eventual"` queries from replicas | replica routing in `ActorStore`, staleness bound in the query options | read scaling is not the V1 bottleneck |
| root `correlation_id` budgets | count messages per root id in admission | fan-out storms are rare with sharded fan-in; needs data |
| `@durable-actors/cloudflare` | Worker build of `Ingress`, hibernating WebSocket bridge to owner streams | the Bun ingress is enough for self-hosted and the first cloud cells |
| per-command `turn.retries` and retry schedules | option on `Actor.command` | global default of 3 is fine to start |
| intra-actor concurrency (below) | research | not a V2 item until the research says so |

### 13.3 Open questions (owner: Rika; answer before the milestone named)

| Question | Options | Decide by |
|---|---|---|
| `Actor.job` vs `Actor.Job` capitalization | lower-case (current) vs PascalCase constructors | M1 (renames are cheap now, expensive after M3) |
| Does Neki enforce RLS per shard with `SET LOCAL` visible through its router? | RLS (current) vs parser guard fallback | M6 spike, before M4 completes so `Database` does not depend on it silently |
| Effect's `hashString` stability across v4 releases | pin a copy + startup check (current) vs derive `db_shard` from our own hash and accept scatter polls | M1 |
| Message payload storage: JSONB vs bytea (MessagePack) | JSONB (inspectable, current) vs bytea (smaller) | M2, after measuring row sizes |
| Events `forever` default vs 400 days | `forever` per type (current) | M3, after partition tooling exists |
| Console: build vs Effect DevTools | small custom console over `ActorRpc` (current) | M3 |
| Hosted control plane database | replicated Postgres (current) vs Cloudflare D1/KV at the edge | M5 |
| Pricing meters | committed turns + stored GB + worker seconds (candidate) | M7, with measured cost per turn |

### 13.4 Research: "serialize conflicts, not requests"

The V1 rule is one turn at a time per actor. The research question is whether an actor can accept concurrent turns for commands that provably do not conflict, without giving up G1–G3.

```text
what would have to be true                                  how we would find out
──────────────────────────                                  ──────────────────────
commands declare or infer a write footprint                 static analysis of Database calls per handler; or explicit `Actor.command(..., { footprint })`
two footprints conflict iff they touch the same rows/cols   row-level in Postgres: FOR UPDATE on disjoint rows already serializes only conflicts
events keep a total order per actor                          seq assignment becomes the serialization point; concurrent turns contend on one row → back to serial
receipts and turn numbers stay meaningful                    `turn` becomes a vector or a commit counter, ETag semantics change
```

The literature to apply: RedBlue consistency (blue = commutative, red = serialized), Sieve (automatic classification), escrow transactions for counters, and Reactors' sub-actor transactions. The likely outcome is narrow: commutative counters and append-only sub-tables (order items) as a declared `Actor.command(..., { commutes: true })` class, executed without the fence lock but with the receipt and `seq` still serialized. Until a prototype shows a throughput win on a realistic hot actor (≥ 3× on the sharded-stats benchmark, estimate), it stays out of the roadmap.

---

## 14. Packages and repository

```text
durable-actors/
  packages/
    core/          Actor · Database · Actors · ActorRef · TurnContext · Runner · ClusterRuntime · ActorStore (pglite, postgres)
                   ActorHttp · ActorRpc · BlobStore (s3, fs, memory) · Placement · Grants · errors · bridges · relay
    testing/       ActorsTest · Faults · invariant oracle · store-conformance · fakes
    cli/           `actors` binary (Effect CLI) over ActorRpc + SqlClient
    ingress/       Ingress.make; Bun server build; Worker build (later moves the CF-specific parts to `cloudflare`)
    neki/          (M6) ActorStore.neki: domainOf, tx_mode, db_shard-aware MessageStorage/RunnerStorage
    cloudflare/    (V2) Worker ingress, hibernating WebSocket adapter
  apps/
    console/       web console (SvelteKit or similar; reads via ActorRpc + world SQL)
    example-shop/  Order · Customer · Inventory · Document · Assistant; the app every test and benchmark uses
  deploy/          Docker Compose, Helm chart, control-plane bootstrap
  bench/           turn latency, hot actor, cell throughput, relay lag; weekly CI job
```

Conventions: Bun workspaces + Turbo; Oxlint; `@effect/vitest` with mirrored `test/` trees; every public function has a doc comment with its guarantee sentence; `core` has no dependency on `testing` or `cli`; the only runtime dependencies of `core` are `effect`, `@effect/platform-bun`/`node`, `@effect/sql-pg`, and (optional peer) `@electric-sql/pglite`. There is no `@durable-actors/postgres` because Postgres is the only dialect by design; a dialect abstraction would exist only to be unused.

Naming in code follows the document: a file is named for the concept it owns (`turn.ts`, `fence.ts`, `outbox-relay.ts`, `activity-bridge.ts`), errors live in `errors.ts` as `Schema.TaggedError`, and the runtime tables' DDL lives next to the code that uses it (`store/ddl.sql`) and is copied into the conformance suite verbatim.

---

## 15. Sources

External facts used in this document, with the date each was read. Anything not listed here is design, not a claim about a third party.

| Source | Used for | Read |
|---|---|---|
| Effect `main` (`4.0.0-rc.116`), `packages/effect/src/unstable/cluster/` (`Sharding`, `Entity`, `MessageStorage`, `SqlMessageStorage`, `SqlRunnerStorage`, `ClusterSchema`, `DeliverAt`, `EntityReaper`), `unstable/workflow/` (`Workflow`, `Activity`, `DurableClock`, `DurableDeferred`, `ClusterWorkflowEngine`) | shard id formula (`|hashString(id)| % shardsPerGroup + 1`, default 300), `Persisted`, `WithTransaction`, `SaveResult.Duplicate`, polling cadence (10 s / notify), `maxIdleTime` 1 min, `mailboxCapacity` 4096, `maxResidentEntities` 10 000, pluggable storage interfaces, no Cloudflare code | 2026-09-18 |
| PlanetScale Neki documentation and announcement | platform preview (2026-09-10), hosted only, unsharded start, no cross-shard atomic commit, `__neki.tx_mode`, `__neki.fanout`, shard index types (xxhash/modulo/range), sequences single-shard, scatter joins, single region (3 AZs) | 2026-09-18 |
| Cloudflare Durable Objects docs and pricing | hibernation constraints, eviction timing (10 s hibernate / 70–140 s evict), placement at first `get()` with no migration, jurisdictions, request and duration pricing | 2026-09-18 |
| PostgreSQL semantics: row security policies with `current_setting`, `SET LOCAL` transaction scope, `FOR UPDATE SKIP LOCKED`, partitioned-table unique constraints must include the partition key, session-scoped advisory locks, `LISTEN/NOTIFY` | §4, §5, §9.4 | working knowledge, not re-read in this pass; the M1 conformance suite is the check |
| PGlite | full Postgres compiled to WASM, so RLS and locking semantics are Postgres's | working knowledge; verify RLS + `SKIP LOCKED` in M0 |
| PgBouncer / PlanetScale pooling docs | transaction-mode pooling vs session-scoped advisory locks and `LISTEN` | 2026-09-17 (earlier package research) |
| Rivet Actors docs, `@rivetkit/effect` | per-actor SQLite isolation; typed Effect actions exist there | 2026-09-18 |
| Hewitt, Bishop, Steiger (1973); Agha (1986); Bykov et al., Orleans (2011); Shah & Salles, Reactors (SIGMOD 2018); Li et al., RedBlue (OSDI 2012); O'Neil, escrow (1986) | §12.1, §13.4 | prior reading; cited from memory of the papers' claims, not re-read this week |
| celld (Deno, pre-1.0), Multigres v0.1 alpha, Citus colocation/2PC | rejected or deferred alternatives for distributed DO / sharded Postgres | 2026-09-18 |
| Earlier Rika documents listed under *Supersedes* | prior positions in §11.2 | 2026-09-18 |
