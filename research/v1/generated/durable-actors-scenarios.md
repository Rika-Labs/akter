# Durable Actors — what you can build with it

Companion to `durable-actors-v1-surface.md`. That document defines the V1 surface; this one shows the whole surface in one listing, an honest capacity model, and twelve scenarios from a 100M-requests-per-minute API down to sagas, fan-in and human-in-the-loop agents. All numbers are estimates until we benchmark; they are labeled as such. Effect v4 names are from `effect@4.0.0-rc`; low-level `HttpServerResponse`/`HttpRouter` calls are illustrative.

---

## 0. The entire public surface in one file

```ts
// @durable-actors/core — every export, abbreviated types. Everything not listed here is Effect, imported from "effect".

export namespace Actor {
  // definition
  make(name, { protocol, events?, tables, migrations }): ActorType
  command(tag, { input?, output?, error?, key? }?): Command        // Rpc.make + Persisted + WithTransaction
  query(tag, { input?, output }): Query                            // Rpc.make, volatile, served on the caller's runner
  event(tag, fields): Event
  protocol(...messages): Protocol
  events(...events): Events
  // work outside turns
  activity(name, { input, output?, error?, retry?, pool?, execute(input, run: { key, attempt }) }): ActivityType
  job(name, { input, output?, pool?, concurrency?, rateLimit?, retry?, execute(input, job: { id, attempt }) }): JobType
  workflow(name, { input, output?, error?, pool?, run(input, wf: { step, send }) }): WorkflowType
  cron(name, { cron, pool?, execute }): Layer                       // alias of ClusterCron.make
}

interface ActorType  { toLayer(handlers, { init?, onActivate?, onPassivate? }?): Layer }
interface TurnContext  { id; address; generation; turn; ids: { next }; events: { emit }; broadcast; schedule: { after, at }; activities: { start }; jobs: { enqueue }; workflows: { start } }
interface QueryContext { id; address; turn }                       // turn = last committed turn: your version number / ETag

class Actors { get(type, id): Effect<ActorRef> }
interface ActorRef {
  request(cmd, { idempotencyKey?, timeout? }?): Effect<Output, Error | ActorBusy>
  submit(cmd, { idempotencyKey? }?): Effect<Accepted>             // Accepted = { id, await }
  send(cmd, { idempotencyKey? }?): Effect<void>
  query(q, input?): Effect<Output>
  events({ after? }?): Stream<{ seq, turn, event }>
  live: Stream<Broadcast>
}

class Database  { id; sql; one(t, where?); maybe(t, where?); many(t, where?); insert; update(t, patch, where?); delete }   // SqlClient scoped to the turn
class BlobStore { put; get; presign; delete }                            // BlobStore.s3 · BlobStore.fs · BlobStore.memory
class Jobs      { enqueue(job, input): Effect<{ id }>; run(job, input): Effect<Output, JobFailed> }
class Workflows { start(wf, input): Effect<{ id, await }>; poll(id) }

namespace Runner         { layer({ actors?, activities?, jobs?, workflows?, crons?, pools?, retention? }); dev(app, opts) }
namespace ActorStore     { postgres(opts); sqlite(opts) }
namespace ClusterRuntime { layer(opts) }
namespace ActorHttp      { sse(stream) }
namespace ActorRpc       { layer(types, { path }); client(type, { url }) }

// @durable-actors/testing
namespace ActorsTest { layer(opts); settle; turns(type, id); events(type, id); cluster({ runners }) }
namespace Faults     { crashOnce(point, filter); pauseAt(point, filter); points }
```

Thirteen names. Everything else a user types is Effect.

---

## 1. Capacity: where each request lands

```diagram
                100,000,000 requests / minute  =  1.67M / s
                                │
              ┌─────────────────┴─────────────────┐
              │ reads (in practice ≥ 99%)          │ writes (≤ 1%)
              ▼                                    ▼
      CDN / edge cache                       ActorRef.request / submit / send
      ETag = committed turn                  one Postgres transaction per turn
      99% hit → 16.7k/s reach origin         ~10^4 commands/s per primary   ← the hard ceiling
              │
              ▼
      query() on the caller's runner
      → one PK read on Postgres (primary in V1; replicas as a provider option)
      ~20–50k PK reads/s per instance
```

| dimension | estimate | bounded by | when you exceed it |
|---|---|---|---|
| one turn | 3–8 ms | 4–7 SQL statements × DB round trip | — |
| one actor | 150–300 turns/s | serialized turns | shard the actor by hand (§3) |
| one Postgres primary | ~10^4 commands/s ≈ 600k/min | commit rate; ~3 row writes per command | V2: several `ActorStore`s selected by hash |
| origin reads | 20–50k/s per instance | PK lookups | replicas, higher CDN hit rate |
| actor identities | 10^8+ | rows, not processes; a cold actor is one row | — |
| resident actors | 10k per runner default | memory | more runners, shorter `maxIdleTime` |
| request → reply | 10–40 ms same region | insert + owner pickup + transaction | — |
| timers / cron | seconds | poller | — |

Two honest consequences. 100M commands per minute is not a V1 target; it needs ~100 primaries, which is the V2 multi-store design, and we say so. 100M requests per minute is a V1 target only when reads dominate and are served from cache: that is what §2 is.

---

## 2. A 100M-requests-per-minute read API: product catalog

The actor owns the truth. It never sees the read load. Its committed `turn` is the ETag, so the CDN can revalidate against origin cheaply and the origin serves one primary-key read per revalidation.

