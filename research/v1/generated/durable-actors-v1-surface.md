# Durable Actors — V1 surface, in code

Status: proposal. Everything under `@durable-actors/*` is the API we would build. Everything imported from `effect`, `effect/unstable/*`, `@effect/*` is verified against Effect v4 (`effect-ts/effect@main`, 4.0.0-rc.x) as of this writing.

Decisions baked in: no Turso. One Postgres (SQLite locally, pglite in tests) holds actor rows, cluster messages, events, workflows and jobs. A turn is one database transaction.

---

## 0. The whole thing on one page

```diagram
 what you write                          what runs it
┌──────────────────────────────────┐    ┌──────────────────────────────────────┐
│ Actor.make("Order", {            │    │ Runner.layer({                       │
│   protocol: commands + queries   │    │   actors, activities, jobs,          │
│   events:   durable event types  │    │   workflows, crons, retention })     │
│   tables:   Model rows           │    │   ├ ActorStore.postgres  (turn txn,  │
│   migrations: plain SQL          │    │   │   fence row, actor_events)       │
│ })                               │    │   ├ ClusterRuntime.layer (Effect     │
│                                  │    │   │   Sharding + SqlMessageStorage + │
│ Order.toLayer(handlers,{ init }) │    │   │   ClusterWorkflowEngine)         │
│   ctx: id · ids · events ·       │    │   ├ BlobStore.s3 | .fs | .memory     │
│        schedule · activities ·   │    │   └ PgClient | SqliteClient | pglite │
│        jobs · workflows ·        │    └──────────────────────────────────────┘
│        broadcast                 │
│   services: Database · BlobStore │    one Postgres:
│             Actors · yours       │      actors · <your tables> · actor_events
│                                  │      cluster_messages · cluster_replies
│ Actor.activity / .job /          │      cluster_runners · cluster_locks
│ .workflow / .cron                │      workflow tables · migrations
└──────────────────────────────────┘
```

Rules the runtime enforces, in one line each:

```text
identity     (Order, "order_123") exists whether or not any process is running it
turn         one command → one transaction: state + events + receipt + outgoing intents commit together
delivery     commands at-least-once, deduplicated by key; queries volatile, served from committed state
ownership    exactly one runner may commit for an actor; a stale runner's commit is rejected by the database
external I/O never inside a turn — in activities, jobs, workflows; results come back as commands
```

---

## 1. Define an actor

### Tables and migrations are ordinary SQL

```ts
// orders/Order.tables.ts
import { Effect, Schema } from "effect"
import { Model } from "effect/unstable/schema"
import { Migrator, SqlClient } from "effect/unstable/sql"
import { Database } from "@durable-actors/core"

export class OrderRow extends Model.Class<OrderRow>("OrderRow")({
  actorId: Schema.String,                                   // every actor table leads with actor_id
  status: Schema.Literals(["draft", "placed", "paying", "paid", "cancelled"]),
  customerId: Schema.NullOr(Schema.String),
  totalCents: Schema.Int,
  invoiceKey: Schema.NullOr(Schema.String),                 // BlobStore key, see §7
}) {}

export class OrderItem extends Model.Class<OrderItem>("OrderItem")({
  actorId: Schema.String,
  id: Schema.String,
  sku: Schema.String,
  quantity: Schema.Int,
  priceCents: Schema.Int,
}) {}

export const Orders = Database.table("orders", OrderRow)          // one row per actor
export const OrderItems = Database.table("order_items", OrderItem) // many rows per actor

export const OrderMigrations = Migrator.fromRecord({
  "0001_orders": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE orders (
      actor_id     TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      customer_id  TEXT,
      total_cents  INTEGER NOT NULL,
      invoice_key  TEXT
    )`
    yield* sql`CREATE TABLE order_items (
      actor_id    TEXT NOT NULL,
      id          TEXT NOT NULL,
      sku         TEXT NOT NULL,
      quantity    INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      PRIMARY KEY (actor_id, id)
    )`
  }),
})
```

Migrations run once per deploy against the shared database (`actors migrate` or at runner boot), not lazily per actor. That is a consequence of dropping the database-per-actor design and it removes a whole class of "actor woke with an old schema" bugs.

### Protocol: commands change truth, queries read it

```ts
// orders/Order.protocol.ts
import { Schema } from "effect"
import { Actor } from "@durable-actors/core"

export class OrderNotDraft extends Schema.TaggedError<OrderNotDraft>()(
  "OrderNotDraft", { orderId: Schema.String, status: Schema.String }, { httpApiStatus: 409 },
) {}
export class CannotPay extends Schema.TaggedError<CannotPay>()(
  "CannotPay", { orderId: Schema.String, status: Schema.String }, { httpApiStatus: 409 },
) {}
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()(
  "PaymentDeclined", { code: Schema.String, message: Schema.String },
) {}

export const PaymentReceipt = Schema.Struct({ receiptId: Schema.String, amountCents: Schema.Int })
export const OrderView = Schema.Struct({
  id: Schema.String, status: OrderRow.fields.status, totalCents: Schema.Int, invoiceKey: Schema.NullOr(Schema.String),
})

// commands: persisted, at-least-once, deduplicated by key
export const AddItem = Actor.command("AddItem", {
  input: { sku: Schema.String, quantity: Schema.Int, priceCents: Schema.Int },
  error: OrderNotDraft,
})
export const Place = Actor.command("Place", { input: { customerId: Schema.String }, error: OrderNotDraft })
export const Pay = Actor.command("Pay", { input: { paymentMethodId: Schema.String }, error: CannotPay })
export const CancelIfUnpaid = Actor.command("CancelIfUnpaid")

// completions delivered by the runtime; `key` makes duplicates harmless
export const PaymentCaptured = Actor.command("PaymentCaptured", {
  input: PaymentReceipt, key: (r) => r.receiptId,
})
export const PaymentFailed = Actor.command("PaymentFailed", { input: PaymentDeclined })
export const InvoiceReady = Actor.command("InvoiceReady", { input: { invoiceKey: Schema.String } })

// queries: volatile, served from committed state, never queue behind commands
export const Get = Actor.query("Get", { output: OrderView })
export const Items = Actor.query("Items", { output: Schema.Array(OrderItem) })

