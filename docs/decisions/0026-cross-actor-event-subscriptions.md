# ADR 0026: Cross-actor event subscriptions

**Status:** proposed (2026-09-26). It amends [contract 04](../contracts/04-receipts.md), [contract 05](../contracts/05-messaging.md), [contract 07](../contracts/07-realtime.md), [contract 10](../contracts/10-security.md), and [retention](../operations/retention.md). It builds on the outbox ([ADR 0011](0011-direct-commands-outbox-and-performance.md)) and the multi-runner relay ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)). The amendments listed under [Amendments](#amendments) land in the same change.

**Responsibility:** decide how one actor follows another actor's committed events and is woken durably when a new one commits, even while it sleeps, so that the build unit ([#94](https://github.com/Rika-Labs/durable-actors/issues/94), migration `0016_subscriptions`) has no open design questions.

**Authority:** design decision record.

**Owner role:** runtime and realtime architecture.

**Change policy:** supersede through a new ADR.

## Context

`turn.emit` appends an event in the emitting turn's transaction, with a gap-free, never-reissued cursor per actor (M1.5, [contract 05](../contracts/05-messaging.md)). Today the only readers are the owner's queries (`read.events`), workflow `waitFor` on the owner's own events ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)), and live streams and connections ([ADR 0023](0023-connections-parking-and-streams.md)). Nothing lets a different actor react to those events. An application that needs one has two options, and both are wrong:

- **The publisher fans out by hand.** It stages one intent per interested actor in its own turn. The publisher then has to know its subscribers, and its commit grows with their number. The `subscriptions` baseline below measures that growth.
- **The subscriber polls.** It runs a timer that queries the source. That costs a turn per poll per pair, and it still misses history once pruning starts.

General uses:

- **Projections.** A `CustomerSummary` per customer follows every `Order` of that customer.
- **Fan-in.** A per-tenant `Dashboard` counts events from thousands of sources.
- **Reactions to history the source doesn't know about.** An `Inventory` actor starts following one `Supplier` and later stops.

Dallen asked for this to be a headline feature (2026-09-26). The subscriber must be woken durably when an event commits, even while it sleeps. Delivery must go through the outbox and relay as a receipt-deduplicated command, not through best-effort broadcast.

### How Rivet and Cloudflare Durable Objects do it

Sources were read on 2026-09-26.

**Rivet Actors.**

- **Events are broadcasts to connections.** `c.broadcast(name, …)` sends to clients that hold a `.connect()` connection. Events aren't stored, and a disconnected client misses them ([Realtime](https://rivet.dev/actors/docs/events/)).
- **Actor-to-actor events use a connection.** The documented pattern is for the subscriber to open a connection to the publisher and register `conn.on(...)` handlers inside an action ([Communicating between actors, "Event-Driven Architecture"](https://rivet.dev/actors/docs/communicating-between-actors/)). The subscriber has to stay awake to hold that connection. An actor sleeps only when it has no active connections, apart from hibernatable WebSockets ([Lifecycle, "Sleeping"](https://rivet.dev/actors/docs/lifecycle/)). Events are lost across a crash, a move, or sleep.
- **Durable delivery uses queues.** They are per-actor, persisted, and wake the receiver ([Queues & Run Loops](https://rivet.dev/actors/docs/queues/), [changelog 2026-02-25](https://rivet.dev/changelog/2026-02-25-queues-for-rivet-actors/)). The sender addresses each receiver, so fan-out is still the publisher's job. As published on 2026-09-26, the docs say a message is removed when it is received and isn't redelivered if processing fails. Open [rivet#5763](https://github.com/rivet-dev/rivet/pull/5763) corrects them: a `completable: true` message stays stored until `complete()` and is delivered again after a restart. That makes it at-least-once, with deduplication left to the application.
- **Durable Streams** ([changelog 2026-09-03](https://rivet.dev/changelog/2026-09-03-durable-streams-now-supports-rivet-actors/)) are an ordered log with offsets that a reader resumes from. Rivet's own example tails a stream from `onWake` with long-polling, and its client code notes: "If the agent went to sleep while idle, wake it here so it picks up the prompt." An append doesn't wake a sleeping reader.
- **Authorization** is a per-event `canSubscribe` hook on the publisher ([Lifecycle, `canPublish` and `canSubscribe`](https://rivet.dev/actors/docs/lifecycle/)).
- **Cron and schedules** wake sleeping actors ([changelog 2026-07-20](https://rivet.dev/changelog/2026-07-20-introducing-cron-jobs-for-rivet-actors/), [Schedule](https://rivet.dev/actors/docs/schedule/)). Events don't.

The brief says Rivet has just announced cross-actor subscriptions. I couldn't find that announcement. The newest changelog entries, through 2026-09-24 (JWT authentication), and the rivet-dev/rivet pull requests since 2026-09-01 contain no actor-to-actor subscription feature. The comparison below uses what is published and should be rechecked against the announcement once someone has its link.

**Cloudflare Durable Objects.**

- **There's no pub/sub between objects.** A publisher calls each subscriber's stub by RPC or `fetch`, which wakes the target. It keeps its own list of subscribers.
- **Retries need alarms.** A storage write and an outgoing call aren't one transaction. Output gates hold the call until the write is durable, but a crash after the write and before the call loses the call ([Durable Objects: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)). Reliable fan-out therefore stores pending sends and retries them from an alarm. An object has one alarm, with at-least-once execution and 6 retries with exponential backoff ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)).
- **Hibernatable WebSockets** wake an object on an inbound message ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). Nothing wakes on another object's state change.
- **Queues** can't deliver directly to an object. The consumer is a Worker, which forwards to the object ([Queues configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)).
- **Workflows** push to one instance by id with `instance.sendEvent`, buffered until `step.waitForEvent` ([Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/)). That is point-to-point, not a subscription.

**Where this design is stronger.**

- **The event and its wake-up commit together.** A committed event always reaches every subscriber, and a rolled-back one never does. Neither platform ties an event to its delivery in one transaction.
- **Sleeping subscribers are woken.** Rivet's connection-based events and Durable Streams don't wake them; Durable Objects need a hand-written alarm loop.
- **Each event has exactly one effect on a subscriber**, enforced by receipts plus a subscriber-side cursor that never expires. Both platforms leave deduplication to the application.
- **Order is kept per publisher.** Gaps from pruning are explicit `RetentionGap` deliveries, never silent.
- **The publisher doesn't know its subscribers** (routed subscriptions), and its commit costs the same with one subscriber or ten thousand.
- **Lag is visible in SQL.** It is a cursor column beside the source's `event_sequence`.

**Where it is weaker.**

- **Latency is higher.** Rivet's broadcast is an in-memory send. Here, an event reaches a subscriber after the committing runner's relay wakes, or within one relay poll (1 s) otherwise, and each delivery is a full turn.
- **Fan-in throughput is bounded by the subscriber's turn rate.** That is about 300 turns/s for one unbatched actor in the M1 baseline, and turn batches ([ADR 0005](0005-turn-latency-batching-and-regional-placement.md)) raise it.
- **Write amplification.** Each delivery writes a receipt and a cursor row.
- **Scope is narrower.** Subscriptions are same-tenant and one-region, and a client subscribes through connections or SSE, not through this mechanism.
- **Rivet and Durable Objects run at the edge**, which this deployment model doesn't.

### Measured starting point

The new `subscriptions` scenario measures hand-rolled fan-out: a publisher turn that stages one intent per subscriber, which is the commit-time fan-out this ADR rejects. The intents fall due in a day, so only the publisher's turn is timed. The results are in [`f4bff2b-adr-0026-baseline`](../../benchmarks/results/2026-09-26-f4bff2b-adr-0026-baseline-postgres.json), with a same-SHA repeat as the noise reference, and [performance](../verification/03-performance.md#cross-actor-subscriptions-baseline) summarizes them. On Postgres 18.6 (one 4-vCPU VM, one publisher):

| Subscribers | Publisher turn p50 |      p99 | Publishes/s | Statements per turn |
| ----------: | -----------------: | -------: | ----------: | ------------------: |
|           1 |             2.5 ms |  11.7 ms |         324 |                8.01 |
|          16 |             8.9 ms |  15.7 ms |         110 |                8.02 |
|         256 |            42.5 ms |  64.0 ms |        24.5 |                8.10 |
|       1,024 |           114.8 ms | 174.8 ms |         8.9 |                8.24 |

The statement count barely moves, because the rows go in one multi-row insert, so the T2 statement gate wouldn't catch this growth. The latency and the time the publisher holds its generation row lock grow roughly linearly with subscribers, and so does its WAL.

## Decision

A subscription is a declared member of the subscriber. Each committed event of the declared classes from a matching source reaches the subscriber's internal handler command as an ordinary command turn. The relay delivers it through the same claim, lease, and receipt path as an outbox intent. The publisher's turn pays a constant cost, whatever the number of subscribers. The relay does the fan-out after commit, on the source's shard.

### 1. Declaration: `Actor.subscription` in a `subscriptions` section

```ts
import { Actor } from "durable-actors"

// Routed: every OrderPlaced or OrderCancelled from any Order in the tenant reaches
// the CustomerSummary named by the event. Order doesn't know CustomerSummary exists.
export const CustomerOrders = Actor.subscription("CustomerOrders", {
  source: Order,
  events: [OrderPlaced, OrderCancelled],
  handler: RecordOrder,
  route: (event) => event.customerId,
})

export const RecordOrder = Actor.command("RecordOrder", {
  input: Actor.Delivery(CustomerOrders),
})

export const CustomerSummary = Actor.make("CustomerSummary", {
  key: CustomerId,
  state: SummaryState,
  events: [SummaryChanged],
  internal: { RecordOrder },
  subscriptions: [CustomerOrders],
})
```

- **Declaration.** `Actor.subscription(tag, { source, events, handler, route? })` declares a subscription. `source` is an actor definition. `events` is a non-empty list of that source's declared event classes; a class the source doesn't list fails to compile. `handler` is a command in the subscriber's `internal` section whose input accepts `Actor.Delivery(subscription)`, checked like an effect's `onSuccess` route. Tags are unique within the subscriber's `subscriptions`.
- **Routed subscriptions.** A subscription with `route` is routed. `route(event, source: ActorRef)` is a pure function that returns the subscriber's id, which the subscriber's key schema checks. A singleton subscriber uses `route: Actor.singleton`, which sends every matching event in the tenant to the tenant's singleton. That is the fan-in dashboard. A routed subscription follows every actor of the source type in the tenant.
- **Dynamic subscriptions.** A subscription without `route` is dynamic. It follows only the source instances that a subscriber's turn subscribes to ([section 2](#2-dynamic-subscribe-and-unsubscribe-from-a-turn)).
- **The handler receives one delivery per turn**, as `Actor.Delivery(S)`:

```ts
type Delivery<E> =
  | {
      readonly _tag: "Event"
      readonly subscription: string // the subscription's tag
      readonly source: ActorRef // the publisher
      readonly cursor: string // the event's cursor in the publisher's stream
      readonly event: E // one of the declared classes
      readonly commandId: string // the publisher's command that emitted it
      readonly timestamp: DateTime.Utc
    }
  | {
      readonly _tag: "RetentionGap"
      readonly subscription: string
      readonly source: ActorRef
      readonly after: string // the last cursor this subscriber applied
      readonly resumeAfter: string // the next delivery comes after this cursor
    }
```

- **The handler runs in `X.Turn`.** It can do everything any command handler can: set state, write rows, emit its own events, stage intents, perform effects, subscribe or unsubscribe, and broadcast.
- **The delivery's command id** is derived ([section 4](#4-cursors-receipts-and-at-least-once-transport-with-exactly-once-effect)). Its caller is `System({ source: "subscription", ref: <source ref> })` with no `onBehalfOf`: events don't store their emitter's principal. A handler that needs attribution reads it from the event's fields.
- **Deploy check.** The runtime indexes routed subscriptions by `(source type, event tag)` when the layer is built. At startup it records those pairs in the deployment row. A runner that hosts a source type but lacks a routed subscription recorded for that type still marks feeds correctly, because marking is driven by data ([section 3](#3-fan-out-at-relay-time-not-at-commit)). A routed declaration takes effect on each source at that source's first matching commit on a runner that registers it.

### 2. Dynamic subscribe and unsubscribe from a turn

```ts
const Follow = Actor.subscription("Follow", {
  source: Supplier,
  events: [PriceChanged, Discontinued],
  handler: OnSupplier,
})

// In an Inventory command turn:
const turn = yield * Inventory.Turn
yield * turn.subscribe(Follow, supplierId) // from: "now" by default
yield * turn.subscribe(Follow, otherId, { from: "start" }) // replay retained history first
yield * turn.subscribe(Follow, thirdId, { from: savedCursor }) // resume after a known cursor
yield * turn.unsubscribe(Follow, supplierId)
```

- **Staging.** `turn.subscribe` and `turn.unsubscribe` stage like intents. They take effect only if the turn commits, and a declared failure or rollback discards them. They exist only on `X.Turn`, and only for dynamic subscriptions: passing a routed subscription is a type error. The source id is a string checked against the source's key schema.
- **What the turn commits on the subscriber's shard.** Subscribing upserts the subscriber's cursor row for `(subscription, source)` with a new `epoch` (the previous epoch plus 1) and `applied` set from `from`. It also writes an outbox `control` row, keyed `$sub:<tag>:<source id>`, that carries the operation and the epoch. Unsubscribing deletes the cursor row and writes the same keyed control row with the `remove` operation. The key makes a later operation replace a pending earlier one.
- **What the relay does on the source's shard.** It claims the control row like an intent and runs a framework statement there, not a turn, so the source is never activated. The statement locks the source's generation row `FOR SHARE`, which conflicts with the emit path's `FOR UPDATE` as in [ADR 0022](0022-workflow-engine-storage-and-version-markers.md) decision 5. It then upserts or deletes the source-side subscription row, fenced by epoch: an older epoch never overwrites a newer one. The statement creates the source's generation row (with `created = false`) if it doesn't exist, so an actor can subscribe to a source that hasn't been created yet.
- **`from` values:**
  - `"now"` delivers events committed after the registration reaches the source.
  - `"start"` delivers from cursor 0. If history has been pruned, the first delivery is a `RetentionGap`.
  - A cursor string resumes after that cursor. A cursor above the source's current sequence fails the registration with `UnknownCursor` in the span, and the subscription is removed.
- **Unsubscribing takes effect in the subscriber's turn.** Once it commits, the cursor row is gone. A delivery already in flight then finds no row and is acknowledged as `Unsubscribed` without running the handler. The relay deletes the source row when it sees that acknowledgement. An out-of-order control delivery therefore can't leave a subscription that keeps delivering.

### 3. Fan-out at relay time, not at commit

The source's commit writes at most one extra row, whatever the number of subscribers. Tables `0016_subscriptions` adds (target DDL; the build unit may adjust names but not placement):

```sql
-- On the source's shard: one row per (source actor, subscription, subscriber); routed rows use subscriber_id = ''.
CREATE TABLE actor_subscriptions (
  routing_key bigint NOT NULL,          -- the source's
  tenant_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  subscriber_type text NOT NULL,
  subscription text NOT NULL,           -- the subscription's tag on subscriber_type
  subscriber_id text NOT NULL,
  events text[] NOT NULL,
  epoch bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL,            -- last source cursor settled for this row
  bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
  due_at_ms bigint,                     -- null while caught up
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  PRIMARY KEY (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id),
  FOREIGN KEY (routing_key, tenant_id, source_type, source_id) REFERENCES actor_generations
) WITH (fillfactor = 80);
CREATE INDEX actor_subscriptions_due ON actor_subscriptions (bucket, due_at_ms) WHERE due_at_ms IS NOT NULL;

-- On the subscriber's shard: what the subscriber has applied, per source. Authoritative for deduplication.
CREATE TABLE actor_subscription_cursors (
  routing_key bigint NOT NULL,          -- the subscriber's
  tenant_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  subscription text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  epoch bigint NOT NULL DEFAULT 0,
  applied bigint NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id),
  FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
);

ALTER TABLE actor_outbox DROP CONSTRAINT actor_outbox_kind_check,
  ADD CONSTRAINT actor_outbox_kind_check CHECK (kind IN ('intent', 'effect', 'feed', 'control'));
```

**At commit (the publisher's turn).** The event-append statement gains one CTE, so the turn keeps its round trips and statement count ([ADR 0020](0020-two-round-trip-turn-pipeline.md), T2 baseline). The CTE:

1. For routed subscriptions registered on this runner that name one of the emitted tags, it inserts the missing source-side rows with `delivered` set to this turn's first sequence minus 1 (`ON CONFLICT DO NOTHING`). The routed list is a bound parameter, and empty for most actor types.
2. It upserts one outbox row of kind `feed` on the source, keyed `$feed` and due now, if the source has any subscription row for an emitted tag or step 1 inserted one. `ON CONFLICT` keeps the earlier `due_at_ms`. The probe `EXISTS (… WHERE source = me AND events && $tags)` uses the primary-key prefix. On an actor with no subscriptions it is one index probe and writes nothing.

A rolled-back or declared-failure turn emits no events, so it writes neither.

**At relay time.**

- **Expansion.** A runner claims a due `feed` row like an intent ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 1). It then expands it with one statement on the source's shard. The statement sets `due_at_ms` on every row of that source that has an undelivered matching event and isn't already due. The rows the runner has free subscription-delivery slots for get a lease instead of "now", so they are claimed in the same statement. The runner pages through a source with many subscriptions 1,000 rows at a time. Finally it deletes the `feed` row, fenced on the lease it holds. A commit that re-marked the row during expansion leaves it due again, so no commit's wake-up is lost.
- **Delivery.** A runner claims due subscription rows with `FOR UPDATE SKIP LOCKED` and a lease, exactly as ADR 0021 claims intents. The claim scans only `actor_subscriptions_due`, so caught-up subscriptions cost nothing ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md) due-work rule). The claim filters on subscriber types registered on the runner, as cron does for its ticks. For each claimed row the runner:
  1. reads up to `subscriptions.batch` (default 16) matching events after `delivered`, together with the oldest retained sequence, in one statement (the M1.5 replay shape);
  2. delivers a `RetentionGap` first if history after `delivered` was pruned ([section 7](#7-retention-and-keepevents));
  3. delivers the events one command at a time, in cursor order, to the subscriber (the row's subscriber, or `route(event, source)` for a routed row). Consecutive deliveries to one subscriber queue in its mailbox, so turn batches can commit them together;
  4. settles with one fenced statement: `delivered` becomes the last settled cursor, `attempts = 0`, and `due_at_ms` is set to now if more matching events exist and to null otherwise. The existence check is part of the statement, so an event whose commit races the settle is either seen or has already re-marked the feed.
- **Delivery concurrency.** Subscription deliveries use their own per-runner slots (`relay.subscriptionConcurrency`, default 16). A backlog of subscriptions can't delay intents, timers, or cron.
- **Cost.** A burst of commits on one source coalesces into one expansion. With N subscribers and E events, the relay makes N × E delivery turns. That is the unavoidable work, and it is spread across runners because each subscription row is claimed independently.

### 4. Cursors, receipts, and at-least-once transport with exactly-once effect

- **Transport is at least once.** The relay may deliver a delivery twice: after a lease expires, after a crash before the settle, or from a stale runner.
- **The effect on the subscriber is exactly once per `(subscription, source, cursor)`.** Two mechanisms enforce it.
  - **The derived command id and its receipt.** The id is a UUIDv8 whose 122 free bits come from SHA-256 over the canonical encoding `["subscription/v1", tenant, subscriber type, subscription tag, subscriber id, source type, source id, kind, cursor]`, where `kind` is `event` or `gap`. The receipt's payload hash binds that same identity, not the event's re-encoded bytes, so a redelivery after a schema-compatible deploy replays instead of failing with `CommandConflict`. Two subscriptions, or two subscribers of one source, never share an id.
  - **The subscriber-side cursor.** Admission reads `actor_subscription_cursors` in the same round trip as the generation fence and the receipt. If `applied ≥ cursor`, the delivery is acknowledged as `AlreadyApplied` without running the handler. Otherwise the handler runs, and the commit statement sets `applied = cursor`, again with no extra round trip. The cursor row never expires. Deduplication therefore survives receipt pruning, and a stale runner's out-of-order redelivery can't run an older event after a newer one.
- **Declared failures advance the cursor.** The event was handled with a typed outcome, as for an intent. The failure receipt commits with `applied = cursor`.
- **Defects and retryable failures don't.** A deterministic defect, `ActorUnavailable`, `RunnerAtCapacity`, or a timeout leaves the row claimed. It is redelivered with backoff, `max(claimLease, min(1 s × 2^(attempts − 1), relay.maxBackoff))`, which is ADR 0021's intent rule.
- **Settle outcomes.** A delivery answers the relay with `Applied`, `AlreadyApplied`, `Unsubscribed` (dynamic, no cursor row: the relay deletes the source row), or `NotCreated`. `NotCreated` means a routed subscriber whose `createdBy` policy refuses creation; the relay advances past the event and counts it in `durable-actors.subscription.skipped`. Each outcome except a retryable failure advances `delivered`.
- **Derived ids are internal.** They can't be admitted from outside: an external caller presenting one reaches an `internal` command and is a deterministic defect ([contract 10](../contracts/10-security.md)). The external retry horizon doesn't apply, because a delivery is trusted recovery of committed work ([contract 04](../contracts/04-receipts.md)).

### 5. Ordering per publisher

- **Within one subscription and one source, delivery follows the source's cursor order,** across every event class the subscription names, with at most one delivery in flight. A subscription row is claimed by one runner at a time, and the subscriber cursor refuses anything at or below `applied`. So `OrderPlaced` is always applied before a later `OrderCancelled` from the same order.
- **Nothing else is ordered.** Deliveries from different sources, including fan-in to one subscriber, interleave arbitrarily. So do different subscriptions from one source, and a subscription delivery and an ordinary command. A subscriber that needs a cross-source order must carry it in the events, for example as a timestamp or a sequence from a coordinator.
- **A delivery that keeps failing blocks only its own `(subscription, source)` row.** Later events wait behind it ([section 6](#6-backpressure-and-poison-deliveries)). Other sources, other subscriptions, and the publisher are unaffected.

### 6. Backpressure and poison deliveries

- **The publisher is never slowed by its subscribers.** Its commit is O(1) (section 3). Nothing a subscriber does blocks, fails, or delays a publisher turn.
- **A slow subscriber throttles itself.** Its deliveries are ordinary commands, so they wait in its mailbox and turn loop. `RunnerAtCapacity`, `MailboxFull`, and timeouts back the row off with the capped backoff.
- **Lag is measured, not bounded.** `durable-actors.subscription.lag` reports events and milliseconds behind the source's head for each row that has one or more undelivered matching events. The retention hold bounds how far a subscriber can lag before a `RetentionGap` ([section 7](#7-retention-and-keepevents)). M4.3 adds an alert on rows with `attempts ≥ 8`, as for intents.
- **A poison event is retried, not skipped.** One that makes the handler defect every time blocks its row with backoff capped at `relay.maxBackoff` (256 s), and `last_error` records the cause. Skipping would break the ordering guarantee without telling anyone. Operator skip (`durable subscriptions skip <row> --through <cursor>`) is an M4 operator capability ([open question 6](#q6-poison-deliveries)).
- **No drop policy exists.** No setting sheds deliveries under load. Live, lossy fan-out is what connections and streams are for ([ADR 0023](0023-connections-parking-and-streams.md)).

### 7. Retention and `keepEvents`

- **Subscriptions hold back pruning, but only for a bounded time.** The M1.9 retention loop doesn't delete a source's event whose sequence is above the smallest `delivered` among that source's subscription rows. The hold ends once the event is older than `keepEvents` plus the source's `policy.holdEventsForSubscribers` (default `"7 days"`). After that the event is pruned like any other.
- **This combines with workflow holds.** Pruning stops at the smaller of this bound and [ADR 0022](0022-workflow-engine-storage-and-version-markers.md)'s open-execution bound. It reads only rows on the source's shard.
- **A gap is delivered, never skipped.** If a subscription's next matching event has been pruned, the relay delivers `{ _tag: "RetentionGap", after: delivered, resumeAfter: oldest retained − 1 }` under a `gap` id and moves `delivered` to `resumeAfter`. The handler decides how to resynchronize. It might mark itself stale and start a workflow that reads the source's state through a query, or stage an intent asking the source to re-publish a snapshot event.
- **The gap ends in the gap's own commit.** A declared failure in the gap handler still commits and moves past the gap, like any delivery.
- **A new `"start"` subscription** to a source whose history is already pruned begins with a `RetentionGap` from cursor 0.
- **Metric.** `durable-actors.subscription.pinned_events` reports how many events subscriptions hold back.

### 8. Authorization and tenancy

- **Same tenant only, by construction.** Every row carries the source's `tenant_id`. `route` returns only an id, and `turn.subscribe` takes only an id and uses the turn's tenant. No API accepts a tenant, so a cross-tenant subscription can't be expressed. Cross-tenant fan-in, such as an operator dashboard over every tenant, belongs to `Fleet.view` ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)).
- **Sources may restrict their subscribers.** Within a tenant, any actor type in the deployment may subscribe to any event a source lists in `events`. The framework is trusted application infrastructure ([contract 10](../contracts/10-security.md)), and the `authorize` hook governs external callers, not System deliveries. A source may narrow this with `policy.subscribers: [CustomerSummary, Dashboard]`. `Actor.make` then fails for a subscriber declaration it excludes. The check is static, because every subscription, dynamic ones included, is declared on its subscriber.
- **Handlers are internal.** They are absent from handles, HTTP, OpenAPI, and the Promise client. A non-System caller reaching one is a deterministic defect.
- **Revocation doesn't stop a subscription.** It is accepted durable work between two actors ([ADR 0004](0004-receipt-access-revocation-and-expiry.md)). An application stops one with `turn.unsubscribe`, or by removing the declaration.

### 9. Composition with workflow `waitFor`

`waitFor` stays owner-only ([contract 05](../contracts/05-messaging.md), [ADR 0022](0022-workflow-engine-storage-and-version-markers.md)). A workflow that waits for a foreign event gets it through its owner. The owner subscribes, and its handler emits an owner event that the workflow waits for:

```ts
const PaymentUpdates = Actor.subscription("PaymentUpdates", {
  source: Payment,
  events: [PaymentSettled],
  handler: OnPayment,
})

// The turn that starts the workflow also subscribes, so both commit together.
PlaceOrder: Effect.fn(function* (order) {
  const turn = yield* Shipment.Turn
  yield* turn.subscribe(PaymentUpdates, order.paymentId, { from: "start" })
  yield* (yield* Shipment.intents(turn.id)).Ship(order)
})

OnPayment: Effect.fn(function* (delivery) {
  const turn = yield* Shipment.Turn
  if (delivery._tag === "RetentionGap") return yield* turn.emit(new PaymentUnknown({}))
  yield* turn.emit(new PaymentSeen({ paymentId: delivery.source.id }))
  yield* turn.unsubscribe(PaymentUpdates, delivery.source.id)
})

// In the Ship workflow body:
const paid =
  yield *
  wf.waitFor(PaymentSeen, { where: (e) => e.paymentId === order.paymentId, timeout: "1 day" })
```

The delivery is a turn on the owner, so its `emit` takes ADR 0022's emit-path wait lookup. A wait sees owner events from the execution's cursor, so a delivery that lands before the body reaches `waitFor` still resolves it. No new race exists, and the engine needs nothing new.

### 10. Composition with connections and waking parked subscribers

This section is agreed with ADR 0023's owner (DURA-27).

- **Delivery wakes a sleeping or parked subscriber.** A delivery is an ordinary System command turn through the subscriber's command entity, like any relay-delivered intent. It activates a hibernated subscriber, or a parked one, on its current owner. This is the durable wake path. It needs no runner-to-runner message: the committing runner's relay wakes locally, and any runner's poll is the correctness path ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 6).
- **The handler has the full `X.Turn`, including `turn.broadcast(Member, frame, { except?, to? })`.** Frames flush after commit to the subscriber's parked connections through their holders, and a declared failure or rollback discards them. ADR 0023 stamps each frame with the subscriber's own event cursor at commit. A client that must not miss a projected change follows the subscriber's events and resynchronizes from that stamp. `delivery.cursor`, the source's cursor, is available to put in a frame's payload.
- **A `RetentionGap` delivery is a turn too**, so it can broadcast a resync hint.
- **Broadcast stays best-effort.** Whether a broadcast wakes a parked actor is ADR 0023's decision. Subscriptions are the durable way to wake an actor on another actor's change, and they don't depend on that decision.

## Open questions and recommended defaults

Each question has a recommended default that this ADR already uses. The PR asks Dallen to decide each one; "accept all defaults" accepts the ADR as written. Every question lists its conformance cases and failure-matrix rows for the build, and the `subscriptions` benchmark case that measures it.

### Q1. Declaration API

**Default:** a `subscriptions: [...]` section of `Actor.subscription` members on the subscriber, with the handler an `internal` command taking `Actor.Delivery(S)`. `route` makes a subscription routed; without it, the subscription is dynamic.

**Alternatives:**

- `policy.subscribe: { … }` puts behaviour in `policy`, which holds settings.
- A standalone `Actor.subscribe(Source, Event, { to, key })` call outside the definition breaks the one-object rule of [ADR 0010](0010-one-way-effect-native-api.md).
- An inline `onEvent` handler would be a second kind of handler; the handler is a command, as cron and effect routes are.

**Example:** section 1.

**Conformance:** `rejects an event class the source doesn't declare`, `rejects a handler whose input doesn't accept the delivery` (type tests), `rejects duplicate subscription tags at Actor.make`, `routes each event to the id route returns`, `routes to the tenant's singleton with route: Actor.singleton`.

**Failure rows:** **Route throws or returns an id the key schema rejects**. The row backs off with `last_error`, and later events wait. It is a deterministic defect.

**Benchmark:** `subscriptions/commit-to-delivery` (one routed subscriber).

### Q2. Dynamic subscribe and unsubscribe

**Default:** `turn.subscribe(S, id, { from })` and `turn.unsubscribe(S, id)` on `X.Turn`, as staged outbox `control` rows, fenced by epoch. `from` defaults to `"now"`. Unsubscribing takes effect when the subscriber's turn commits.

**Alternative:** a request/reply `subscribe` call to the source. It is forbidden inside a turn, and it would wake the source.

**Example:** section 2.

**Conformance:**

- `delivers events committed after the registration and none before, with from: "now"`
- `replays retained history with from: "start" and reports a gap when it was pruned`
- `resumes after an explicit cursor`
- `stages nothing when the subscribing turn fails with a declared error`
- `runs no handler for a delivery in flight when unsubscribe commits`
- `keeps the newest epoch when subscribe and unsubscribe control rows are delivered out of order`
- `removes an orphan source row on an Unsubscribed acknowledgement`
- `subscribes to a source that has never been created, and delivers its first event`

**Failure rows:** **Subscribe and unsubscribe controls delivered out of order**; **Relay dies after the control claim, before the registration statement**.

**Benchmark:** `subscriptions/subscribe-churn` (subscribe and unsubscribe turns per second, and control rows per operation).

### Q3. Where fan-out happens

**Default:** at relay time. The publisher's commit adds at most one keyed `feed` row, through a CTE in the append statement. Expansion and delivery run on any runner, per subscription row.

**Alternative:** commit-time fan-out, with one outbox row per subscriber in the publisher's turn. It is simpler and has one hop less latency. But its cost grows with subscribers: the baseline above shows 115 ms p50 at 1,024 subscribers on Postgres, against 2.5 ms at one. It holds the publisher's row lock for that long, and it multiplies the publisher's WAL.

**Example:** none; this is internal.

**Conformance:**

- `writes one feed row per publishing turn whatever the subscriber count`
- `writes no feed row for an actor with no subscriptions`
- `loses no wake when a commit races a settle or an expansion` (Postgres, paused at `afterClaim`)
- `claims a source's subscriptions on several runners` (harness)
- `leaves the publisher's statement count unchanged` (T2 gate)

**Failure rows:** **Commit races subscription settle**; **Relay dies after claiming a feed row, before expansion** (the feed is expanded after the lease ends).

**Benchmark:** `subscriptions/publish-with-<n>-subscribers` for n = 1, 16, 256, and 1,024, against this branch's `intent-fanout-<n>` baseline. The publisher's p50 must stay flat across n, within 10% of `events/append-1`.

### Q4. Cursors and delivery guarantees

**Default:** at-least-once transport with exactly-once effect per `(subscription, source, cursor)`. The derived command id and its receipt deduplicate first. The subscriber-side `applied` cursor, which never expires, deduplicates after receipt pruning and against stale runners. Declared failures advance the cursor.

**Alternative:** receipts alone. That needs cleanup to keep delivery receipts for as long as the source-side row might redeliver, which can't be checked, because the two rows are on different shards.

**Example:** section 4.

**Conformance:**

- `applies each committed source event once across a relay crash before and after the subscriber's commit` (SIGKILL on Postgres)
- `acknowledges a redelivery whose receipt was pruned without running the handler`
- `refuses a stale runner's delivery below the applied cursor after a lease takeover`
- `advances past a declared failure and replays its receipt`
- `derives distinct command ids for two subscriptions and two subscribers of one source`
- `replays after a schema-compatible deploy instead of CommandConflict`
- `delivers nothing for a rolled-back source turn` (E1)

**Failure rows:** **Subscriber crashes after delivery commit**, **Relay dies after claiming a subscription row**, **Stale runner delivers after a lease takeover**, **Receipt pruned before a late redelivery**, **Source turn rolls back**.

**Benchmark:** `subscriptions/commit-to-delivery` (p50, p99, and statements per delivered event against `outbox/delivery-sequential`) and `subscriptions/drain-<n>` (a backlog of n due deliveries across 64 subscribers).

### Q5. Ordering

**Default:** source-cursor order within one `(subscription, source)`, across the subscription's event classes, with one delivery in flight. Nothing else is ordered.

**Alternative:** ordering per subscriber across sources, which needs a global sequence. [ADR 0006](0006-scale-rules-placement-and-query-tiers.md) prohibits one.

**Example:**

```ts
// OrderPlaced is always applied before a later OrderCancelled from the same order.
RecordOrder: Effect.fn(function* (d) {
  if (d._tag !== "Event") return
  const turn = yield* CustomerSummary.Turn
  yield* turn.state.set(apply(turn.state, d.source.id, d.event))
})
```

**Conformance:**

- `applies one source's events in cursor order under redelivery and two runners`
- `holds later events behind a failing one on the same row only`
- `interleaves two sources without blocking each other`

**Failure rows:** **Poison delivery blocks one subscription** (other rows and the publisher keep moving).

**Benchmark:** `subscriptions/fan-in-<n>` (10^4 sources emitting to one subscriber: throughput, and the subscriber's turn batch size).

### Q6. Poison deliveries

**Default:** retry with capped backoff and never skip automatically. Operator skip is an M4 capability. Alternatives are a per-subscription `onDefect: "skip"`, or a dead-letter route like effects'. Both silently break ordering for the events after the skipped one. A skip is a decision a person makes.

**Example:**

```sh
durable subscriptions list --lagging          # rows with attempts >= 8, their last_error and lag
durable subscriptions skip <row> --through <cursor> --reason "bad payload from v1.4"
```

**Conformance:** `retries a defecting delivery with capped backoff and records last_error`; `lets other subscriptions of the same source proceed`. M4 adds `requires operator authority to skip, records the skip, and delivers a RetentionGap-style marker`.

**Failure rows:** **Poison delivery blocks one subscription**.

**Benchmark:** `subscriptions/lag-with-one-poison-row`. The other rows' lag stays within one poll of the healthy case.

### Q7. Retention and `keepEvents`

**Default:** subscriptions hold back pruning for up to `policy.holdEventsForSubscribers` (`"7 days"`) past `keepEvents`, and then the subscriber gets a `RetentionGap`. The alternatives are an unbounded hold, where one dead subscriber grows a source's history forever, and no hold, where a routine outage turns into gaps.

**Example:**

```ts
Actor.make("Order", { …, policy: { keepEvents: "30 days", holdEventsForSubscribers: "7 days" } })
```

**Conformance:**

- `keeps events above the lowest subscriber cursor inside the hold`
- `prunes past the hold and delivers one RetentionGap, then resumes`
- `holds for the smaller of the subscription and workflow bounds`
- `reports RetentionGap first for a from: "start" subscription after pruning`

**Failure rows:** **Source events pruned before delivery**, **Retention races a delivery claim** (pruning and a claim interleave; the delivery sees either the event or the gap, never a skip).

**Benchmark:** `subscriptions/prune-beside-<n>-subscriptions` (retention pass time with 10^4 subscription rows on one source).

### Q8. Authorization and tenancy

**Default:**

- Same-tenant only, by construction.
- Open within a tenant for declared events, with `policy.subscribers` as a static allow-list on the source.
- System caller `source: "subscription"`, with no `onBehalfOf`.

**Alternatives:**

- Rivet's runtime `canSubscribe` hook needs a live check per registration and can't cover routed subscriptions.
- Propagating the emitter's principal would store principals on every event.

**Example:**

```ts
Actor.make("Payment", { …, policy: { subscribers: [Shipment, Ledger] } }) // anything else fails at Actor.make
```

**Conformance:**

- `keeps equal source ids in two tenants apart` (S2)
- `rejects a subscriber excluded by policy.subscribers at Actor.make`
- `dies deterministically when a non-System caller reaches a subscription handler`
- `continues a subscription after the subscribing caller's access is revoked` (H2)
- `records System subscription attribution on the delivery`

**Failure rows:** **Cross-tenant or unauthorized subscription attempt** (can't be expressed, or fails at startup; no rows are written).

**Benchmark:** none. This is a declaration check.

### Q9. Composition with workflow `waitFor`

**Default:** `waitFor` stays owner-only. Foreign events arrive through the owner's subscription handler re-emitting an owner event (section 9). The alternative is to let `waitFor` name a foreign source. That would put a cross-shard read on the resume path, and it would duplicate subscriptions inside the engine.

**Example:** section 9.

**Conformance:** `resolves an owner wait from a subscription delivery that re-emits`, `resolves when the delivery lands before the body reaches waitFor`, `subscribes in the workflow's start turn and delivers after the start commits`.

**Failure rows:** the existing **Event races workflow wait registration**, run with the event arriving through a delivery.

**Benchmark:** `workflow` (ADR 0022). A wait resolved through a subscription adds one `commit-to-delivery` to the resume latency.

### Q10. Composition with connections, and waking parked subscribers

**Default:** a delivery is an ordinary command turn that wakes the subscriber, and its handler broadcasts with `turn.broadcast`. ADR 0023 stamps frames with the subscriber's cursor. This is agreed with DURA-27.

**Example:**

```ts
RecordOrder: Effect.fn(function* (d) {
  const turn = yield* CustomerSummary.Turn
  if (d._tag === "RetentionGap") return yield* turn.broadcast(Live, { resync: true })
  yield* turn.state.set(apply(turn.state, d.source.id, d.event))
  yield* turn.emit(new SummaryChanged({ total: turn.state.total }))
  yield* turn.broadcast(Live, { total: turn.state.total }) // flushed after commit
})
```

**Conformance:** `wakes a hibernated subscriber and commits the delivery`; `delivers to a subscriber parked on another runner and flushes its broadcast to a parked connection` (harness); `discards a delivery's broadcast on declared failure`.

**Failure rows:** **Subscriber hibernated or parked when an event commits** (woken by the delivery; nothing lost).

**Benchmark:** `subscriptions/commit-to-delivery-hibernated` (lag including activation).

### Q11. Migration number and build order

**Default:** `0016_subscriptions`, built in wave 4 as #94 (DURA-22's #97 moved it from M3.7, wave 6). The build depends on M2.4's `0011_relay` (claims, the kind index, `scheduled_at_ms`) and M1.9's `0010_retention` (pruning bounds). It doesn't depend on workflows or connections. The migrator skips ids at or below the latest one applied, so `0016` must land after `0012`–`0015`, or the reservations are renumbered under the roadmap's rule.

## Behaviour changes against existing contracts

| Document                                                  | Today                                                                     | After this ADR                                                                                                                                                 | Section |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| [Contract 04](../contracts/04-receipts.md)                | Every command id is minted by a handle or client                          | Framework deliveries may carry ids derived from the durable record they deliver; derived ids are internal. Subscription receipts bind the delivery's identity. | 4       |
| [Contract 05](../contracts/05-messaging.md)               | Events are owner-scoped; only the owner's queries and workflows read them | Declared subscriptions deliver committed events to other actors in the same tenant, in cursor order per source, as System command turns                        | 1–5     |
| [Contract 07](../contracts/07-realtime.md)                | Durable event subscriptions use a cursor (client feeds)                   | The same rules cover actor-to-actor subscriptions: cursor order per source and explicit `RetentionGap` deliveries                                              | 5, 7    |
| [Contract 10](../contracts/10-security.md)                | System sources are intents, effect routes, and cron                       | Adds `subscription`; subscriptions are same-tenant by construction; `policy.subscribers` restricts subscriber types                                            | 8       |
| [Retention](../operations/retention.md)                   | Pruning covers replay cursors and workflow waits                          | Pruning also stops at subscriber cursors, for at most `holdEventsForSubscribers` past `keepEvents`                                                             | 7       |
| [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) | The relay claims `intent` and `effect` rows                               | Also `feed` and `control` rows and subscription rows, with their own delivery slots                                                                            | 3       |

## Alternatives

| Choice           | Rejected option and reason                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery path    | Broadcast or a live stream to the subscriber: best-effort, and needs the subscriber awake. `LISTEN/NOTIFY`: prohibited by ADR 0006, and not durable.                                                                    |
| Fan-out          | One outbox row per subscriber at commit: publisher cost grows with subscribers (see the baseline). A single feed row that one runner fans out alone: one slow subscriber stalls a source's whole fan-out on one runner. |
| Cursor authority | Source-side cursor plus receipts only: depends on receipt retention that can't be checked across shards. Subscriber-side cursor only, with no source row: the relay couldn't find due work without scattering.          |
| Batch deliveries | Many events per handler call: ids per batch make stale redelivery unsafe unless batch bounds are fixed, and the handler shape differs from every other command. Turn batches give the throughput instead.               |
| Registration     | A turn on the source to register: wakes the source and runs a framework command in its mailbox. The framework statement under `FOR SHARE` closes the same race without activation.                                      |
| Scope            | Cross-tenant subscriptions: break tenant isolation; `Fleet.view` serves cross-tenant reads.                                                                                                                             |

## Consequences

- An actor can follow other actors' committed history and be woken for each new event, with exactly-once effect and per-source order, without the publisher knowing about it or paying for it.
- Each delivered event costs one subscriber turn plus relay statements, roughly an intent delivery. Fan-out volume is N × E turns.
- `actor_subscription_cursors` grows with the number of `(subscriber, source)` pairs ever delivered. Rows are small and are deleted on unsubscribe, but a routed fan-in subscriber keeps one per source. This is accepted; revisit it with actor deletion.
- Routed subscription rows exist per source actor that has emitted a matching event, like cron rows per actor.
- A new routed declaration doesn't backfill history. It starts at each source's next matching commit. Backfill is a dynamic `from: "start"` subscription or a workflow.
- Removing a declaration in a deploy leaves its rows. As with cron rule 1 of ADR 0021, a runner that registers the subscriber type but lacks the declaration releases the row with backoff. It deletes the row once the row has been due for longer than one day, so a rolling deploy never loses a new declaration's rows.

## Amendments

In this change:

- [Contract 04](../contracts/04-receipts.md): derived framework command ids and the subscription receipt binding.
- [Contract 05](../contracts/05-messaging.md): cross-actor subscriptions.
- [Contract 07](../contracts/07-realtime.md): actor-to-actor subscriptions follow the cursor and gap rules.
- [Contract 10](../contracts/10-security.md): the `subscription` System source, same-tenant scope, and `policy.subscribers`.
- [Retention](../operations/retention.md): subscriber holds.
- [Server API](../api/01-server-api.md) and [context](../api/02-context.md): `subscriptions`, `Actor.subscription`, `Actor.Delivery`, `turn.subscribe`, `turn.unsubscribe`, and the two policies (target API).
- [Data model](../architecture/data-model.md), [transaction catalog](../architecture/transaction-catalog.md), and [glossary](../GLOSSARY.md).
- [Conformance](../verification/01-conformance.md): the **Subscription delivery** gate and decision check. [Failure matrix](../verification/02-failure-matrix.md): the new rows. [Invariants](../verification/invariants.md): E2. [Performance](../verification/03-performance.md): the baseline.

## Required evidence (#94, `conformance/subscriptions.ts`, migration `0016_subscriptions`)

- The conformance cases named under Q1–Q10 run on PGlite and Postgres. Crash, contention, and race cases run on Postgres only. Multi-runner cases run on the M2.1 harness.
- Fault points `beforeSettle` (after the subscriber's commit, before the source-side settle) and `afterExpand` are added to `TurnHooks` and `crashNext`/`pauseNext`.
- **Due-work scans:** `EXPLAIN (ANALYZE, BUFFERS)` of the subscription claim beside 10^5 caught-up subscription rows reads none of them, and relay scan time stays within 10% of the empty case.
- **Failure-matrix rows added in this change:**
  - **Subscriber crashes after delivery commit**
  - **Source events pruned before delivery**
  - **Source turn rolls back**
  - **Relay dies after claiming a subscription row**
  - **Stale runner delivers after a lease takeover**
  - **Receipt pruned before a late redelivery**
  - **Commit races subscription settle**
  - **Poison delivery blocks one subscription**
  - **Subscribe and unsubscribe controls delivered out of order**
  - **Route throws or returns an invalid id**
  - **Retention races a delivery claim**
  - **Subscriber hibernated or parked when an event commits**
  - **Cross-tenant or unauthorized subscription attempt**
- **Invariant:** E2, "each committed source event takes effect once per subscription, in source cursor order, or is reported as a gap".
- **Benchmark:** `subscriptions`, extending this branch's `intent-fanout-<n>` baseline with these cases:
  - `commit-to-delivery` and `commit-to-delivery-hibernated`
  - `publish-with-<n>-subscribers`
  - `drain-<n>`
  - `fan-in-10000`
  - `subscribe-churn`
  - `lag-with-one-poison-row`
  - `prune-beside-<n>-subscriptions`

  Run them on 1, 2, and 4 runners where they apply. The publisher's statement count per turn must match the T2 baseline for actor types without subscribers.

## Revisit conditions

- The relay's expansion, or one source with more than 10^5 subscriptions, shows up in relay scan time. That would call for tiered fan-out, or for pushing broadcast-scale fan-out to connections.
- Measured commit-to-delivery latency needs sub-poll wakes across runners, which ADR 0021 declined.
- A workload needs cross-source ordering, or events delivered in batches to one handler call.
- Actor deletion lands. It must delete an actor's subscription rows and cursor rows in its transaction.
- Rivet's announced subscription feature, once located, changes the comparison.
