# Worked example: a DNS ordering API with only actors

Written in the surface proposed in [DX.md](DX.md) (89–134). Not typechecked: the sketch in `framework/Actor.ts`
does not yet have `state`, `internal`, `Actor.ephemeral`, `WorkflowRun` or `Actor.singleton`. Everything else
(turn model, intents, outbox, workflows, cron, Cluster placement) is decided in [DECISIONS.md](DECISIONS.md).

## The product

Resellers (tenants) place orders for domains on behalf of their customers. An order is charged, registered at
the registrar, gets a DNS zone with records, and is "live" when the nameservers answer for it. Customers manage
records afterwards. Ops needs: retry a stuck order, see orders by status per reseller, a live status page.
Constraints that make it a scaling problem: bursty order volume (launch days), registrar APIs with hard rate
limits, propagation waits of minutes to hours, and millions of zones that each need a single writer.

## Actors

| Kind | Name | One per | Holds | Why this kind |
| --- | --- | --- | --- | --- |
| `Actor.make` | `Order` | order id | `orders` row (status, amounts: queried across actors), events for the status page | identity + commands over time; reportable |
| `Actor.workflow` | `Fulfil` | order id (idempotency key) | steps: charge → register → zone → propagation | a process with a start and an end; durable sleeps while waiting |
| `Actor.make` | `Domain` | fqdn | `dns_records` rows, `state` (serial, nameservers, expiry), outbox `PushZone` | one writer per zone; serial must never go backwards |
| `Actor.ephemeral` | `RegistrarLane` | registrar × lane | in-memory token bucket | rate limiting needs serialization, not durability; never a transaction per token |
| `Actor.cron` | `Reconcile` | cluster | every 6 h: SQL for stuck orders → `Escalate` intents | cross-actor sweep, one runner |
| service on `Database` | `Reports` | — | `orders by status per tenant` | plain SQL; no fan-out because it is one database |

Nothing else. No queue, no job runner, no cache, no scheduler: intents, the outbox and workflow sleeps are those.

## Contracts (clients import these)