export const OrderProtocol = Actor.protocol(
  AddItem, Place, Pay, CancelIfUnpaid, PaymentCaptured, PaymentFailed, InvoiceReady, Get, Items,
)
```

`Actor.command` is `Rpc.make(tag, { payload, success, error, primaryKey })` annotated `ClusterSchema.Persisted` + `WithTransaction`. `Actor.query` is the same `Rpc.make` without persistence. Nothing here is a new schema system.

### Events: the durable journal other things subscribe to

```ts
// orders/Order.events.ts
export const OrderPlaced = Actor.event("OrderPlaced", { totalCents: Schema.Int })
export const OrderPaid = Actor.event("OrderPaid", { receiptId: Schema.String })
export const OrderCancelled = Actor.event("OrderCancelled", { reason: Schema.String })
export const OrderEvents = Actor.events(OrderPlaced, OrderPaid, OrderCancelled)
```

### The actor

```ts
// orders/Order.ts
export const Order = Actor.make("Order", {
  protocol: OrderProtocol,
  events: OrderEvents,
  tables: [Orders, OrderItems],
  migrations: OrderMigrations,
})
```

---

## 2. Implement an actor

```ts
// orders/Order.live.ts
import { Effect } from "effect"
import { Database } from "@durable-actors/core"

export const OrderLive = Order.toLayer({
  AddItem: Effect.fn("Order.AddItem")(function* ({ sku, quantity, priceCents }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "draft") {
      return yield* new OrderNotDraft({ orderId: ctx.id, status: order.status })
    }
    yield* db.insert(OrderItems, { id: yield* ctx.ids.next, sku, quantity, priceCents })
    yield* db.update(Orders, { totalCents: order.totalCents + quantity * priceCents })
  }),

  Place: Effect.fn("Order.Place")(function* ({ customerId }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "draft") {
      return yield* new OrderNotDraft({ orderId: ctx.id, status: order.status })
    }
    yield* db.update(Orders, { status: "placed", customerId })
    yield* ctx.events.emit(OrderPlaced.make({ totalCents: order.totalCents }))
    yield* ctx.schedule.after("30 minutes", CancelIfUnpaid.make())
  }),

  Pay: Effect.fn("Order.Pay")(function* ({ paymentMethodId }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "placed") {
      return yield* new CannotPay({ orderId: ctx.id, status: order.status })
    }
    yield* db.update(Orders, { status: "paying" })
    yield* ctx.activities.start(
      CapturePayment,
      { orderId: ctx.id, paymentMethodId, amountCents: order.totalCents },
      { onSuccess: PaymentCaptured, onFailure: PaymentFailed },
    )
  }),

  PaymentCaptured: Effect.fn("Order.PaymentCaptured")(function* ({ receiptId }, ctx) {
    const db = yield* Database
    yield* db.update(Orders, { status: "paid" })
    yield* ctx.events.emit(OrderPaid.make({ receiptId }))
    yield* ctx.jobs.enqueue(RenderInvoice, { orderId: ctx.id }, { onComplete: InvoiceReady })
  }),

  PaymentFailed: Effect.fn("Order.PaymentFailed")(function* (_declined, ctx) {
    const db = yield* Database
    yield* db.update(Orders, { status: "placed" })          // back to payable; the client sees PaymentFailed via events
    yield* ctx.broadcast(PaymentProblem.make({ orderId: ctx.id }))
  }),

  InvoiceReady: Effect.fn("Order.InvoiceReady")(function* ({ invoiceKey }) {
    const db = yield* Database
    yield* db.update(Orders, { invoiceKey })
  }),

  // timers are ordinary commands with guards; no cancel API in V1
  CancelIfUnpaid: Effect.fn("Order.CancelIfUnpaid")(function* (_, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "placed") return
    yield* db.update(Orders, { status: "cancelled" })
    yield* ctx.events.emit(OrderCancelled.make({ reason: "unpaid" }))
  }),

  Get: Effect.fn("Order.Get")(function* (_, ctx) {
    const db = yield* Database
    const o = yield* db.one(Orders)
    return { id: ctx.id, status: o.status, totalCents: o.totalCents, invoiceKey: o.invoiceKey }
  }),

  Items: Effect.fn("Order.Items")(function* () {
    const db = yield* Database
    return yield* db.many(OrderItems)
  }),
}, {
  // runs once, in the same transaction as the first command this id ever receives
  init: Effect.fn("Order.init")(function* () {
    const db = yield* Database
    yield* db.insert(Orders, { status: "draft", customerId: null, totalCents: 0, invoiceKey: null })
  }),
})
```

### What executes for one command

```diagram
client: order.request(Pay.make({...}), { idempotencyKey })
  │ INSERT cluster_messages (persisted, request_id = key)          ← survives client crash
  ▼
owner runner (Effect Sharding picks it up)
  BEGIN
  ├ SELECT actors WHERE type='Order' AND id='order_123' FOR UPDATE   fence: generation must match this runner's lease
  ├ init if first turn ever
  ├ handler Pay
  │   ├ SELECT/UPDATE orders WHERE actor_id = 'order_123'           via Database (scoped)
  │   └ ctx.activities.start(...) → INSERT cluster_messages          intent: an activity run, not yet started
  ├ INSERT cluster_replies (WithExit)                                receipt: this key is done
  └ UPDATE actors SET turn = turn + 1
  COMMIT                                                             ← the only durable moment
  reply to caller · poke the runner that owns the activity
```

Anything before COMMIT can die and nothing happened. Anything after COMMIT can die and the redelivered message finds the receipt and returns the stored reply. That is the entire correctness story, and it is a Postgres transaction, not a protocol we invented.

### The context and the `Database` service

```ts
interface TurnContext {
  readonly id: string                       // "order_123"
  readonly address: ActorAddress            // { type: "Order", id }
  readonly generation: number               // ownership epoch (fence)
  readonly turn: number                     // 1..n for this actor
  readonly ids: { readonly next: Effect<string> }                       // unique ids (uuid v7)
  readonly events: { emit(e: OrderEvent): Effect<void> }                // durable, in the turn transaction
  broadcast(e: Schema.Top["Type"]): Effect<void>                        // ephemeral, published after commit
  readonly schedule: {
    after(d: Duration.Input, cmd: OrderCommand): Effect<void>           // DeliverAt message, in-transaction
    at(t: DateTime.Utc, cmd: OrderCommand): Effect<void>
  }
  readonly activities: { start(a, input, { onSuccess, onFailure }): Effect<void> }
  readonly jobs:       { enqueue(j, input, { onComplete? }): Effect<void> }
  readonly workflows:  { start(w, input, { onComplete?, onFailure? }): Effect<void> }
}
```

```ts
const db = yield* Database                 // only inside a turn or a query
db.id                                      // this actor's id
db.one(Orders)                             // exactly one row for this actor, else ActorNotFound
db.maybe(Orders)                           // Option
db.many(OrderItems)                        // insertion order
db.insert(OrderItems, row)                 // actor_id injected
db.update(Orders, patch)                   // all rows for this actor (single-row tables)
db.update(OrderItems, patch, { id })       // by key
db.delete(OrderItems, { id })
db.sql`SELECT coalesce(sum(quantity),0) AS n FROM order_items WHERE actor_id = ${db.id}`   // raw Effect SQL, same transaction
```

`Database` is a thin scope over Effect's `SqlClient` bound to the turn's transaction. There is no ORM; `Model.Class` gives you typed rows, `db.sql` gives you everything else.

---

## 3. Call an actor

```ts
import { Actors } from "@durable-actors/core"