```ts
// catalog/Product.ts  (tables/migrations follow the surface doc; omitted)
export const SetPrice = Actor.command("SetPrice", { input: { priceCents: Schema.Int } })
export const Restock  = Actor.command("Restock",  { input: { units: Schema.Int } })
export const View     = Actor.query("View", {
  output: Schema.Struct({ id: Schema.String, name: Schema.String, priceCents: Schema.Int, inStock: Schema.Boolean, version: Schema.Int }),
})
export const ProductUpdated = Actor.event("ProductUpdated", {})

export const Product = Actor.make("Product", {
  protocol: Actor.protocol(SetPrice, Restock, View),
  events: Actor.events(ProductUpdated),
  tables: [Products], migrations: ProductMigrations,
})

export const ProductLive = Product.toLayer({
  SetPrice: Effect.fn("Product.SetPrice")(function* ({ priceCents }, ctx) {
    const db = yield* Database
    yield* db.update(Products, { priceCents })
    yield* ctx.events.emit(ProductUpdated.make({}))
    yield* ctx.jobs.enqueue(PurgeCdn, { path: `/products/${ctx.id}` })     // intent, committed with the price
  }),
  Restock: Effect.fn("Product.Restock")(function* ({ units }, ctx) {
    const db = yield* Database
    const p = yield* db.one(Products)
    yield* db.update(Products, { units: p.units + units })
    yield* ctx.jobs.enqueue(PurgeCdn, { path: `/products/${ctx.id}` })
  }),
  View: Effect.fn("Product.View")(function* (_, ctx) {
    const db = yield* Database
    const p = yield* db.one(Products)
    return { id: ctx.id, name: p.name, priceCents: p.priceCents, inStock: p.units > 0, version: ctx.turn }
  }),
})

// cdn/PurgeCdn.ts — a job: retried, rate limited, runs on the "default" pool, never inside a turn
export const PurgeCdn = Actor.job("PurgeCdn", {
  input: { path: Schema.String },
  rateLimit: { limit: 1000, window: "1 second" },
  retry: { schedule: Schedule.exponential("1 second"), maxAttempts: 8 },
  execute: Effect.fn("PurgeCdn")(function* ({ path }) {
    const cdn = yield* Cdn
    yield* cdn.purge(path)                                                     // purging twice is harmless
  }),
})
```

```ts
// http/catalog.ts — the read route is built for a cache, not for a person
const CatalogRoutes = HttpRouter.use((router) =>
  router.add("GET", "/products/:id", Effect.gen(function* () {
    const { id } = yield* HttpRouter.params
    const request = yield* HttpServerRequest.HttpServerRequest
    const actors = yield* Actors
    const product = yield* actors.get(Product, id)
    const view = yield* product.query(View)                                   // caller's runner → Postgres, never the owner
    const etag = `"${id}@${view.version}"`

    if (request.headers["if-none-match"] === etag) {
      return HttpServerResponse.empty({ status: 304 })
    }
    return (yield* HttpServerResponse.json(view)).pipe(
      HttpServerResponse.setHeaders({
        etag,
        "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
      }),
    )
  })),
)
```

```diagram
1.67M/s  GET /products/:id
   │
   ▼
 CDN   hit ≥ 99%  ─────────────────────────────▶ 200 from cache (ETag "shoe-42@17")
   │ miss / revalidate  ≈ 16.7k/s
   ▼
 origin runner  query(View) → SELECT ... WHERE actor_id = $1  → 200 or 304
   ▲
   │ purge /products/shoe-42          (PurgeCdn job, enqueued in the same transaction as the price change)
 Product("shoe-42")  SetPrice turn 18  → COMMIT
```

What the developer never wrote: read replicas, cache keys, invalidation ordering, version numbers. The version is the turn counter that the runtime maintains anyway; the invalidation rides the same transactional intent mechanism as every activity and job.

---

## 3. Flash sale: one hot SKU, 20k reservations/s, without a hot actor

A single actor serializes at 150–300 turns/s. When 10k people hit `Inventory("shoe-42")` in one second, the fix is the pattern the brief called bounded authority, done explicitly in V1: one `Stock` actor owns the total; N `InventoryShard` actors hold allocations and serve reservations locally; a shard asks for more before it runs dry.

```ts
// inventory/Stock.ts — owns the truth: total units and what has been handed out
export const Allocate  = Actor.command("Allocate", {
  input: { shard: Schema.String, refillNo: Schema.Int, want: Schema.Int },
  key: (a) => `${a.shard}/${a.refillNo}`,                                       // one grant per request, even if redelivered
})
export const Stock = Actor.make("Stock", { protocol: Actor.protocol(Allocate, StockView), tables: [Stocks, Grants], migrations: StockMigrations })

export const StockLive = Stock.toLayer({
  Allocate: Effect.fn("Stock.Allocate")(function* ({ shard, refillNo, want }, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    const stock = yield* db.one(Stocks)
    const units = Math.min(want, stock.unallocated)
    yield* db.update(Stocks, { unallocated: stock.unallocated - units })
    yield* db.insert(Grants, { id: yield* ctx.ids.next, shard, refillNo, units })
    const target = yield* actors.get(InventoryShard, shard)
    yield* target.send(Allocated.make({ refillNo, units }))                   // durable send, committed with the grant
  }),
  StockView: Effect.fn("Stock.StockView")(function* () {
    const db = yield* Database
    return yield* db.one(Stocks)
  }),
})
```

```ts
// inventory/InventoryShard.ts — id: "shoe-42/7"; owns an allocation, serves Reserve locally
export class SoldOutHere extends Schema.TaggedError<SoldOutHere>()("SoldOutHere", { shard: Schema.String }) {}

export const Reserve   = Actor.command("Reserve", { input: { cartId: Schema.String, qty: Schema.Int }, output: Schema.Struct({ reservationId: Schema.String }), error: SoldOutHere, key: (r) => r.cartId })
export const Allocated = Actor.command("Allocated", { input: { refillNo: Schema.Int, units: Schema.Int }, key: (a) => `refill/${a.refillNo}` })
export const Release   = Actor.command("Release", { input: { reservationId: Schema.String }, key: (r) => r.reservationId })

const CHUNK = 500
const LOW_WATER = 100

export const InventoryShardLive = InventoryShard.toLayer({
  Reserve: Effect.fn("InventoryShard.Reserve")(function* ({ cartId, qty }, ctx) {
    const db = yield* Database
    const shard = yield* db.one(Shards)

    if (shard.available - qty < LOW_WATER && !shard.refillPending) {          // prefetch: ask before we are dry
      const actors = yield* Actors
      const stock = yield* actors.get(Stock, shard.sku)
      yield* db.update(Shards, { refillPending: true, refillNo: shard.refillNo + 1 })
      yield* stock.send(Allocate.make({ shard: ctx.id, refillNo: shard.refillNo + 1, want: CHUNK }))
    }
    if (shard.available < qty) return yield* new SoldOutHere({ shard: ctx.id })

    const reservationId = yield* ctx.ids.next
    yield* db.update(Shards, { available: shard.available - qty })
    yield* db.insert(Reservations, { id: reservationId, cartId, qty })
    return { reservationId }
  }),

  Allocated: Effect.fn("InventoryShard.Allocated")(function* ({ units }) {
    const db = yield* Database
    const shard = yield* db.one(Shards)
    yield* db.update(Shards, { available: shard.available + units, refillPending: false })
  }),

  Release: Effect.fn("InventoryShard.Release")(function* ({ reservationId }) {
    const db = yield* Database
    const r = yield* db.maybe(Reservations, { id: reservationId })
    if (Option.isNone(r)) return                                                // duplicate or unknown: harmless
    const shard = yield* db.one(Shards)
    yield* db.delete(Reservations, { id: reservationId })
    yield* db.update(Shards, { available: shard.available + r.value.qty })
  }),
})
```