```ts
// Ids.ts
export const OrderId  = Schema.String.pipe(Schema.brand("OrderId"))
export const Fqdn     = Schema.String.pipe(Schema.pattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/), Schema.brand("Fqdn"))
export const LaneId   = Schema.String.pipe(Schema.brand("LaneId"))
export const OrderStatus = Schema.Literals(["placed", "paid", "registered", "zone_ready", "live", "failed", "cancelled"])

// Order.ts
export class DomainTaken     extends Schema.TaggedError<DomainTaken>()("DomainTaken", { domain: Fqdn }, { httpApiStatus: 409 }) {
  override get message() { return `${this.domain} is already registered` }
}
export class PaymentDeclined extends Schema.TaggedError<PaymentDeclined>()("PaymentDeclined", { code: Schema.String }, { httpApiStatus: 402 }) {}
export class NotCancellable  extends Schema.TaggedError<NotCancellable>()("NotCancellable", { status: OrderStatus }) {   // 422 default
  override get message() { return `an order in status "${this.status}" cannot be cancelled` }
}

export class OrderSummary extends Schema.Class<OrderSummary>("OrderSummary")({
  orderId: OrderId, domain: Fqdn, status: OrderStatus, amountCents: Schema.Number, placedAt: Schema.DateTimeUtc,
  failure: Schema.optionalKey(Schema.String)
}) {}

export class OrderPlaced    extends Schema.TaggedClass<OrderPlaced>()("OrderPlaced", { domain: Fqdn }) {}
export class OrderPaid      extends Schema.TaggedClass<OrderPaid>()("OrderPaid", { chargeId: Schema.String }) {}
export class OrderRegistered extends Schema.TaggedClass<OrderRegistered>()("OrderRegistered", { registrarRef: Schema.String }) {}
export class OrderLive      extends Schema.TaggedClass<OrderLive>()("OrderLive", {}) {}
export class OrderFailed    extends Schema.TaggedClass<OrderFailed>()("OrderFailed", { stage: Schema.String, reason: Schema.String }) {}
export class OrderCancelled extends Schema.TaggedClass<OrderCancelled>()("OrderCancelled", {}) {}
export class NotifyCustomer extends Schema.TaggedClass<NotifyCustomer>()("NotifyCustomer", { customerId: Schema.String, template: Schema.String }) {}

// one row per order: the fields ops and reporting query ACROSS orders live here, not in state
export const orders = Actor.table("orders", {
  domain: "text", status: "text", customer_id: "text", amount_cents: "integer", placed_at: "timestamptz", failure: "text"
})

export const Place = Actor.command("Place", {
  description: "Place a domain order. Charges the card, registers the domain and provisions DNS asynchronously; follow /events for progress.",
  input: { domain: Fqdn, customerId: Schema.String, years: Schema.Int.pipe(Schema.between(1, 10)), cardToken: Schema.Redacted(Schema.String) },
  output: OrderSummary,
  errors: [DomainTaken]
})
export const Cancel   = Actor.command("Cancel",   { description: "Cancel before payment is captured.", errors: [NotCancellable] })
export const Escalate = Actor.command("Escalate", { description: "Ops: flag a stuck order and notify the customer." })
// results reported by the Fulfil workflow; not callable from outside
export const Paid       = Actor.command("Paid",       { input: { chargeId: Schema.String } })
export const Registered = Actor.command("Registered", { input: { registrarRef: Schema.String } })
export const ZoneReady  = Actor.command("ZoneReady")
export const WentLive   = Actor.command("WentLive")
export const Failed     = Actor.command("Failed",     { input: { stage: Schema.String, reason: Schema.String } })

export const Status = Actor.query("Status", { description: "Current order summary.", output: OrderSummary })

export const Order = Actor.make("Order", {
  description: "One domain order from placement to live DNS.",
  id: OrderId,
  tables: [orders],
  commands: [Place, Cancel, Escalate, Paid, Registered, ZoneReady, WentLive, Failed],
  internal: [Paid, Registered, ZoneReady, WentLive, Failed, Escalate],
  queries: [Status],
  events: [OrderPlaced, OrderPaid, OrderRegistered, OrderLive, OrderFailed, OrderCancelled],
  effects: [NotifyCustomer],
  lifecycle: [
    Lifecycle.createdBy(Place),            // Cancel/Status on an unknown id → NotCreated (404)
    Hibernate.after("1 minute"),           // an order is idle almost all of its life
    Events.keep("90 days"),
    Receipts.keep("7 days"),
    Commands.timeout("5 seconds"),
    Effects.retry(Schedule.exponential("10 seconds").pipe(Schedule.compose(Schedule.recurs(8))))
  ]
})
```

```ts
// Domain.ts
export const RecordType = Schema.Literals(["A", "AAAA", "CNAME", "MX", "TXT", "NS"])
export class DnsRecord extends Schema.Class<DnsRecord>("DnsRecord")({ id: Schema.String, name: Schema.String, type: RecordType, value: Schema.String, ttl: Schema.Int }) {}
export class RecordConflict extends Schema.TaggedError<RecordConflict>()("RecordConflict", { name: Schema.String, type: RecordType }, { httpApiStatus: 409 }) {}
export class RecordChanged  extends Schema.TaggedClass<RecordChanged>()("RecordChanged", { serial: Schema.Int, record: DnsRecord, op: Schema.Literals(["add", "remove"]) }) {}
export class ZoneRegistered extends Schema.TaggedClass<ZoneRegistered>()("ZoneRegistered", { registrarRef: Schema.String }) {}
export class PushZone       extends Schema.TaggedClass<PushZone>()("PushZone", { serial: Schema.Int }) {}     // outbox: idempotent by serial

export const records = Actor.table("dns_records", { id: "text", name: "text", type: "text", value: "text", ttl: "integer" })

export const Register     = Actor.command("Register",     { input: { orderId: OrderId, registrarRef: Schema.String, nameservers: Schema.Array(Schema.String), years: Schema.Int } })
export const AddRecord    = Actor.command("AddRecord",    { description: "Add a record; bumps the zone serial and pushes the zone.", input: { name: Schema.String, type: RecordType, value: Schema.String, ttl: Schema.Int }, output: DnsRecord, errors: [RecordConflict] })
export const RemoveRecord = Actor.command("RemoveRecord", { input: { id: Schema.String } })
export const CheckExpiry  = Actor.command("CheckExpiry")
export const Zone         = Actor.query("Zone", { description: "All records and the current serial.", output: Schema.Struct({ serial: Schema.Int, records: Schema.Array(DnsRecord) }) })

export const Domain = Actor.make("Domain", {
  description: "One registered domain and its DNS zone. Single writer: the serial only moves forward.",
  id: Fqdn,
  state: { serial: Schema.Int, registrarRef: Schema.String, nameservers: Schema.Array(Schema.String), expiresAt: Schema.DateTimeUtc },
  tables: [records],
  commands: [Register, AddRecord, RemoveRecord, CheckExpiry],
  internal: [Register, CheckExpiry],
  queries: [Zone],
  events: [ZoneRegistered, RecordChanged],
  effects: [PushZone],
  lifecycle: [
    Lifecycle.createdBy(Register),
    Hibernate.after("2 minutes"),
    Cron.every("0 3 * * *", CheckExpiry),                           // per-actor: each zone checks its own expiry
    Effects.retry(Schedule.exponential("1 second").pipe(Schedule.compose(Schedule.recurs(20))))
  ]
})
```