const program = Effect.gen(function* () {
  const actors = yield* Actors
  const order = yield* actors.get(Order, "order_123")    // ActorRef, no I/O, id may never have existed

  // request: durable submit + wait for the authoritative result. Typed errors flow through.
  yield* order.request(AddItem.make({ sku: "shirt-blue", quantity: 2, priceCents: 2900 }))
  yield* order.request(Place.make({ customerId: "cust_9" }))

  // submit: durable, returns as soon as the message is stored; await later (or never)
  const accepted = yield* order.submit(Pay.make({ paymentMethodId: "pm_123" }), { idempotencyKey: "req_7f2" })
  yield* accepted.await                                                          // Effect<void, CannotPay>

  // send: durable fire-and-forget
  yield* order.send(CancelIfUnpaid.make())

  // query: from committed state, served on the caller's runner — never queued behind the owner
  const view = yield* order.query(Get)                                           // Effect<OrderView>
  const items = yield* order.query(Items)

  // events: durable journal, replay from a cursor then live
  yield* order.events({ after: 0 }).pipe(
    Stream.take(3),
    Stream.runForEach((e) => Effect.log(e.seq, e.event._tag)),
  )
})
```

Contracts we publish (not "eventually", in V1):

```text
request/submit/send   at-least-once delivery; deduplicated by idempotencyKey (or the command's key); reply cached
ordering              commands from one caller to one actor are processed in submission order
                      across callers: no order guarantee beyond "one at a time"
admission             mailbox full → typed ActorBusy error to the caller, never silent drop
queries               read committed state; a query issued after a request that completed sees its effects
turn rules            handlers must be re-executable: database writes + ctx intents only. External I/O belongs
                      in activities/jobs/workflows. This rule is what keeps the door open for concurrent turns later.
no waiting            a turn never awaits external work. ctx.activities.start / ctx.jobs.enqueue / ctx.workflows.start
                      return once the intent is recorded. Need the value before continuing? That is a workflow (§7), not a turn.
```

### Cross-actor calls go through protocols, never repositories

```ts
Place: Effect.fn("Order.Place")(function* ({ customerId }, ctx) {
  const db = yield* Database
  const actors = yield* Actors
  const items = yield* db.many(OrderItems)

  for (const item of items) {
    const inventory = yield* actors.get(Inventory, `sku:${item.sku}`)
    // request inside a turn is allowed but it is a remote call: keep it short, or use send + a completion command
    yield* inventory.request(Reserve.make({ orderId: ctx.id, quantity: item.quantity }))
  }
  // ...
}),
```

For anything that may take time or fail slowly, use `inventory.send(Reserve…)` and let `Inventory` reply with `Reserved`/`OutOfStock` commands. The reservation then rides the same at-least-once + key machinery as everything else.

---

## 4. Time: timers and cron

```ts
// inside a turn — both are INSERTs in the turn transaction, the actor may passivate immediately after
yield* ctx.schedule.after("30 minutes", CancelIfUnpaid.make())
yield* ctx.schedule.at(order.expiresAt, Expire.make())
```

```ts
// crons are cluster singletons: one delivery per tick, even with 40 runners
import { Cron, DateTime, Effect } from "effect"

export const NightlyReconcile = Actor.cron("NightlyReconcile", {
  cron: Cron.unsafeParse("0 3 * * *"),
  execute: Effect.gen(function* () {
    const actors = yield* Actors
    const ledger = yield* actors.get(Ledger, "global")
    yield* ledger.send(Reconcile.make({ day: yield* DateTime.now }))
  }),
})
```

`schedule.*` is a `DeliverAt` persisted message, generated for any command so you never hand-write the `DeliverAt`/`PrimaryKey` payload class. `Actor.cron` is an alias: it is `ClusterCron.make`, registered by `Runner.layer` with `pool` mapped to `shardGroup`, and nothing more. Both are served by the runtime's poller, so timer resolution is seconds, not milliseconds, and we say so.

---

## 5. Activities: one unit of external work whose result the actor needs

```ts
// payments/CapturePayment.ts
import { Effect, Schedule, Schema } from "effect"

export const CapturePayment = Actor.activity("CapturePayment", {
  input: { orderId: Schema.String, paymentMethodId: Schema.String, amountCents: Schema.Int },
  output: PaymentReceipt,
  error: PaymentDeclined,                                     // typed, final: delivered to onFailure
  retry: { schedule: Schedule.exponential("1 second"), maxAttempts: 5 },   // for defects/transient failures
  execute: Effect.fn("CapturePayment")(function* ({ paymentMethodId, amountCents }, run) {
    const stripe = yield* Stripe                              // your Effect service, provided by a Layer
    return yield* stripe.capture({
      paymentMethodId,
      amountCents,
      idempotencyKey: run.key,                                // stable across retries and replays: "Order/order_123/turn/5/CapturePayment"
    })
  }),
})
```

```diagram
turn 5 (Pay)      COMMIT includes: INSERT cluster_messages → workflow "ActorActivity" run { key, activity, input, reply-to }
                                     │
workflow runner   Activity.make({ name: run.key, execute })      Effect Workflow memoizes the result per key
                    │  crash before result recorded → re-run; Stripe dedups on run.key
                    ▼
                  Persisted command to Order/order_123: PaymentCaptured{ receiptId } (message key = run.key)
                                     │
turn 6            handler PaymentCaptured … COMMIT             duplicates find the receipt → no second turn
```

What we promise: the activity runs at least once; the actor sees exactly one completion per activity start. What we do not promise: the external system saw exactly one call. `run.key` is how you make that true on their side.

---

## 6. Jobs: background work that is not anyone's truth

```ts
// invoices/RenderInvoice.ts
import { BlobStore } from "@durable-actors/core"

export const RenderInvoice = Actor.job("RenderInvoice", {
  input: { orderId: Schema.String },
  output: { invoiceKey: Schema.String },
  pool: "media",                                               // which runner role executes it (§14); default "default"
  concurrency: 4,                                              // per runner
  rateLimit: { limit: 60, window: "1 minute" },                // cluster-wide, best effort
  retry: { schedule: Schedule.exponential("2 seconds"), maxAttempts: 3 },
  execute: Effect.fn("RenderInvoice")(function* ({ orderId }) {
    const actors = yield* Actors
    const blobs = yield* BlobStore
    const order = yield* actors.get(Order, orderId)
    const view = yield* order.query(Get)
    const items = yield* order.query(Items)
    const pdf = yield* InvoicePdf.render(view, items)
    const blob = yield* blobs.put(`orders/${orderId}/invoice.pdf`, pdf, { contentType: "application/pdf" })
    return { invoiceKey: blob.key }                            // deterministic key → retries overwrite, no orphans
  }),
})
```

```ts
// from a turn: completion comes back to this actor as a command
yield* ctx.jobs.enqueue(RenderInvoice, { orderId: ctx.id }, { onComplete: InvoiceReady })

// from anywhere that is not a turn (HTTP handler, cron, script, another job)
const jobs = yield* Jobs
yield* jobs.enqueue(RenderInvoice, { orderId })                                // durable fire-and-forget
const { invoiceKey } = yield* jobs.run(RenderInvoice, { orderId })             // enqueue + await; executes on the "media" pool
```

When to use which:

```text
activity   the actor is waiting for this exact result to decide what is true next   (payment capture, model call)
job        someone wants this done, with limits and retries; the actor may or may not care  (render PDF, resize, send email)
workflow   several steps, sleeps, or waits that must survive crashes as one procedure (§7)
effect     stateless, fast, nobody needs it to survive a crash (hash, validate, resize in-process) — no framework at all
```

Same engine underneath (Effect Workflow + `ClusterWorkflowEngine`), different ownership: an activity belongs to a turn, a job belongs to a queue. `Actor.job` is named under `Actor` for one import and one mental model; no actor instance owns a job.

Rules that keep ownership intact:

```text
jobs and activities never touch actor tables   read with query, change with commands
jobs.run is not hot-path RPC                    it rides cluster_messages: sub-second with the post-commit runner poke,
                                                10 s worst case without it. Use it for "render and return".
no ctx.jobs.run                                 inside a turn there is only enqueue/start; awaiting there would hold the
                                                actor's row lock and transaction across an HTTP call (§3, "no waiting")
```

---

## 7. Workflows: multi-step procedures that survive crashes

```ts
// domains/ProvisionDomain.ts
import { Activity, DurableClock } from "effect/unstable/workflow"

export const ProvisionDomain = Actor.workflow("ProvisionDomain", {
  input: { projectId: Schema.String, domain: Schema.String },
  output: { certificateId: Schema.String },
  error: ProvisionFailed,
  run: Effect.fn("ProvisionDomain")(function* ({ projectId, domain }, wf) {
    const record = yield* wf.step(CreateDnsRecord, { domain })                  // ours: reusable, parameterized activity

    yield* DurableClock.sleep({ name: "propagation", duration: "2 minutes" })    // Effect, used directly: no process stays up

    yield* wf.step(VerifyDns, { domain }, {
      retry: { schedule: Schedule.spaced("1 minute"), maxAttempts: 30 },
    })

    const cert = yield* Activity.make({                                          // Effect, used directly: an inline one-off step
      name: "issueCertificate",
      success: Certificate,
      execute: Effect.flatMap(Acme, (acme) => acme.issue({ domain, recordId: record.id })),
    })

    yield* wf.send(Project, projectId, DomainReady.make({ domain, certificateId: cert.id }))   // ours: replay-safe persisted send
    return { certificateId: cert.id }
  }),
})
```

Waiting on the outside world (human approval, webhook) is Effect's `DurableDeferred`, unwrapped:

```ts
import { DurableDeferred } from "effect/unstable/workflow"

const Approval = DurableDeferred.make("approval", { success: ApprovalDecision })

export const RefundWithApproval = Actor.workflow("RefundWithApproval", {
  input: { orderId: Schema.String, amountCents: Schema.Int },
  output: Schema.Literals(["refunded", "rejected"]),
  run: Effect.fn("RefundWithApproval")(function* ({ orderId, amountCents }, wf) {
    const token = yield* DurableDeferred.token(Approval)                          // durable + serializable: safe inside a command
    yield* wf.send(Approvals, "finance", RequestApproval.make({ orderId, amountCents, token }))

    const outcome = yield* DurableDeferred.await(Approval)                        // suspends here; zero compute while waiting
    if (outcome._tag === "Rejected") return "rejected"

    yield* wf.step(RefundPayment, { orderId, amountCents })
    return "refunded"
  }),
})

// somewhere else, days later (HTTP handler, Slack bot, CLI). WorkflowEngine is provided by ClusterRuntime.layer:
yield* DurableDeferred.succeed(Approval, { token, value: ApprovalDecision.Approved({ by: "dallen" }) })
```

Start a workflow from a turn or from anywhere:

```ts
yield* ctx.workflows.start(ProvisionDomain, { projectId: ctx.id, domain }, {
  onComplete: DomainProvisioned,
  onFailure: DomainFailed,
})

const run = yield* workflows.start(ProvisionDomain, { projectId, domain })   // outside an actor
yield* run.await
```

The `wf` handle has exactly two members, both things Effect lacks: `wf.step(activity, input, options?)` runs one of our reusable parameterized activities (Effect's `Activity` has no input schema, it closes over the workflow payload), and `wf.send(actor, id, command)` is a persisted send wrapped in an activity so replay never re-sends. Everything else in a body is Effect used directly: `Activity.make` for an inline step, `DurableClock.sleep`, `DurableDeferred`, and the Effect docs apply unchanged. `Actor.workflow` itself adds only registration, `pool`, and `onComplete`/`onFailure` routing to an actor, which Effect stores only as the workflow's own reply. Workflows own no truth: they compute and then tell actors what happened.

---

## 8. BlobStore: bytes next to truth, with references in the truth

```ts
const blobs = yield* BlobStore

const blob = yield* blobs.put("orders/order_123/invoice.pdf", bytes, { contentType: "application/pdf" })
// BlobRef { key, etag, size, contentType }

const stream = blobs.get(blob.key)                                   // Stream<Uint8Array>
const url = yield* blobs.presign(blob.key, { expiresIn: "15 minutes" })   // for browsers
yield* blobs.delete(blob.key)
```

Semantics, stated plainly:

```text
blobs are not transactional           the row referencing a key is; write the blob first, commit the reference second
deterministic keys                    retries overwrite the same object instead of leaking new ones
where to write                        jobs/activities/HTTP handlers (external I/O). Inside a turn it works but blocks the turn.
backends                              BlobStore.s3 (S3, R2, MinIO) · BlobStore.fs (dev) · BlobStore.memory (tests)
inspect/purge                         `actors purge Order/order_123` deletes rows, events, and any keys under Order/order_123/
```

Upload pattern:

```ts
// HTTP handler: store bytes, then hand the actor a reference
upload: ({ params, payload }) => Effect.gen(function* () {
  const blob = yield* blobs.put(`documents/${params.docId}/v${payload.version}.md`, payload.body)
  const doc = yield* actors.get(Document, params.docId)
  yield* doc.request(AttachRevision.make({ version: payload.version, key: blob.key, etag: blob.etag }))
}),
```

---

## 9. Events and realtime

Two different things with two different names:

```text
ctx.events.emit(e)   durable · ordered per actor · committed with the turn · replayable from a cursor
ctx.broadcast(e)     ephemeral · after commit · best effort · for cursors, typing, progress ticks
```

```ts
// consumer with resume: replay from the journal, then tail live
const order = yield* actors.get(Order, "order_123")
yield* order.events({ after: lastSeenSeq }).pipe(
  Stream.runForEach((committed) => Effect.log(committed.seq, committed.turn, committed.event)),
)

// ephemeral
yield* order.live.pipe(Stream.runForEach(Effect.log))
```

Over HTTP:

```ts
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { ActorHttp } from "@durable-actors/core"

const EventRoutes = HttpRouter.use((router) =>
  router.add("GET", "/orders/:id/events", Effect.gen(function* () {
    const { id } = yield* HttpRouter.params
    const req = yield* HttpServerRequest.HttpServerRequest
    const after = Number(req.headers["last-event-id"] ?? 0)
    const order = yield* actors.get(Order, id)
    return yield* ActorHttp.sse(order.events({ after }))        // Server-Sent Events with seq as event id → browser resumes for free
  })),
)
```

```diagram
turn N COMMIT ─ INSERT actor_events(seq=N.k) ─┐
                                              ▼
owner runner PubSub ──▶ local subscribers
       ▲
       │ stream RPC "Subscribe(after)"      (Cluster stream rpc; replays rows > after, then tails)
other runner ──▶ SSE / WebSocket / CLI ──▶ browser
```

---

## 10. Transports are adapters over the same protocol

### HTTP via Effect HttpApi

```ts
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { BunHttpServer } from "@effect/platform-bun"

export class OrdersApi extends HttpApiGroup.make("orders")
  .add(HttpApiEndpoint.get("get", "/:orderId", { params: { orderId: Schema.String }, success: OrderView }))
  .add(HttpApiEndpoint.post("addItem", "/:orderId/items", {
    params: { orderId: Schema.String }, payload: AddItem.input, success: Schema.Void, error: OrderNotDraft,
  }))
  .add(HttpApiEndpoint.post("pay", "/:orderId/pay", {
    params: { orderId: Schema.String }, payload: Pay.input, success: Schema.Void, error: CannotPay,   // → 409 from the annotation
  }))
  .prefix("/orders") {}

export class ShopApi extends HttpApi.make("shop").add(OrdersApi) {}

export const OrdersApiLive = HttpApiBuilder.group(ShopApi, "orders", Effect.fn(function* (handlers) {
  const actors = yield* Actors
  return handlers.handleAll({
    get: ({ params }) => Effect.flatMap(actors.get(Order, params.orderId), (o) => o.query(Get)),
    addItem: ({ params, payload }) => Effect.flatMap(actors.get(Order, params.orderId), (o) => o.request(AddItem.make(payload))),
    pay: ({ params, payload, headers }) =>
      Effect.flatMap(actors.get(Order, params.orderId), (o) =>
        o.request(Pay.make(payload), { idempotencyKey: headers["idempotency-key"] })),
  })
}))

export const ShopHttp = HttpRouter.serve(
  HttpApiBuilder.layer(ShopApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide(OrdersApiLive)),
).pipe(Layer.provide(BunHttpServer.layer({ port: 3000 })))
```

No controller, service, repository, or queue layer. The typed error from the handler becomes the HTTP status; the same `OrderNotDraft` shows up in OpenAPI.

### Typed RPC for browsers and other services

```ts
// server: one line exposes chosen actors over Effect RPC (WebSocket or HTTP)
export const ActorRpcLive = ActorRpc.layer([Order, Project], { path: "/rpc" })

// browser / other service: same protocol objects, same errors
const client = yield* ActorRpc.client(Order, { url: "wss://api.example.com/rpc" })
const order = client.get("order_123")
yield* order.request(Pay.make({ paymentMethodId }))
```

Built on `EntityProxyServer`/`RpcServer` from Effect Cluster; we only pick the message shape.

### CLI

Application CLIs are ordinary `effect/unstable/cli` programs that `yield* Actors`. The framework ships one ops CLI:

```text
actors migrate                              apply pending migrations for all registered actors
actors inspect Order/order_123              timeline, pending timers, in-flight activities/jobs/workflows
actors send Order/order_123 CancelIfUnpaid  deliver a command from the terminal
actors replay Order/order_123 --to 5        rebuild a scratch copy of the actor by re-running turns 1..5 (debug)
actors purge Order/order_123                rows + events + blobs, one transaction plus a blob sweep
actors retention --older-than 30d           prune processed messages/replies (Cluster never does this itself)
```

---

## 11. An agent is an actor plus a workflow

```ts
// assistant/Assistant.ts
export const Ask = Actor.command("Ask", { input: { text: Schema.String }, output: { runId: Schema.String } })
export const Answered = Actor.command("Answered", { input: { runId: Schema.String, text: Schema.String }, key: (a) => a.runId })
export const ToolObserved = Actor.command("ToolObserved", { input: { runId: Schema.String, call: ToolCall, result: Schema.String } })
export const Transcript = Actor.query("Transcript", { output: Schema.Array(Message) })

export const Assistant = Actor.make("Assistant", {
  protocol: Actor.protocol(Ask, Answered, ToolObserved, Transcript),
  events: Actor.events(MessageAdded),
  tables: [Messages],
  migrations: AssistantMigrations,
})

export const AssistantLive = Assistant.toLayer({
  Ask: Effect.fn("Assistant.Ask")(function* ({ text }, ctx) {
    const db = yield* Database
    const runId = yield* ctx.ids.next
    yield* db.insert(Messages, { id: yield* ctx.ids.next, role: "user", content: text })
    yield* ctx.events.emit(MessageAdded.make({ role: "user", content: text }))
    yield* ctx.workflows.start(AgentRun, { assistantId: ctx.id, runId }, { onComplete: Answered })
    return { runId }
  }),
  ToolObserved: Effect.fn("Assistant.ToolObserved")(function* ({ call, result }) {
    const db = yield* Database
    yield* db.insert(Messages, { id: yield* db.ids.next, role: "tool", content: JSON.stringify({ call, result }) })
  }),
  Answered: Effect.fn("Assistant.Answered")(function* ({ text }, ctx) {
    const db = yield* Database
    yield* db.insert(Messages, { id: yield* ctx.ids.next, role: "assistant", content: text })
    yield* ctx.events.emit(MessageAdded.make({ role: "assistant", content: text }))
  }),
  Transcript: Effect.fn("Assistant.Transcript")(function* () {
    const db = yield* Database
    return yield* db.many(Messages)
  }),
})
```

```ts
// assistant/AgentRun.ts
import { LanguageModel, Prompt } from "effect/unstable/ai"

const ModelTurn = Actor.activity("ModelTurn", {
  input: { assistantId: Schema.String, step: Schema.Int },
  output: TurnOutcome,                                          // Answer{ text } | ToolCalls{ calls }
  execute: Effect.fn("ModelTurn")(function* ({ assistantId }) {
    const actors = yield* Actors
    const history = yield* Effect.flatMap(actors.get(Assistant, assistantId), (a) => a.query(Transcript))
    const response = yield* LanguageModel.generateText({ prompt: toPrompt(history), toolkit: CodingTools })
    return response.toolCalls.length > 0
      ? TurnOutcome.ToolCalls({ calls: response.toolCalls })
      : TurnOutcome.Answer({ text: response.text })
  }),
})

export const AgentRun = Actor.workflow("AgentRun", {
  input: { assistantId: Schema.String, runId: Schema.String },
  output: { runId: Schema.String, text: Schema.String },
  error: RunExhausted,
  run: Effect.fn("AgentRun")(function* ({ assistantId, runId }, wf) {
    for (let step = 0; step < 16; step++) {
      const turn = yield* wf.step(ModelTurn, { assistantId, step })          // memoized: a crash never re-bills the model call
      if (turn._tag === "Answer") return { runId, text: turn.text }
      for (const call of turn.calls) {
        const result = yield* wf.step(RunTool, { call })                      // shell, browser, HTTP: external, retried, keyed
        yield* wf.send(Assistant, assistantId, ToolObserved.make({ runId, call, result }))
      }
    }
    return yield* new RunExhausted({ runId })
  }),
})
```

The assistant is a thing with a transcript that sleeps between turns and wakes wherever. The run is a procedure that survives crashes. Neither needs a new runtime.

---

## 12. Testing: the part nobody else has

```ts
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ActorsTest, Faults } from "@durable-actors/testing"