```ts
// http/reserve.ts — route by cart, so one cart always lands on one shard (its Reserve key is the cartId)
const SHARDS = 32
const shardOf = (sku: string, cartId: string) => `${sku}/${Math.abs(Hash.string(cartId)) % SHARDS}`

router.add("POST", "/carts/:cartId/reserve", Effect.gen(function* () {
  const { cartId } = yield* HttpRouter.params
  const { sku, qty } = yield* HttpServerRequest.schemaBodyJson(ReserveBody)
  const actors = yield* Actors
  const shard = yield* actors.get(InventoryShard, shardOf(sku, cartId))
  return yield* shard.request(Reserve.make({ cartId, qty })).pipe(
    Effect.map((r) => HttpServerResponse.json(r)),
    Effect.catchTag("SoldOutHere", () => HttpServerResponse.json({ retryIn: 250 }, { status: 409 })),   // client retries once on a sibling shard
  )
}))
```

```diagram
                 Stock("shoe-42")   unallocated: 10_000 → 9_500 → 9_000 ...
                        ▲ Allocate(shard, refillNo, 500)          │ Allocated(refillNo, 500)
        ┌───────────────┼───────────────┬───────────────┐         ▼
 Shard "shoe-42/0"  Shard "/1"  ...  Shard "/31"        each: available ≤ 500, ~250 Reserve turns/s
        ▲               ▲               ▲
        └── hash(cartId) % 32 ──────────┘              32 × 250 ≈ 8k reservations/s; 128 shards ≈ 30k/s, then the primary's commit rate binds
```

Invariant: `sum(shard.available) + sum(reserved) + stock.unallocated = initial total`, provable because every unit moves in exactly one transaction on exactly one side, and every message carrying units has a key. This is the manual version of `Actor.amount`; V2 can automate the allocation, but the correctness argument is already the one we want.

---

## 4. Webhook ingestion: Stripe retries, exactly one effect

```ts
// http/stripe.ts
router.add("POST", "/webhooks/stripe", Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const event = yield* Stripe.verifyWebhook(request)                            // signature check; pure
  const actors = yield* Actors

  switch (event.type) {
    case "payment_intent.succeeded": {
      const order = yield* actors.get(Order, event.data.object.metadata.orderId)
      yield* order.submit(
        PaymentCaptured.make({ receiptId: event.data.object.id, amountCents: event.data.object.amount }),
        { idempotencyKey: event.id },                                           // Stripe redelivers with the same event.id → no-op
      )
      break
    }
    case "charge.refunded": {
      const order = yield* actors.get(Order, event.data.object.metadata.orderId)
      yield* order.submit(Refunded.make({ amountCents: event.data.object.amount_refunded }), { idempotencyKey: event.id })
      break
    }
  }
  return HttpServerResponse.empty({ status: 200 })                              // durable before Stripe hears 200
}))
```

`submit` returns after one INSERT; the turn happens on the owner a few milliseconds later. If the process dies between the INSERT and the 200, Stripe retries and the key dedupes. If the turn's handler fails with a typed error, that error is the stored reply and `actors inspect Order/order_123` shows it. Budget: this path costs one write per webhook, so ~10k webhooks/s per primary.

---

## 5. Saga across three actors without 2PC

Order, Inventory and Payment each own their truth. No transaction spans them. Correctness comes from keyed commands plus timeouts plus compensation, all of which are ordinary turns.

```ts
// orders/Order.saga.ts — the commands the saga uses
export const Place              = Actor.command("Place")
export const Reserved           = Actor.command("Reserved",           { input: { sku: Schema.String },                 key: (r) => `reserved/${r.sku}` })
export const OutOfStock         = Actor.command("OutOfStock",         { input: { sku: Schema.String },                 key: (r) => `oos/${r.sku}` })
export const ReservationTimeout = Actor.command("ReservationTimeout", { input: { attempt: Schema.Int },                key: (t) => `timeout/${t.attempt}` })
export const PaymentCaptured    = Actor.command("PaymentCaptured",    { input: PaymentReceipt,                         key: (r) => r.receiptId })
export const PaymentFailed      = Actor.command("PaymentFailed",      { input: PaymentDeclined })

// inventory/Inventory.saga.ts — id: the sku
export const Reserve = Actor.command("Reserve", { input: { orderId: Schema.String, qty: Schema.Int }, key: (r) => r.orderId })
export const Confirm = Actor.command("Confirm", { input: { orderId: Schema.String },                  key: (r) => r.orderId })
export const Release = Actor.command("Release", { input: { orderId: Schema.String },                  key: (r) => r.orderId })
```