```ts
// RegistrarLane.ts — the only hot spot, and it is in memory
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", { retryAfterMs: Schema.Int }, { httpApiStatus: 429 }) {}
export const Acquire = Actor.command("Acquire", { errors: [RateLimited] })
export const RegistrarLane = Actor.ephemeral("RegistrarLane", {
  description: "Token bucket for one registrar lane. Forgets its count on restart; the registrar's own limit is the backstop.",
  id: LaneId,
  memory: { tokens: Schema.Number, refilledAt: Schema.DateTimeUtc },
  commands: [Acquire],
  lifecycle: [Hibernate.after("5 minutes"), Mailbox.capacity(10_000)]
})
export const LANES = 16
export const laneFor = (domain: Fqdn): LaneId => LaneId.make(`${tld(domain)}:${hash(domain) % LANES}`)

// Fulfil.ts
export const Fulfil = Actor.workflow("Fulfil", {
  description: "Charge, register, provision, wait for propagation; reports each stage to the Order.",
  input: { orderId: OrderId, domain: Fqdn, customerId: Schema.String, years: Schema.Int, cardToken: Schema.Redacted(Schema.String) },
  errors: [DomainTaken, PaymentDeclined],
  idempotencyKey: ({ orderId }) => orderId                           // Place twice → one execution
})

// Reconcile.ts
export const Reconcile = Actor.cron("Reconcile", { description: "Escalate orders stuck for more than 24h.", cron: "0 */6 * * *" })
```

## Server files

```ts
// Order.server.ts
export const OrderLive = Order.toLayer({
  Place: Effect.fn(function*(ctx, input) {
    const amountCents = yield* Pricing.quote(input.domain, input.years)
    yield* ctx.rows(orders).insert({ domain: input.domain, status: "placed", customer_id: input.customerId, amount_cents: amountCents, placed_at: ctx.now })
    yield* ctx.emit(new OrderPlaced({ domain: input.domain }))
    yield* ctx.workflows.start(Fulfil, { orderId: ctx.id, ...input })          // intent: committed with this turn
    return yield* summary(ctx)
  }),
  Cancel: Effect.fn(function*(ctx) {
    const row = yield* ctx.rows(orders).oneOrDie()                               // createdBy(Place) guarantees the row
    if (row.status !== "placed") return yield* new NotCancellable({ status: row.status })
    yield* ctx.rows(orders).update({ status: "cancelled" })
    yield* ctx.workflows.cancel(Fulfil, ctx.id)                                  // intent: engine interrupts the run
    yield* ctx.emit(new OrderCancelled({}))
  }),
  Paid:       (ctx, { chargeId })     => advance(ctx, "paid",       new OrderPaid({ chargeId })),
  Registered: (ctx, { registrarRef }) => advance(ctx, "registered", new OrderRegistered({ registrarRef })),
  ZoneReady:  (ctx)                   => ctx.rows(orders).update({ status: "zone_ready" }),
  WentLive:   (ctx)                   => advance(ctx, "live", new OrderLive({})).pipe(
                                           Effect.andThen(ctx.perform(new NotifyCustomer({ customerId: ctx.rowsCache?.customer_id ?? "", template: "live" })))),
  Failed: Effect.fn(function*(ctx, { stage, reason }) {
    yield* ctx.rows(orders).update({ status: "failed", failure: `${stage}: ${reason}` })
    yield* ctx.emit(new OrderFailed({ stage, reason }))
    yield* ctx.perform(new NotifyCustomer({ customerId: (yield* ctx.rows(orders).oneOrDie()).customer_id, template: "failed" }))
  }),
  Escalate: (ctx) => ctx.perform(new NotifyCustomer({ customerId: "ops", template: "stuck" }))
}, {
  effects: {
    NotifyCustomer: (ctx, n) => Mailer.send(n.customerId, n.template)            // at least once; Mailer is idempotent on (orderId, template)
  }
})
const advance = (ctx: Order.Context, status: OrderStatus, event: Order.Event) =>
  ctx.rows(orders).update({ status }).pipe(Effect.andThen(ctx.emit(event)))

export const OrderReads = Order.toQueryLayer({ Status: (ctx) => summary(ctx) })
```