const StripeFake = Layer.effect(Stripe, StripeFake.make())      // your own fake, ordinary Effect Layer

const TestEnv = ActorsTest.layer({
  actors: [OrderLive],
  activities: [CapturePayment],
  jobs: [RenderInvoice],
}).pipe(Layer.provide(StripeFake), Layer.provide(BlobStore.memory))
// pglite database, in-memory cluster (TestRunner), in-memory WorkflowEngine, TestClock-driven timers

const placed = Effect.fn(function* (id: string) {
  const actors = yield* Actors
  const order = yield* actors.get(Order, id)
  yield* order.request(AddItem.make({ sku: "shirt", quantity: 2, priceCents: 2900 }))
  yield* order.request(Place.make({ customerId: "c1" }))
  return order
})

it.layer(TestEnv)("Order", (it) => {

  it.effect("cancels if unpaid after 30 minutes, not before", () => Effect.gen(function* () {
    const order = yield* placed("o1")
    yield* TestClock.adjust("29 minutes")
    yield* ActorsTest.settle                                     // run everything that is due: timers, mailboxes, activities
    assert.strictEqual((yield* order.query(Get)).status, "placed")
    yield* TestClock.adjust("1 minute")
    yield* ActorsTest.settle
    assert.strictEqual((yield* order.query(Get)).status, "cancelled")
  }))

  it.effect("crash after commit, before reply: retry returns the stored result, Stripe is charged once", () => Effect.gen(function* () {
    const stripe = yield* Stripe
    const order = yield* placed("o2")
    yield* Faults.crashOnce("turn.afterCommit", { actor: Order, command: Pay })

    const first = yield* order.request(Pay.make({ paymentMethodId: "pm" }), { idempotencyKey: "k1" }).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(first))                         // the caller saw a transport failure...
    yield* order.request(Pay.make({ paymentMethodId: "pm" }), { idempotencyKey: "k1" })   // ...and retried with the same key
    yield* ActorsTest.settle

    assert.strictEqual((yield* stripe.captures).length, 1)
    assert.strictEqual((yield* order.query(Get)).status, "paid")
    assert.deepStrictEqual((yield* ActorsTest.turns(Order, "o2")).map((t) => t.command), ["AddItem", "Place", "Pay", "PaymentCaptured", "InvoiceReady"])
  }))

  it.effect("crash before commit: nothing happened", () => Effect.gen(function* () {
    const order = yield* placed("o3")
    yield* Faults.crashOnce("turn.beforeCommit", { actor: Order, command: Pay })
    yield* order.request(Pay.make({ paymentMethodId: "pm" })).pipe(Effect.exit)
    yield* ActorsTest.settle
    assert.strictEqual((yield* order.query(Get)).status, "paid")   // redelivered → ran again → paid; no intermediate "paying" leaked
    assert.strictEqual((yield* ActorsTest.events(Order, "o3")).filter((e) => e._tag === "OrderPaid").length, 1)
  }))

  it.effect("activity effect done, result lost: re-run is idempotent at Stripe, actor sees one completion", () => Effect.gen(function* () {
    const stripe = yield* Stripe
    const order = yield* placed("o4")
    yield* Faults.crashOnce("activity.afterEffect", { activity: CapturePayment })
    yield* order.request(Pay.make({ paymentMethodId: "pm" }))
    yield* ActorsTest.settle
    assert.strictEqual((yield* stripe.calls).length, 2)          // Stripe was called twice...
    assert.strictEqual((yield* stripe.captures).length, 1)       // ...and deduplicated on run.key
    assert.strictEqual((yield* ActorsTest.events(Order, "o4")).filter((e) => e._tag === "OrderPaid").length, 1)
  }))

  it.effect("a stale runner cannot commit", () => Effect.gen(function* () {
    const cluster = yield* ActorsTest.cluster({ runners: 2 })
    const order = yield* placed("o5")
    const paused = yield* Faults.pauseAt("turn.beforeCommit", { actor: Order, command: AddItem })
    const inflight = yield* order.request(AddItem.make({ sku: "hat", quantity: 1, priceCents: 1000 })).pipe(Effect.fork)
    yield* paused.reached
    yield* cluster.moveOwnership(Order, "o5", { to: "runner-2" })             // generation 1 → 2
    yield* paused.resume
    const exit = yield* Fiber.join(inflight).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(exit))                                         // StaleGeneration, rejected by the fence row
    assert.strictEqual((yield* order.query(Items)).length, 1)                   // only the original item
  }))

  it.effect.prop("total always equals the sum of items", [Arbitrary.array(CommandArb)], ([commands]) =>
    Effect.gen(function* () {
      const actors = yield* Actors
      const order = yield* actors.get(Order, "prop")
      for (const c of commands) yield* order.request(c).pipe(Effect.ignore)       // typed errors are legal outcomes
      const view = yield* order.query(Get)
      const items = yield* order.query(Items)
      assert.strictEqual(view.totalCents, items.reduce((n, i) => n + i.quantity * i.priceCents, 0))
    }))
})
```

Fault points the runtime exposes (each is a real place a process can die, made nameable):

```text
turn.beforeCommit        handler finished, transaction not committed
turn.afterCommit         committed, reply not sent
reply.beforeSend         reply row written, transport not used
activity.afterEffect     external call returned, result not recorded
job.afterEffect          same, for jobs
workflow.step.afterEffect
timer.afterFire          DeliverAt message picked up, not yet processed
```

This is the test surface Rivet, Durable Objects, Restate, Inngest do not give you in-process; Temporal gives time-skipping but not named crash points against your own database.

---

## 13. Inspect: the timeline is plain SQL

```text
$ actors inspect Order/order_123