```ts
export const OrderLive = Order.toLayer({
  Place: Effect.fn("Order.Place")(function* (_, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    const order = yield* db.one(Orders)
    if (order.status !== "draft") return yield* new OrderNotDraft({ orderId: ctx.id, status: order.status })

    const items = yield* db.many(OrderItems)
    for (const item of items) {
      const inventory = yield* actors.get(Inventory, item.sku)
      yield* inventory.send(Reserve.make({ orderId: ctx.id, qty: item.quantity }))     // N durable sends, one commit
    }
    yield* db.update(Orders, { status: "reserving", pending: items.length, attempt: order.attempt + 1 })
    yield* ctx.schedule.after("30 seconds", ReservationTimeout.make({ attempt: order.attempt + 1 }))
  }),

  Reserved: Effect.fn("Order.Reserved")(function* ({ sku }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "reserving") return                                              // late reply after timeout: ignore
    yield* db.update(OrderItems, { reserved: true }, { sku })
    const pending = order.pending - 1
    if (pending > 0) return yield* db.update(Orders, { pending })

    yield* db.update(Orders, { status: "paying", pending: 0 })
    yield* ctx.activities.start(CapturePayment, { orderId: ctx.id, amountCents: order.totalCents }, { onSuccess: PaymentCaptured, onFailure: PaymentFailed })
  }),

  OutOfStock: Effect.fn("Order.OutOfStock")(function* ({ sku }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "reserving") return
    yield* db.update(Orders, { status: "failed", failureReason: `out of stock: ${sku}` })
    yield* releaseReserved(ctx)                                                           // compensation
    yield* ctx.events.emit(OrderFailed.make({ reason: "out_of_stock", sku }))
  }),

  ReservationTimeout: Effect.fn("Order.ReservationTimeout")(function* ({ attempt }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (order.status !== "reserving" || order.attempt !== attempt) return                 // stale timer: ignore
    yield* db.update(Orders, { status: "failed", failureReason: "reservation timeout" })
    yield* releaseReserved(ctx)
    yield* ctx.events.emit(OrderFailed.make({ reason: "timeout" }))
  }),

  PaymentCaptured: Effect.fn("Order.PaymentCaptured")(function* ({ receiptId }, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    yield* db.update(Orders, { status: "paid" })
    for (const item of yield* db.many(OrderItems)) {
      yield* (yield* actors.get(Inventory, item.sku)).send(Confirm.make({ orderId: ctx.id }))
    }
    yield* ctx.events.emit(OrderPaid.make({ receiptId }))
  }),

  PaymentFailed: Effect.fn("Order.PaymentFailed")(function* (declined, ctx) {
    const db = yield* Database
    yield* db.update(Orders, { status: "failed", failureReason: declined.code })
    yield* releaseReserved(ctx)
    yield* ctx.events.emit(OrderFailed.make({ reason: "payment", code: declined.code }))
  }),
})

// plain Effect helper used by three handlers; runs inside whichever turn calls it
const releaseReserved = Effect.fn("Order.releaseReserved")(function* (ctx: TurnContext) {
  const db = yield* Database
  const actors = yield* Actors
  for (const item of yield* db.many(OrderItems, { reserved: true })) {
    yield* (yield* actors.get(Inventory, item.sku)).send(Release.make({ orderId: ctx.id }))
  }
})
```

```ts
export const InventoryLive = Inventory.toLayer({
  Reserve: Effect.fn("Inventory.Reserve")(function* ({ orderId, qty }, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    const order = yield* actors.get(Order, orderId)
    const inv = yield* db.one(Inventories)
    if (inv.available < qty) return yield* order.send(OutOfStock.make({ sku: ctx.id }))

    yield* db.update(Inventories, { available: inv.available - qty })
    yield* db.insert(Holds, { orderId, qty, state: "held" })
    yield* order.send(Reserved.make({ sku: ctx.id }))
  }),
  Confirm: Effect.fn("Inventory.Confirm")(function* ({ orderId }) {
    const db = yield* Database
    yield* db.update(Holds, { state: "confirmed" }, { orderId })
  }),
  Release: Effect.fn("Inventory.Release")(function* ({ orderId }) {
    const db = yield* Database
    const hold = yield* db.maybe(Holds, { orderId })
    if (Option.isNone(hold) || hold.value.state !== "held") return              // already released/confirmed, or never held
    const inv = yield* db.one(Inventories)
    yield* db.update(Inventories, { available: inv.available + hold.value.qty })
    yield* db.update(Holds, { state: "released" }, { orderId })
  }),
})
```

```diagram
happy path                                            compensation (one sku short)

Order.Place ──Reserve──▶ Inventory(shirt)             Order.Place ──Reserve──▶ Inventory(shirt)
           ──Reserve──▶ Inventory(shoe)                          ──Reserve──▶ Inventory(shoe)
           ⏲ ReservationTimeout(30s)                              ⏲ ReservationTimeout(30s)
Inventory(shirt) ──Reserved──▶ Order  pending 2→1     Inventory(shirt) ──Reserved──▶ Order   pending 2→1, shirt.reserved
Inventory(shoe)  ──Reserved──▶ Order  pending 1→0     Inventory(shoe)  ──OutOfStock─▶ Order  status → failed
Order → CapturePayment activity                                  Order ──Release──▶ Inventory(shirt)   hold → released
  └─▶ PaymentCaptured ──Confirm──▶ both inventories    timer fires later: status ≠ reserving → ignored
```

Every arrow is a keyed, persisted command, so any of them may be delivered twice and any process may die between any two arrows. There is no coordinator process to lose: the state of the saga is the `Orders.status` row, which `actors inspect Order/o1` shows as a timeline of turns.

---

## 6. Fan-out to 100k actors and fan-in without a hot spot

Sending 100k commands from one turn would be one giant transaction; collecting 100k completions into one actor would be 100k serialized turns (~6 minutes). Both are avoided: a job pages and sends; completions land on sharded stats actors; the roll-up is a SQL read.