```ts
// Domain.server.ts
export const DomainLive = Domain.toLayer({
  Register: Effect.fn(function*(ctx, input) {
    yield* ctx.state.set({ serial: 1, registrarRef: input.registrarRef, nameservers: input.nameservers, expiresAt: DateTime.addDuration(ctx.now, Duration.days(365 * input.years)) })
    yield* ctx.rows(records).insert({ id: "ns", name: "@", type: "NS", value: input.nameservers[0]!, ttl: 3600 })
    yield* ctx.emit(new ZoneRegistered({ registrarRef: input.registrarRef }))
    yield* ctx.perform(new PushZone({ serial: 1 }))
  }),
  AddRecord: Effect.fn(function*(ctx, input) {
    const clash = yield* ctx.rows(records).one({ where: { name: input.name, type: input.type } })
    if (Option.isSome(clash) && input.type === "CNAME") return yield* new RecordConflict({ name: input.name, type: input.type })
    const serial = ctx.state.serial + 1
    const record = new DnsRecord({ id: ctx.commandId, ...input })                // commandId: stable across retries → stable record id
    yield* ctx.rows(records).insert(record)
    yield* ctx.state.set({ serial })
    yield* ctx.emit(new RecordChanged({ serial, record, op: "add" }))
    yield* ctx.perform(new PushZone({ serial }))
    return record
  }),
  RemoveRecord: …,
  CheckExpiry: (ctx) =>
    DateTime.distance(ctx.now, ctx.state.expiresAt) < Duration.toMillis("30 days")
      ? ctx.actors.get(Order, /* renewal order */ OrderId.make(`renew-${ctx.id}-${DateTime.formatIso(ctx.state.expiresAt)}`)).Place.send(…)
      : Effect.void
}, {
  effects: {
    PushZone: (ctx, { serial }) =>
      Effect.gen(function*() {
        const zone = yield* Nameservers.render(ctx.id)                            // reads committed rows; serial is the idempotency key
        yield* Nameservers.push(ctx.id, serial, zone)
      })
  }
})
export const DomainReads = Domain.toQueryLayer({
  Zone: (ctx) => ctx.rows(records).all().pipe(Effect.map((rs) => ({ serial: ctx.state.serial, records: rs.map(toDnsRecord) })))
})
```

```ts
// RegistrarLane.server.ts — 2 000 registrations/hour per lane, in memory
export const RegistrarLaneLive = RegistrarLane.toLayer({
  Acquire: Effect.fn(function*(ctx) {
    const rate = 2000 / 3600_000                                                  // tokens per ms
    const now = ctx.now
    const refilled = Math.min(2000, ctx.memory.tokens + DateTime.distance(ctx.memory.refilledAt, now) * rate)
    if (refilled < 1) return yield* new RateLimited({ retryAfterMs: Math.ceil((1 - refilled) / rate) })
    yield* ctx.memory.set({ tokens: refilled - 1, refilledAt: now })
  })
})
```