Order/order_123    generation 3    turns 7    owner runner-2a    idle since 14:02:11
turn  at        command           key           result           effects
1     13:58:02  init · AddItem    req_a1        ok               +1 order_items · total 5800
2     13:58:07  AddItem           req_a2        ok               +1 order_items · total 7800
3     13:58:31  Place             req_p0        ok               event OrderPlaced · timer CancelIfUnpaid @14:28:31
4     13:59:10  AddItem           req_a3        OrderNotDraft    —
5     14:01:40  Pay               req_p1        ok               activity CapturePayment#5 started
6     14:01:43  PaymentCaptured   act:…/5       ok               event OrderPaid · job RenderInvoice#6 enqueued
7     14:01:49  InvoiceReady      job:…/6       ok               invoice_key = orders/order_123/invoice.pdf

pending  timer CancelIfUnpaid due 14:28:31   (guard: status=paid → will no-op)
```

Same data in code, so tests assert on it:

```ts
const timeline = yield* ActorsTest.turns(Order, "order_123")
```

Nothing here needs a Rika service. It is `SELECT … FROM actors, cluster_messages, cluster_replies, actor_events`. The hosted Console (§16) is this view with history, alerts and cross-actor search.

---

## 14. Run it: one file, two environments

```ts
// apps/runner/main.ts
import { Config, Layer } from "effect"
import { BunRuntime } from "@effect/platform-bun"
import { PgClient } from "@effect/sql-pg"
import { ActorStore, BlobStore, ClusterRuntime, Runner } from "@durable-actors/core"