```ts
// campaigns/Campaign.ts
export const Start = Actor.command("Start", { input: { listId: Schema.String } })
export const Progress = Actor.query("Progress", { output: Schema.Struct({ delivered: Schema.Int, bounced: Schema.Int }) })

export const CampaignLive = Campaign.toLayer({
  Start: Effect.fn("Campaign.Start")(function* ({ listId }, ctx) {
    const db = yield* Database
    yield* db.update(Campaigns, { status: "sending", listId })
    yield* ctx.jobs.enqueue(FanOut, { campaignId: ctx.id, listId })          // the loop lives in a job, not a turn
  }),
  Progress: Effect.fn("Campaign.Progress")(function* (_, ctx) {
    const db = yield* Database                                                // reads across actors are plain SQL
    const [row] = yield* db.sql<{ delivered: number; bounced: number }>`
      SELECT coalesce(sum(delivered),0) AS delivered, coalesce(sum(bounced),0) AS bounced
      FROM campaign_stats WHERE campaign_id = ${ctx.id}`
    return row
  }),
})

// campaigns/FanOut.ts — pages through the list, one durable send per contact
export const FanOut = Actor.job("FanOut", {
  input: { campaignId: Schema.String, listId: Schema.String },
  concurrency: 2, pool: "default",
  execute: Effect.fn("FanOut")(function* ({ campaignId, listId }) {
    const sql = yield* SqlClient.SqlClient                                     // cross-actor read: allowed. Writes go through commands.
    const actors = yield* Actors
    let cursor = ""
    while (true) {
      const page = yield* sql<{ actor_id: string }>`
        SELECT actor_id FROM contacts WHERE list_id = ${listId} AND actor_id > ${cursor} ORDER BY actor_id LIMIT 1000`
      if (page.length === 0) return
      yield* Effect.forEach(page, ({ actor_id }) => Effect.gen(function* () {
        const contact = yield* actors.get(Contact, actor_id)
        yield* contact.send(Deliver.make({ campaignId }))                     // key = campaignId → a job retry re-sends nothing
      }), { concurrency: 64, discard: true })
      cursor = page[page.length - 1].actor_id
    }
  }),
})
```

```ts
// contacts/Contact.ts — each contact does its own delivery and reports to a stats shard
export const Deliver     = Actor.command("Deliver",     { input: { campaignId: Schema.String }, key: (d) => `deliver/${d.campaignId}` })
export const EmailSent   = Actor.command("EmailSent",   { input: { campaignId: Schema.String, messageId: Schema.String }, key: (e) => `sent/${e.campaignId}` })
export const EmailFailed = Actor.command("EmailFailed", { input: { campaignId: Schema.String, reason: Schema.String },    key: (e) => `failed/${e.campaignId}` })

const STATS_SHARDS = 16
const statsShard = (campaignId: string, contactId: string) => `${campaignId}/${Math.abs(Hash.string(contactId)) % STATS_SHARDS}`

export const ContactLive = Contact.toLayer({
  Deliver: Effect.fn("Contact.Deliver")(function* ({ campaignId }, ctx) {
    const db = yield* Database
    const c = yield* db.one(Contacts)
    if (c.unsubscribed) return
    yield* ctx.activities.start(SendEmail, { to: c.email, campaignId }, { onSuccess: EmailSent, onFailure: EmailFailed })
  }),
  EmailSent: Effect.fn("Contact.EmailSent")(function* ({ campaignId, messageId }, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    yield* db.insert(Deliveries, { campaignId, messageId })
    yield* (yield* actors.get(CampaignStats, statsShard(campaignId, ctx.id))).send(Delivered.make({ contactId: ctx.id }))
  }),
  EmailFailed: Effect.fn("Contact.EmailFailed")(function* ({ campaignId }, ctx) {
    const actors = yield* Actors
    yield* (yield* actors.get(CampaignStats, statsShard(campaignId, ctx.id))).send(Bounced.make({ contactId: ctx.id }))
  }),
})

// campaigns/CampaignStats.ts — id "camp_1/7": a counter row; 16 shards × ~250 turns/s absorbs 100k completions in ~30 s
export const CampaignStatsLive = CampaignStats.toLayer({
  Delivered: Effect.fn("CampaignStats.Delivered")(function* () {
    const db = yield* Database
    yield* db.sql`UPDATE campaign_stats SET delivered = delivered + 1 WHERE actor_id = ${db.id}`
  }),
  Bounced: Effect.fn("CampaignStats.Bounced")(function* () {
    const db = yield* Database
    yield* db.sql`UPDATE campaign_stats SET bounced = bounced + 1 WHERE actor_id = ${db.id}`
  }),
}, { init: /* insert { campaign_id: id.split("/")[0], delivered: 0, bounced: 0 } */ })
```

```diagram
Campaign("camp_1").Start
   └─▶ FanOut job: SELECT 1000 ids … → 64 concurrent send(Deliver) → next page        ~3–5k sends/s → 100k in ~30 s
                     ▼ (spread over every actor runner)
        Contact(c1) Contact(c2) … Contact(c100000)     each: Deliver → SendEmail activity → EmailSent
                     ▼ hash(contactId) % 16
        CampaignStats("camp_1/0") … ("camp_1/15")      counters
                     ▼
        Campaign.Progress: SELECT sum(...) FROM campaign_stats WHERE campaign_id = 'camp_1'     one SQL read, no actor turn
```

The ownership rule holds in both directions: `FanOut` reads `contacts` with SQL because reads across actors are just reads; it never writes a contact row, it sends `Deliver`.

---

## 7. Request/response between actors with a deadline

Actors do not block on each other. A request-and-reply between two actors is two commands plus a timer, and the guard state lives in a row.