```ts
// Fulfil.server.ts
export const FulfilLive = Fulfil.toLayer(Effect.fn(function*(ctx, input) {
  const order  = yield* ctx.actors.get(Order, input.orderId)                      // System("workflow", onBehalfOf: whoever placed it)
  const domain = yield* ctx.actors.get(Domain, input.domain)
  const lane   = yield* ctx.actors.get(RegistrarLane, laneFor(input.domain))

  const charge = yield* ctx.activity("charge",
    Payments.charge({ idempotencyKey: input.orderId, token: input.cardToken, amountCents: yield* Pricing.quote(input.domain, input.years) }),
    { retry: Schedule.exponential("1 second").pipe(Schedule.compose(Schedule.recurs(5))) })   // PaymentDeclined is not retried: declared error
  yield* order.Paid({ chargeId: charge.id })

  // registrar lane: wait in durable sleep, not in a thread
  yield* lane.Acquire().pipe(
    Effect.catchTag("RateLimited", (e) => ctx.sleep(Duration.millis(e.retryAfterMs)).pipe(Effect.andThen(lane.Acquire()))),
    Effect.retry({ while: (e) => e._tag === "RateLimited", times: 100 })
  )
  const reg = yield* ctx.activity("register", Registrar.register(input.domain, input.years, { idempotencyKey: input.orderId }))
  yield* domain.Register({ orderId: input.orderId, registrarRef: reg.ref, nameservers: reg.nameservers, years: input.years })
  yield* order.Registered({ registrarRef: reg.ref })
  yield* order.ZoneReady()

  // propagation: up to 2 hours, zero compute while waiting
  for (let attempt = 0; attempt < 240; attempt++) {
    if (yield* ctx.activity(`propagation-${attempt}`, Resolver.servesZone(input.domain, reg.nameservers))) {
      return yield* order.WentLive()
    }
    yield* ctx.sleep("30 seconds")
  }
  yield* order.Failed({ stage: "propagation", reason: "timeout" })
}).pipe(
  Effect.tapError((e) => Effect.flatMap(ctx.actors.get(Order, input.orderId), (o) => o.Failed({ stage: e._tag, reason: e.message })))   // declared errors reach the order
))

// Reconcile.server.ts — cross-actor sweep with one SQL query
export const ReconcileLive = Reconcile.toLayer(Effect.gen(function*() {
  const stuck = yield* Reports.stuck({ olderThan: "24 hours" })                    // SELECT tenant_id, actor_id FROM orders WHERE status NOT IN ('live','failed','cancelled') AND placed_at < …
  yield* Effect.forEach(stuck, ({ tenant, id }) => Order.get(id, { tenant }).pipe(Effect.flatMap((o) => o.Escalate())), { concurrency: 16 })
}))

// Reports.ts — not an actor; it is one database
export class Reports extends Context.Service<Reports, {
  readonly byStatus: (tenant: TenantId) => Effect.Effect<ReadonlyArray<{ status: OrderStatus; n: number }>, SqlError>
  readonly stuck: (o: { olderThan: Duration.Input }) => Effect.Effect<ReadonlyArray<{ tenant: TenantId; id: OrderId }>, SqlError>
}>()("app/Reports") {
  static readonly layer = Layer.effect(Reports, Effect.map(Database, ({ drizzle }) => ({ byStatus: …, stuck: … })))
}
```

## Wiring, API, clients

```ts
// server.ts
export const AppLive = Layer.mergeAll(OrderLive, OrderReads, DomainLive, DomainReads, RegistrarLaneLive, FulfilLive, ReconcileLive).pipe(
  Layer.provide(Layer.mergeAll(Payments.layer, Registrar.layer, Nameservers.layer, Resolver.layer, Mailer.layer, Pricing.layer, Reports.layer)),
  Layer.provideMerge(Actor.serve({
    actors: [Order, Domain],                       // RegistrarLane is not served: internal to the cluster
    workflows: [Fulfil],
    auth: Actor.auth.bearer((token) => ApiKeys.verify(token)),      // → Principal { userId, orgId: reseller, roles }
    docs: true
  })),
  Layer.provide(Actor.layer({
    principal: PrincipalSchema,
    tenant: (p) => TenantId.make(p.orgId),         // reseller = tenant = Neki shard key
    shardGroup: (tenant) => Regions.of(tenant),    // eu resellers run on eu runners
    topology: Topology.fromConfig(),
    pollInterval: "1 second"
  })),
  Layer.provide(Database.layerConfig())
)
```

```
POST /actors/Order/ord_8f3/Place          Authorization: Bearer …   x-command-id: 6c0e…   (reuse on retry)
{ "domain": "example.com", "customerId": "c_12", "years": 2, "cardToken": "tok_…" }
→ 200 OrderSummary      409 DomainTaken      503 ActorUnavailable + Retry-After      401 Unauthorized
GET  /actors/Order/ord_8f3/Status
GET  /actors/Order/ord_8f3/events?after=0                      text/event-stream: OrderPlaced, OrderPaid, …, OrderLive
POST /actors/Domain/example.com/AddRecord
GET  /llms.txt   /openapi.json   /actors/Order.md
```