const App = Runner.layer({
  actors: [OrderLive, InventoryLive, ProjectLive, AssistantLive],
  activities: [CapturePayment, CreateDnsRecord, VerifyDns, IssueCertificate, ModelTurn, RunTool],
  jobs: [RenderInvoice],
  workflows: [ProvisionDomain, RefundWithApproval, AgentRun],
  crons: [NightlyReconcile],
  retention: "30 days",                                         // prune processed messages/replies; Effect Cluster never does
})

const Main = App.pipe(
  Layer.provide(ShopHttp),
  Layer.provide(ActorRpcLive),
  Layer.provide(ActorStore.postgres),                           // fence row, actor_events, WithTransaction turns
  Layer.provide(ClusterRuntime.layer),                          // Sharding + SqlMessageStorage + SqlRunnerStorage + ClusterWorkflowEngine over the same SqlClient
  Layer.provide(BlobStore.s3({ bucket: Config.String("BLOB_BUCKET") })),
  Layer.provide(PgClient.layerConfig({
    url: Config.Redacted("DATABASE_URL"),
    maxConnections: Config.Int("PG_POOL").pipe(Config.withDefault(20)),
  })),
  Layer.provide(StripeLive),
  Layer.provide(AnthropicLive),
)

BunRuntime.runMain(Layer.launch(Main))
```

```ts
// local dev / CI: same App, SQLite file, filesystem blobs, single in-process runner, real clock
BunRuntime.runMain(Layer.launch(Runner.dev(App, { database: ".data/dev.sqlite", blobs: ".data/blobs" })))
```

### Runner roles: actors and workers are the same code on different machines

A turn holds a row lock for milliseconds; a PDF render holds 400 MB for seconds; an agent's shell command should not be able to take anything down. Jobs, activities and workflows declare a `pool`; a runner serves the pools it lists. `Runner.dev` serves everything.

```ts
// apps/actors/main.ts — latency-sensitive, many resident actors, small footprint, HTTP in front
export const ActorRunners = Runner.layer({
  actors: [OrderLive, InventoryLive, ProjectLive, AssistantLive],
  crons: [NightlyReconcile],
  pools: ["actors"],
})