```ts
export const RequestQuote = Actor.command("RequestQuote", { input: { destination: Schema.String } })
export const QuoteReady   = Actor.command("QuoteReady",   { input: { quoteNo: Schema.Int, cents: Schema.Int }, key: (q) => `quote/${q.quoteNo}` })
export const QuoteTimeout = Actor.command("QuoteTimeout", { input: { quoteNo: Schema.Int },                    key: (q) => `quote-timeout/${q.quoteNo}` })

export const OrderQuotes = Order.toLayer({
  RequestQuote: Effect.fn("Order.RequestQuote")(function* ({ destination }, ctx) {
    const db = yield* Database
    const actors = yield* Actors
    const order = yield* db.one(Orders)
    const quoteNo = order.quoteNo + 1
    yield* db.update(Orders, { quoteNo, shippingCents: null })
    yield* (yield* actors.get(Shipping, order.carrier)).send(Quote.make({ orderId: ctx.id, quoteNo, destination }))
    yield* ctx.schedule.after("10 seconds", QuoteTimeout.make({ quoteNo }))
  }),
  QuoteReady: Effect.fn("Order.QuoteReady")(function* ({ quoteNo, cents }) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (quoteNo !== order.quoteNo || order.shippingCents !== null) return    // superseded, or timeout already won
    yield* db.update(Orders, { shippingCents: cents })
  }),
  QuoteTimeout: Effect.fn("Order.QuoteTimeout")(function* ({ quoteNo }, ctx) {
    const db = yield* Database
    const order = yield* db.one(Orders)
    if (quoteNo !== order.quoteNo || order.shippingCents !== null) return    // reply already won
    yield* db.update(Orders, { shippingCents: FLAT_RATE_CENTS })
    yield* ctx.events.emit(QuoteFellBack.make({ quoteNo }))
  }),
})

// Shipping side: reply is just a send back, keyed by the caller's quoteNo
Quote: Effect.fn("Shipping.Quote")(function* ({ orderId, quoteNo, destination }, ctx) {
  const actors = yield* Actors
  const cents = yield* rate(destination)                                        // pure table lookup; external calls would be an activity
  yield* (yield* actors.get(Order, orderId)).send(QuoteReady.make({ quoteNo, cents }))
}),
```

The two races (reply after timeout, timeout after reply) resolve inside the `Order` transaction: whichever turn commits first writes `shippingCents`, the other sees it and returns. No locks, no correlation registry, no in-memory promise map that a crash could lose.

---

## 8. Realtime collaboration: a document with history, live updates and presence

```ts
// docs/Document.ts
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { currentVersion: Schema.Int }, { httpApiStatus: 409 }) {}

export const Apply      = Actor.command("Apply", { input: { ops: Schema.Array(Op), baseVersion: Schema.Int, opId: Schema.String, author: Schema.String }, output: Schema.Struct({ version: Schema.Int }), error: Conflict, key: (a) => a.opId })
export const Snapshot   = Actor.query("Snapshot", { output: Schema.Struct({ version: Schema.Int, content: Schema.String }) })
export const OpsApplied = Actor.event("OpsApplied", { ops: Schema.Array(Op), version: Schema.Int, author: Schema.String })
export const Cursor     = Schema.Struct({ user: Schema.String, position: Schema.Int })                 // ephemeral: broadcast only

export const DocumentLive = Document.toLayer({
  Apply: Effect.fn("Document.Apply")(function* ({ ops, baseVersion, author }, ctx) {
    const db = yield* Database
    const doc = yield* db.one(Documents)
    if (baseVersion !== doc.version) return yield* new Conflict({ currentVersion: doc.version })   // client rebases from events
    const content = applyOps(doc.content, ops)                                                     // pure
    const version = doc.version + 1
    yield* db.update(Documents, { content, version })
    yield* ctx.events.emit(OpsApplied.make({ ops, version, author }))
    return { version }
  }),
  Snapshot: Effect.fn("Document.Snapshot")(function* () {
    const db = yield* Database
    const doc = yield* db.one(Documents)
    return { version: doc.version, content: doc.content }
  }),
})
```

```ts
// browser / CLI client over WebSocket
const client = yield* ActorRpc.client(Document, { url: "wss://api.example.com/rpc" })
const doc = client.get("spec")

const snapshot = yield* doc.query(Snapshot)
yield* doc.events({ after: snapshotSeq }).pipe(Stream.runForEach((e) => Effect.sync(() => editor.apply(e.event))), Effect.forkScoped)   // durable, resumable
yield* doc.live.pipe(Stream.runForEach((c) => Effect.sync(() => editor.showCursor(c))), Effect.forkScoped)                          // ephemeral

yield* doc.request(Apply.make({ ops, baseVersion: editor.version, opId: crypto.randomUUID(), author: me })).pipe(
  Effect.catchTag("Conflict", ({ currentVersion }) => rebaseFrom(currentVersion)),                   // the events stream already carried what we missed
)
```

Presence needs one thing the surface doc does not have yet: publishing an ephemeral value from outside a turn. Proposal: `ref.broadcast(value)` as a volatile RPC to the owner's PubSub, no turn, no persistence. Without it, cursors would have to be commands, which is wrong (they are not truth).

---

## 9. Per-entity recurring work: subscriptions, dunning, drift audit

```ts
// billing/Subscription.ts
export const Activate = Actor.command("Activate", { input: { planId: Schema.String, renewsAt: Schema.DateTimeUtc } })
export const Renew    = Actor.command("Renew",    { input: { cycle: Schema.Int }, key: (r) => `renew/${r.cycle}` })
export const Charged  = Actor.command("Charged",  { input: { cycle: Schema.Int, receiptId: Schema.String }, key: (c) => c.receiptId })
export const ChargeFailed = Actor.command("ChargeFailed", { input: { cycle: Schema.Int, code: Schema.String } })

export const SubscriptionLive = Subscription.toLayer({
  Activate: Effect.fn("Subscription.Activate")(function* ({ planId, renewsAt }, ctx) {
    const db = yield* Database
    yield* db.update(Subscriptions, { planId, status: "active", cycle: 1, renewsAt })
    yield* ctx.schedule.at(renewsAt, Renew.make({ cycle: 1 }))
  }),
  Renew: Effect.fn("Subscription.Renew")(function* ({ cycle }, ctx) {
    const db = yield* Database
    const s = yield* db.one(Subscriptions)
    if (s.status !== "active" || s.cycle !== cycle) return                     // cancelled, or a stale timer
    yield* ctx.activities.start(ChargeCard, { subscriptionId: ctx.id, cycle, amountCents: s.amountCents }, { onSuccess: Charged, onFailure: ChargeFailed })
  }),
  Charged: Effect.fn("Subscription.Charged")(function* ({ cycle }, ctx) {
    const db = yield* Database
    const s = yield* db.one(Subscriptions)
    const next = DateTime.addDuration(s.renewsAt, Duration.days(30))
    yield* db.update(Subscriptions, { cycle: cycle + 1, renewsAt: next, failures: 0 })
    yield* ctx.schedule.at(next, Renew.make({ cycle: cycle + 1 }))            // the actor reschedules itself; no external scheduler state
  }),
  ChargeFailed: Effect.fn("Subscription.ChargeFailed")(function* ({ cycle, code }, ctx) {
    const db = yield* Database
    const s = yield* db.one(Subscriptions)
    if (s.failures >= 2) {
      yield* db.update(Subscriptions, { status: "suspended" })
      return yield* ctx.events.emit(Suspended.make({ code }))
    }
    yield* db.update(Subscriptions, { failures: s.failures + 1 })
    yield* ctx.schedule.after("3 days", Renew.make({ cycle }))                // dunning: same cycle, later
  }),
})

// billing/audit.ts — cron as a safety net: find drift, fix through commands
export const RenewalAudit = Actor.cron("RenewalAudit", {
  cron: Cron.unsafeParse("0 3 * * *"),
  execute: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const actors = yield* Actors
    const overdue = yield* sql<{ actor_id: string; cycle: number }>`
      SELECT actor_id, cycle FROM subscriptions WHERE status = 'active' AND renews_at < now() - interval '1 day'`
    yield* Effect.forEach(overdue, (s) => Effect.flatMap(actors.get(Subscription, s.actor_id), (ref) => ref.send(Renew.make({ cycle: s.cycle }))), { concurrency: 32, discard: true })
  }),
})
```