```ts
// reseller frontend
const orders = Order.client({ baseUrl, headers: { authorization: `Bearer ${key}` }, timeoutInMs: 10_000 })
const summary = await orders.get(orderId).Place({ domain, customerId, years: 2, cardToken }, { signal })    // commandId minted here, reused on retry
for await (const e of orders.get(orderId).events({ after: 0, signal })) render(e.event)

// support agent
export const SupportTools = Actor.toolkit([Order, Domain])       // Order_Status, Order_Cancel, Domain_AddRecord, … ; internal commands absent
```

## How it scales

| Pressure | What absorbs it | Lever |
| --- | --- | --- |
| more orders per second | orders are independent actors; runners are stateless | add runner replicas; Cluster rebalances shards; ceiling is Postgres write throughput → Neki shards on `(tenant_id, actor_id)` with no app change |
| launch-day burst | `Mailbox.capacity`, `Delivery.retry`, then `ActorUnavailable` 503 with `Retry-After`; `x-command-id` makes the retry safe | clients back off; nothing is lost or doubled |
| registrar rate limit | `RegistrarLane`: in-memory, mailbox-serialized, 16 lanes per registrar | change `LANES`; no database transaction per token |
| waiting (propagation up to 2 h) | `Fulfil` sleeps durably; no activation, no fiber, no connection is held | free |
| millions of zones | each `Domain` is one row set + a few state keys; idle zones hibernate after 2 min | memory is proportional to *active* zones |
| per-zone consistency | single writer per fqdn; `serial` in state; `PushZone` outbox idempotent by serial | no lock service |
| reporting | `Reports` runs SQL over `orders` | one query; no fan-out over actors |
| regions | `shardGroup: (tenant) => region` | eu compute for eu resellers; the database is still one |
| history growth | `Events.keep("90 days")`, `Receipts.keep("7 days")` | purge jobs are the framework's |
| ops | `Reconcile` cron, `Escalate` internal command, `SupportTools` toolkit, `/actors/Order.md` | agents and humans use the same contract |

Capacity, honestly: one order is about 7 turns (Place, Paid, Registered, ZoneReady, WentLive on `Order`; Register on
`Domain`; one `Acquire` in memory) plus 3–240 activities, so sustained orders/s ≈ (runners × pool size) / (7 × commit
latency), bounded below by Postgres write IOPS. On a local Postgres that is thousands of orders per minute per runner;
on Neki across AZs, fewer. Measure before promising a number. The only serialization point outside a single order is
`RegistrarLane`, and it is in memory.

## What the tests look like

```ts
it.layer(TestLive)("DNS ordering", (it) => {
  it.effect("Place is exactly-once through a crash before commit, and starts one workflow", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      const order = yield* test.actor(Order, OrderId.make("o1"))
      yield* order.crash({ at: "beforeCommit", command: "Place", times: 1 })
      yield* order.handle.Place({ domain: Fqdn.make("example.com"), customerId: "c1", years: 1, cardToken: Redacted.make("tok") })
      expect((yield* order.turns).map((t) => t.trigger)).toEqual(["call", "redelivery"])
      expect(yield* test.workflows.running(Fulfil)).toHaveLength(1)
    }))

  it.effect("propagation waits on the durable clock and the order goes live", () =>
    Effect.gen(function*() {
      const test = yield* ActorTest
      yield* Resolver.test.answerAfter(3)                                            // false, false, false, true
      const order = yield* test.actor(Order, OrderId.make("o2"))
      yield* order.handle.Place({ … })
      yield* test.effects.run                                                        // Fulfil activities execute
      yield* test.clock.advance("90 seconds")                                        // three sleeps
      expect((yield* order.rows(orders))[0]?.status).toBe("live")
      expect((yield* order.inspect).events.map((e) => e.event._tag)).toEqual(["OrderPlaced", "OrderPaid", "OrderRegistered", "OrderLive"])
    }))

  it.effect("a declined card fails the order and notifies once", () => …)
  it.effect("RateLimited on the lane becomes a durable sleep, not a busy loop", () => …)
  it.effect("the browser cannot call Order.Paid", () => …)                               // 404 over test.serve
  it.effect.prop("random Add/Remove scripts under chaos keep the serial monotonic", …)  // Scripts.arbitrary + Model
})
```