// apps/workers/main.ts — throughput, big memory, scales independently, may scale to zero, can crash without touching a turn
export const Workers = Runner.layer({
  activities: [CapturePayment, CreateDnsRecord, VerifyDns, IssueCertificate, ModelTurn, RunTool],
  jobs: [RenderInvoice],
  workflows: [ProvisionDomain, RefundWithApproval, AgentRun],
  pools: ["default", "media"],
})
```

```diagram
                 your Postgres (actors · your tables · actor_events · cluster_* · workflow_*)   + S3-compatible bucket
                 ┌──────────────┬───────────────────┬────────────────────┐
                 ▼              ▼                   ▼                    ▼
        ┌─────────────┐  ┌─────────────┐   ┌────────────────┐   ┌────────────────┐
        │ actors ×N   │  │ actors ×N   │   │ workers        │   │ workers "gpu"  │
        │ 512 MB      │  │ 512 MB      │   │ "default,media"│   │ ×K, may be 0   │
        │ HTTP + turns│  │ HTTP + turns│   │ 4 GB, ×M       │   │                │
        └─────────────┘  └─────────────┘   └────────────────┘   └────────────────┘
        Sharding assigns actor ids to actor runners; leases in cluster_locks.
        A render on a worker never blocks a turn on an actor runner.