Ten million subscriptions cost ten million rows and ten million `DeliverAt` messages, not ten million timers in memory. On any given day only the due ones become turns.

---

## 10. Agent with human approval on dangerous tools

The agent is an actor (owns the conversation) plus a workflow (the model loop). Approval uses Effect's `DurableDeferred` directly; the token travels inside a command and comes back through HTTP days later.

```ts
// agents/AgentRun.ts
import { Activity, DurableDeferred } from "effect/unstable/workflow"

export const ApprovalRequested = Actor.command("ApprovalRequested", { input: { runId: Schema.String, step: Schema.Int, call: ToolCall, token: DurableDeferred.Token }, key: (a) => `${a.runId}/${a.step}` })

export const AgentRun = Actor.workflow("AgentRun", {
  input: { assistantId: Schema.String, runId: Schema.String },
  output: { answer: Schema.String },
  pool: "ai",
  run: Effect.fn("AgentRun")(function* ({ assistantId, runId }, wf) {
    const actors = yield* Actors
    const assistant = yield* actors.get(Assistant, assistantId)
    let step = 0
    while (true) {
      step += 1
      const history = yield* assistant.query(History, { runId })                   // query is fine inside a workflow
      const result = yield* wf.step(CallModel, { history, step })                   // memoized: a crash mid-loop replays, does not re-bill

      if (result.type === "answer") return { answer: result.text }

      if (isDangerous(result.toolCall)) {
        const Approval = DurableDeferred.make(`approval/${step}`, { success: Schema.Boolean })
        const token = yield* DurableDeferred.token(Approval)
        yield* wf.send(Assistant, assistantId, ApprovalRequested.make({ runId, step, call: result.toolCall, token }))
        const approved = yield* DurableDeferred.await(Approval)                     // suspended: zero compute until a human acts
        if (!approved) {
          yield* wf.send(Assistant, assistantId, ToolSkipped.make({ runId, step }))
          continue
        }
      }
      const out = yield* wf.step(RunTool, { call: result.toolCall, step })
      yield* wf.send(Assistant, assistantId, ToolFinished.make({ runId, step, output: out }))
    }
  }),
})

// http/approvals.ts — WorkflowEngine comes from ClusterRuntime.layer
router.add("POST", "/approvals/:token", Effect.gen(function* () {
  const { token } = yield* HttpRouter.params
  const { approved, step } = yield* HttpServerRequest.schemaBodyJson(ApprovalBody)
  yield* DurableDeferred.succeed(DurableDeferred.make(`approval/${step}`, { success: Schema.Boolean }), { token, value: approved })
  return HttpServerResponse.empty({ status: 204 })
}))
```

The `Assistant` actor stores `ApprovalRequested` as a row and emits an event; the UI subscribes to `assistant.events()` and renders the button. Everything a reviewer needs to reconstruct "why did the agent do that" is in the actor's turn timeline plus the workflow's step journal. Streaming model tokens to the UI needs the same `ref.broadcast` proposal as §8; until then, the answer arrives as a command.

---

## 11. Analytics and backfills over millions of actors

Reads across actors are SQL against your own Postgres. Mutations across actors are a job that sends commands. Nothing needs a projection pipeline because the truth is already relational.

```sql
-- dashboards, BI tools, ad hoc: read the actor tables directly
SELECT status, count(*) AS orders, sum(total_cents) AS revenue
FROM orders WHERE created_at > now() - interval '30 days'
GROUP BY status;

SELECT c.actor_id AS customer_id, count(o.actor_id) AS paid_orders
FROM customers c JOIN orders o ON o.customer_id = c.actor_id AND o.status = 'paid'
GROUP BY c.actor_id ORDER BY paid_orders DESC LIMIT 100;
```

```ts
// ops/RegenerateInvoices.ts — writes go through actors, paged, with progress you can watch
export const RegenerateInvoices = Actor.job("RegenerateInvoices", {
  input: { since: Schema.DateTimeUtc, batchId: Schema.String },
  concurrency: 1,
  execute: Effect.fn("RegenerateInvoices")(function* ({ since, batchId }) {
    const sql = yield* SqlClient.SqlClient
    const actors = yield* Actors
    const progress = yield* actors.get(Backfill, batchId)
    let cursor = ""
    for (let page = 0; ; page++) {
      const rows = yield* sql<{ actor_id: string }>`
        SELECT actor_id FROM orders WHERE status = 'paid' AND paid_at > ${since} AND actor_id > ${cursor} ORDER BY actor_id LIMIT 500`
      if (rows.length === 0) return yield* progress.send(Finished.make({ batchId }))
      yield* Effect.forEach(rows, (r) => Effect.flatMap(actors.get(Order, r.actor_id), (o) => o.send(RegenerateInvoice.make({ batchId }))), { concurrency: 32, discard: true })
      yield* progress.send(PageDone.make({ page, count: rows.length }))         // key = page: a job retry cannot double count
      cursor = rows[rows.length - 1].actor_id
    }
  }),
})
```

```bash
actors jobs run RegenerateInvoices '{"since":"2026-08-01T00:00:00Z","batchId":"bf_1"}'
actors inspect Backfill/bf_1            # PageDone × 412, Finished
```

---

## 12. Evolving schema and protocol in production

```ts
// 1. schema: a new migration; runs once per deploy, before the new code takes traffic
export const OrderMigrations = Migrator.fromRecord({
  "0001_orders": /* as before */,
  "0002_orders_discount": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0`
  }),
})

// 2. protocol: add a command → add a handler. Nothing else changes.
export const ApplyDiscount = Actor.command("ApplyDiscount", { input: { cents: Schema.Int, code: Schema.String }, key: (d) => d.code })

// 3. changing a command's input: new tag, keep the old handler until the pending queue for it is empty
export const PayV2 = Actor.command("PayV2", { input: { paymentMethodId: Schema.String, threeDsToken: Schema.NullOr(Schema.String) }, error: CannotPay })
// ... deploy with both Pay and PayV2 handlers; clients move to PayV2 ...
```

```bash
actors inspect --pending --command Pay        # 0 → safe to delete the Pay handler and tag
```

Events are append-only: add optional fields, never change meaning; consumers replaying from `after: 0` decode old rows with the old shape. No lazy per-actor migration exists to reason about because there is one database and one schema version at a time.

---

## 13. Testing the saga: crash at every boundary, then prove the invariant

```ts
import { assert, it } from "@effect/vitest"
import { TestClock } from "effect/testing"

const Env = ActorsTest.layer({ actors: [OrderLive, InventoryLive], activities: [CapturePayment], fakes: { Payments: PaymentsFake } })
// seed(...) and Arbitrary.saga(...) are test-local helpers: they insert rows through commands and generate Place/Release sequences

it.layer(Env)("order saga", (it) => {
  it.effect("completes when every reply is redelivered", () =>
    Effect.gen(function* () {
      const actors = yield* Actors
      yield* seed({ inventory: { shirt: 5, shoe: 5 }, order: { o1: [["shirt", 1], ["shoe", 1]] } })
      yield* Faults.crashOnce("turn.afterCommit", { actor: Inventory, command: Reserve })   // reservation committed, reply lost, redelivered
      yield* Faults.crashOnce("turn.beforeCommit", { actor: Order, command: Reserved })     // Order dies mid-turn once

      yield* (yield* actors.get(Order, "o1")).request(Place.make())
      yield* ActorsTest.settle

      assert.strictEqual((yield* (yield* actors.get(Order, "o1")).query(Get)).status, "paid")
      assert.strictEqual((yield* (yield* actors.get(Inventory, "shirt")).query(InventoryView)).available, 4)   // exactly one hold
    }))

  it.effect("times out and releases when one inventory never answers", () =>
    Effect.gen(function* () {
      const actors = yield* Actors
      yield* seed({ inventory: { shirt: 5, shoe: 0 }, order: { o2: [["shirt", 1], ["shoe", 1]] } })
      const paused = yield* Faults.pauseAt("turn.beforeCommit", { actor: Inventory, id: "shoe", command: Reserve })

      yield* (yield* actors.get(Order, "o2")).request(Place.make())
      yield* paused.reached
      yield* TestClock.adjust("31 seconds")
      yield* ActorsTest.settle

      assert.strictEqual((yield* (yield* actors.get(Order, "o2")).query(Get)).status, "failed")
      assert.strictEqual((yield* (yield* actors.get(Inventory, "shirt")).query(InventoryView)).available, 5)   // released
      yield* paused.resume                                                                                        // late Reserve now runs...
      yield* ActorsTest.settle
      assert.strictEqual((yield* (yield* actors.get(Inventory, "shoe")).query(InventoryView)).available, 0)     // ...and OutOfStock is ignored by the failed order
    }))

  it.effect.prop("available is never negative and units are conserved", { ops: Arbitrary.saga({ orders: 8, skus: 2, maxQty: 3 }) }, ({ ops }) =>
    Effect.gen(function* () {
      const actors = yield* Actors
      yield* seed({ inventory: { a: 6, b: 6 } })
      yield* Effect.forEach(ops, (op) => Effect.flatMap(actors.get(Order, op.orderId), (o) => o.send(op.command)), { discard: true })
      yield* TestClock.adjust("2 minutes")
      yield* ActorsTest.settle

      for (const sku of ["a", "b"]) {
        const inv = yield* (yield* actors.get(Inventory, sku)).query(InventoryView)
        assert.isAtLeast(inv.available, 0)
        assert.strictEqual(inv.available + inv.held + inv.confirmed, 6)
      }
    }))
})
```

The second test would fail with the "obvious" implementation that lacks the `attempt` guard on `ReservationTimeout` or the `status !== "reserving"` guard on `OutOfStock`; the property test catches a `Release` that credits units twice. These are the bugs distributed sagas actually ship with, and they are reproduced deterministically on a laptop.

---

## 14. What it cannot do, so nobody has to find out later

```text
1.67M commands/s                 one primary sustains ~10^4/s; V2 shards ActorStores by hash, V1 does not
sub-millisecond turns            a turn is a Postgres transaction: 3–8 ms
cross-actor transactions         by design; §5 is the pattern, and it is the only pattern
exactly-once external effects    activities are keyed so retries are detectable, but Stripe/SMTP/HTTP have their own idempotency rules
multi-region writes              one primary per ActorStore; readers may be anywhere, writers are in one region
ephemeral publish from outside   ref.broadcast is a proposal (§8, §10), not in the surface doc yet
timer precision                  seconds; not for rate limiting or animation
```