```

`pool` maps onto Effect Cluster shard groups (`ClusterSchema.ShardGroup`; `ClusterCron` already takes `shardGroup`); runners register the groups they serve. The mapping is a config knob on the existing engine, not a new engine — to be verified in implementation. This is also the whole of the "hosted functions" idea: a worker is a runner with no actors registered, and Rika Cloud can meter worker pools per execution-second without any new primitive.

Scale-out limit we state honestly: one primary Postgres. Sharding actor types across databases (`ActorStore.postgres({ shards })`) is a V2 provider change, not a programming-model change.

---

## 15. Same ten steps, six systems

| step | Durable Actors | Rivet Actors | Cloudflare DO | Restate | Temporal | Inngest / Trigger.dev |
|---|---|---|---|---|---|---|
| define a durable thing | `Actor.make` + Model tables | `actor({ state })` per-actor SQLite | class + `ctx.storage` KV/SQLite | virtual object + K/V | workflow (not an entity) | none (functions) |
| where truth lives | **your Postgres**, relational, joinable | per-actor SQLite in Rivet engine | Cloudflare | Restate log | Temporal history | vendor |
| cross-entity SQL | `SELECT … JOIN` on the same DB | no | no | no | no | no |
| a turn | one DB transaction incl. events, timers, intents | handler + state save | handler + storage txn | journaled handler | n/a | n/a |
| typed errors → HTTP | `Schema.TaggedError` → 409 via HttpApi | partial | manual | partial | manual | manual |
| timers | `ctx.schedule` | `c.schedule` | alarms (one per object) | `ctx.sleep` | timers | `step.sleep` |
| external work | activities w/ stable key → command | inside handler | inside handler | side-effect journaling | activities | steps |
| multi-step procedure | `Actor.workflow` (Effect Workflow) | no | manual | yes | yes | yes |
| queue with limits | `Actor.job` | no | queues (separate product) | no | task queues | yes |
| blobs | `BlobStore` refs in rows | no | R2 (separate) | no | no | no |
| realtime | `events()` journal + SSE, `broadcast` | `broadcast` | WebSockets | no | no | no |
| tests: time + named crash points | `TestClock` + `Faults` in vitest | time in dev server | miniflare | mock runtime | time-skipping | local dev server |
| inspect one entity | `actors inspect` / SQL | Rivet UI | limited | Restate UI | Temporal UI | vendor UI |
| what you operate | your Postgres + N stateless runners | Rivet engine | Cloudflare | Restate server | Temporal cluster | vendor |

Competitor rows are from public documentation as of mid-2026; treat them as approximate. The two cells no one else has: truth in a customer-owned relational database with cross-actor SQL, and in-process crash-point tests against that same database.

---

## 16. Why this is worth building (and how it earns)

```text
developer                 "an Order is a thing with a table, a protocol, a timeline — and I can test the crash."
buyer                     "our state is in our Postgres; the framework is MIT; the console is optional."
Rika (Layer 2: Console)   hosted timeline / search / alerts / replay across environments, reading the customer's DB
Rika (Layer 3: Cloud)     managed runners + managed Postgres + blob store; later "Isolated" tier with a dedicated DB per actor for regulated tenants
```

The open-source framework is the funnel; the Console sells to teams that already trust the model; Cloud sells to teams that do not want to run runners. None of the three requires the customer to move their data out of Postgres, which is the objection that kills Durable Objects and Rivet in most enterprise conversations.

---

## 17. Explicitly not in V1

```text
concurrent turns on one actor            serialized; the turn-rules above keep the migration path open (SERIALIZABLE + retry later)
semantic state types                     Actor.counter/amount/set — after concurrent turns exist
regional write authority / escrow        research
read replicas as a feature               queries already run off the owner; replica routing is a provider option later
timer cancellation                       use guards; add cancel(handle) when the demand is real
projections / CDC                        cross-actor SQL is just SQL now; CDC to another store is a V2 relay
database per actor                       gone as a default; returns as the Cloud "Isolated" tier
actor branching / forking                research
multi-database sharding                  ActorStore provider change, V2
"functions" as a primitive               no; Actor.job + pools is the primitive. Managed worker pools are a Cloud line item.
hybrid Rika compute + your Postgres      never: Rika workers would need your DB credentials and cluster membership
sandboxed execution pool                 later, as Sandbox: Actor.activity("RunShell", { pool: "sandbox" }) — same API, isolated runtime
```

---

## 18. Package shape

```text
@durable-actors/core        Actor · Actors · Database · BlobStore · Jobs · Workflows · Runner · ActorHttp · ActorRpc
@durable-actors/postgres    ActorStore.postgres · BlobStore.s3 helpers · retention job
@durable-actors/testing     ActorsTest · Faults
@durable-actors/cli         actors migrate/inspect/send/replay/purge/retention
```

Everything else (`Schema`, `Layer`, `Config`, `HttpApi`, `Rpc`, `Cluster`, `Workflow`, `Sql`, `Migrator`, `TestClock`, `LanguageModel`) is Effect, used directly.

Naming rule: `Actor.*` is the one namespace for the whole model — `Actor.make`, `Actor.command`, `Actor.query`, `Actor.event`, `Actor.activity`, `Actor.job`, `Actor.workflow`, `Actor.cron`. Jobs, workflows, activities and crons are not owned by an actor instance; they live under `Actor` because one import and one mental model beat a taxonomically pure split. Lowercase constructors match `Actor.make` and Effect's `Rpc.make`/`Entity.make`.

Wrap rule: we wrap an Effect API only when the wrapper must run inside the turn transaction, be keyed by actor identity, or route its result back to an actor. Otherwise users call Effect directly, which is why `Activity.make`, `DurableClock`, `DurableDeferred`, `ClusterCron`, `SqlClient`, `TestClock` and `LanguageModel` all appear unwrapped in this document.
