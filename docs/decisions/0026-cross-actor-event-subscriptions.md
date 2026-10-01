# ADR 0026: Cross-actor event subscriptions

**Status:** accepted (2026-09-26, Dallen, with every recommended default; proposed 2026-09-26). It amends [contract 04](../contracts/04-receipts.md), [contract 05](../contracts/05-messaging.md), [contract 07](../contracts/07-realtime.md), [contract 10](../contracts/10-security.md), and [retention](../operations/retention.md). It builds on the outbox ([ADR 0011](0011-direct-commands-outbox-and-performance.md)) and the multi-runner relay ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md)). The amendments listed under [Amendments](#amendments) land in the same change.

**Responsibility:** decide how one actor follows another actor's committed events and is woken durably when a new one commits, even while it sleeps, so that the build unit ([#94](https://github.com/Rika-Labs/durable-actors/issues/94), migration `0017_subscriptions`) has no open design questions.

**Authority:** design decision record.

**Owner role:** runtime and realtime architecture.

**Change policy:** supersede through a new ADR.

## Context

`turn.emit` appends an event in the emitting turn's transaction, with a gap-free, never-reissued cursor per actor (M1.5, [contract 05](../contracts/05-messaging.md)). Today the only readers are the owner's queries (`read.events`), workflow waits on the owner's own events (`Ship.wait`) ([ADR 0022](0022-workflow-engine-storage-and-version-markers.md)), and live streams and connections ([ADR 0023](0023-connections-parking-and-streams.md)). Nothing lets a different actor react to those events. An application that needs one has two options, and both are wrong:

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
- **Actor-to-actor events use a connection.** The documented pattern is for the subscriber to open a connection to the publisher and register `conn.on(...)` handlers inside an action ([Communicating between actors, "Event-Driven Architecture"](https://rivet.dev/actors/docs/communicating-between-actors/)). The idle rule counts inbound connections, so the publisher stays awake while subscribers are connected. The subscriber's outbound connection doesn't keep it awake, just as an outbound `fetch` doesn't ([Lifecycle, "Sleeping"](https://rivet.dev/actors/docs/lifecycle/)). So the subscriber can sleep and drop the connection, and events are lost across a crash, a move, or sleep.
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
- **One source-to-subscriber pair is sequential.** It has one delivery in flight, so it runs at one relay-to-turn-to-settle cycle per event, several milliseconds each.
- **Write amplification.** Each delivery writes a receipt and a cursor row.
- **Scope is narrower.** Subscriptions are same-tenant and one-region, and a client subscribes through connections or SSE, not through this mechanism.
- **Rivet and Durable Objects run at the edge**, which this deployment model doesn't.

### Measured starting point

The new `subscriptions` scenario measures hand-rolled fan-out: a publisher turn that stages one intent per subscriber, which is the commit-time fan-out this ADR rejects. The intents fall due in a day, so only the publisher's turn is timed. The results are in [`addc1db-adr-0026-baseline`](../../benchmarks/results/2026-09-26-addc1db-adr-0026-baseline-postgres.json), with a same-SHA repeat as the noise reference, and [performance](../verification/03-performance.md#cross-actor-subscriptions-baseline) summarizes them. The handler generates the intent ids, so the command payload is the same size at every n. On Postgres 18.6 (one 4-vCPU VM, one publisher):

| Subscribers | Publisher turn p50 (run / repeat) | p99 (run / repeat) | Publishes/s | Statements per turn | Client-process CPU per turn |
| ----------: | --------------------------------: | -----------------: | ----------: | ------------------: | --------------------------: |
|           1 |                      2.5 / 2.6 ms |       8.6 / 8.5 ms |         334 |                8.01 |                      2.9 ms |
|          16 |                      8.9 / 4.2 ms |     15.8 / 12.7 ms |         112 |                8.02 |                      8.3 ms |
|         256 |                    33.1 / 33.5 ms |     53.3 / 54.2 ms |        30.8 |                8.07 |                     34.2 ms |
|       1,024 |                    83.4 / 86.3 ms |   157.6 / 152.4 ms |        12.1 |                8.19 |                     80.8 ms |

The 16-subscriber case is noisy between runs; the others agree within 4%. The statement count barely moves, because the rows go in one multi-row insert, so the T2 statement gate wouldn't catch this growth. The cost is mostly CPU in the client process, which holds the runtime and the benchmark driver: about 80 µs per staged intent. The publisher holds its generation row lock and its activation for all of it, so latency, lock hold time, and WAL grow roughly linearly with subscribers.

## Decision

A subscription is a declared member of the subscriber. Each committed event of the declared classes from a matching source reaches the subscriber's internal handler command as an ordinary command turn. The relay delivers it through the same claim, lease, and receipt path as an outbox intent. The publisher's turn pays a constant cost, whatever the number of subscribers. The relay does the fan-out after commit, on the source's shard.

### 1. Declaration: `Actor.subscription` in a `subscriptions` section

```ts
import { Actor } from "durable-actors"

// The handler's input names only the source and the event classes, so the command
// can be declared before the subscription that references it.
export const RecordOrder = Actor.command("RecordOrder", {
  input: Actor.Delivery({ source: Order, events: [OrderPlaced, OrderCancelled] }),
})

// Routed: every OrderPlaced or OrderCancelled from any Order in the tenant reaches
// the CustomerSummary named by the event. Order doesn't know CustomerSummary exists.
export const CustomerOrders = Actor.subscription("CustomerOrders", {
  source: Order,
  events: [OrderPlaced, OrderCancelled],
  handler: RecordOrder,
  route: (event) => event.customerId,
})

export const CustomerSummary = Actor.make("CustomerSummary", {
  key: CustomerId,
  state: SummaryState,
  events: [SummaryChanged],
  internal: { RecordOrder },
  subscriptions: [CustomerOrders],
})
```

- **Declaration.** `Actor.subscription(tag, { source, events, retired?, handler, route? })` declares a subscription.
  - `source` is an actor definition.
  - `events` is a non-empty list of that source's declared event classes. A class the source doesn't list fails to compile.
  - `handler` is a command in the subscriber's `internal` section. Its input must accept `Actor.Delivery({ source, events })` for the same source and classes, which is checked like an effect's `onSuccess` route.
  - Tags are unique within the subscriber's `subscriptions`.
  - Nothing in the declaration refers back to the subscriber, so the declaration has no import cycle.
- **Routed subscriptions.** A subscription with `route` is routed. `route(event, source: ActorRef)` is a pure function that returns the subscriber's id, which the subscriber's key schema checks. A singleton subscriber uses `route: Actor.singleton`, which sends every matching event in the tenant to the tenant's singleton. That is the fan-in dashboard. A routed subscription follows every actor of the source type in the tenant, starting at each source's first matching commit on a runner that registers the declaration ([section 3](#3-fan-out-at-relay-time-not-at-commit)). It doesn't backfill.
- **Dynamic subscriptions.** A subscription without `route` is dynamic. It follows only the source instances that a subscriber's turn subscribes to ([section 2](#2-dynamic-subscribe-and-unsubscribe-from-a-turn)).
- **Only subscription deliveries reach a handler.** A command named as a subscription's `handler` accepts only the caller `System({ source: "subscription" })`. `X.intents(id)` doesn't expose it, so no other actor can stage a forged delivery, and a caller of any other kind that reaches it is a deterministic defect. The handler therefore can't be reached around the subscriber's cursor or its route.
- **The handler receives one delivery per turn**, as `Actor.Delivery`:

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
      readonly after: string // the position this subscription had reached
      readonly resumeAfter: string // the next delivery comes after this cursor
    }
  | {
      readonly _tag: "Rejected" // a dynamic subscription the source refused; it is no longer active
      readonly subscription: string
      readonly source: ActorRef
      readonly reason: "UnknownCursor"
      readonly cursor: string
    }
```

- **The handler runs in `X.Turn`.** It can do everything any command handler can: set state, write rows, emit its own events, stage intents, perform effects, subscribe or unsubscribe, and broadcast.
- **The delivery's command id** is derived ([section 4](#4-cursors-receipts-and-at-least-once-transport-with-exactly-once-effect)). Its caller is `System({ source: "subscription", ref: <source ref> })`, with no `onBehalfOf`: events don't store their emitter's principal. A handler that needs attribution reads it from the event's fields.
- **Each delivery carries the subscription's epoch** in its envelope, beside the command id. The handler doesn't see it.

### 2. Dynamic subscribe and unsubscribe from a turn

```ts
export const OnSupplier = Actor.command("OnSupplier", {
  input: Actor.Delivery({ source: Supplier, events: [PriceChanged, Discontinued] }),
})
export const Follow = Actor.subscription("Follow", {
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
- **The subscriber's cursor row is the authority, and it keeps its epoch forever.**
  - `subscribe` upserts the row with `active = true`, `epoch = epoch + 1` (or 1 when the row is new), and `applied` set from `from`. `applied` is 0 for `"start"`, the given cursor, or −1 for `"now"`, meaning "set by the source".
  - `unsubscribe` sets `active = false` and `epoch = epoch + 1` on the row. It never deletes the row, so the epoch never goes back to an earlier value.
  - Either way, one CTE in the commit statement upserts the row, returns its new epoch, and inserts the outbox `control` row that carries the operation and that epoch. The control row is keyed with the JSON array `["$sub", tag, source type, source id]`, so a later operation replaces a pending earlier one. It is one statement, so the turn keeps ADR 0020's two groups, and no write depends on a reply from an earlier group.
- **What the relay does on the source's shard.** It claims the control row like an intent and runs one framework statement there, not a turn, so the source is never activated.
  - The statement locks the source's generation row `FOR SHARE`, which conflicts with the emit path's `FOR UPDATE` as in [ADR 0022](0022-workflow-engine-storage-and-version-markers.md) decision 5. It creates that row with `created = false` if it doesn't exist, so an actor can subscribe to a source that hasn't been created yet.
  - `subscribe` upserts the source-side row only if the stored epoch is **strictly lower** than the operation's. A rerun of the same control row after a crash is a no-op, so it can't reset `delivered`.
  - A new row's `delivered` is the source's `event_sequence` for `"now"`, 0 for `"start"`, or the given cursor.
  - In the same statement, the row is made due now if the source has an event after `delivered`, so a `"start"` or cursor subscription to a quiet source still delivers its history. The per-source tag summary is updated too ([section 3](#3-fan-out-at-relay-time-not-at-commit)).
  - `remove` never leaves the source without the newest epoch. It turns the source-side row into a tombstone at `$epoch` where the stored epoch is lower, or inserts a tombstone if no row exists. A tombstone has `active = false`, is never due, is left out of the tag summary, and doesn't hold back pruning, so a paused `subscribe` control of an older epoch that runs later finds a higher epoch and does nothing. A later `subscribe` of a higher epoch replaces the tombstone. The tag summary counts only active rows: turning a row into a tombstone decrements every tag it carries, and reactivating one increments every tag of the resulting row, even when `events` didn't change. Startup widening, expansion, and delivery claims all filter on `active`, so a tombstone is never widened, marked, or claimed. Like the subscriber's cursor row, a tombstone never expires, and there is at most one per `(subscription, source, subscriber)`.
- **`from` values:**
  - `"now"` delivers events committed after the registration reaches the source.
  - `"start"` delivers from cursor 0. If history has been pruned, the first delivery is a `RetentionGap`.
  - A cursor string resumes after that cursor. A cursor above the source's current sequence isn't registered. The relay turns any older-epoch source row into a tombstone at the new epoch, as `remove` does, so the previous epoch's row stops waking and pinning events, and delivers a `Rejected` delivery for that epoch instead. Admission lets a `Rejected` delivery through regardless of `applied` (section 4), and its commit sets the subscriber's row to `active = false`. The subscriber is told, and it never believes it is subscribed to nothing.
- **Unsubscribing takes effect in the subscriber's turn.** Once it commits, admission refuses every delivery for that row ([section 4](#4-cursors-receipts-and-at-least-once-transport-with-exactly-once-effect)). A delivery already in flight carries the older epoch, so it is acknowledged as `Stale` without running the handler. The relay then deletes the source row, but only where the source row's epoch equals the delivery's, so a stale acknowledgement can never delete a newer subscription.

### 3. Fan-out at relay time, not at commit

The source's commit writes at most one extra row, whatever the number of subscribers. Tables `0017_subscriptions` adds (target DDL; the build unit may adjust names but not placement):

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
  epoch bigint NOT NULL DEFAULT 0,      -- 0 for routed rows
  active boolean NOT NULL DEFAULT true, -- false for a tombstone (section 2)
  delivered bigint NOT NULL,            -- the source position this row has settled through
  marked bigint NOT NULL DEFAULT 0,     -- the highest source sequence an expansion has seen for this row
  bucket integer NOT NULL CHECK (bucket = routing_key >> 56),
  due_at_ms bigint,                     -- null while caught up; the lease end while claimed
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  gaps bigint NOT NULL DEFAULT 0,       -- gaps a routed row could not deliver (section 7)
  gap_at_ms bigint,                     -- first detection of the pending gap; fixes its id's timestamp
  gap_through bigint,                   -- the pending gap's resumeAfter, reused on redelivery
  PRIMARY KEY (routing_key, tenant_id, source_type, source_id, subscriber_type, subscription, subscriber_id),
  FOREIGN KEY (routing_key, tenant_id, source_type, source_id) REFERENCES actor_generations
) WITH (fillfactor = 80);
CREATE INDEX actor_subscriptions_due ON actor_subscriptions (bucket, subscriber_type, due_at_ms)
  WHERE due_at_ms IS NOT NULL;

-- On the source's shard: which event tags have at least one subscription row, so the emit probe is a key lookup.
CREATE TABLE actor_subscription_tags (
  routing_key bigint NOT NULL,
  tenant_id text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  event text NOT NULL,
  rows integer NOT NULL CHECK (rows > 0),
  PRIMARY KEY (routing_key, tenant_id, source_type, source_id, event),
  FOREIGN KEY (routing_key, tenant_id, source_type, source_id) REFERENCES actor_generations
);

-- On the subscriber's shard: what the subscriber has applied, per source. Authoritative for deduplication; never deleted.
CREATE TABLE actor_subscription_cursors (
  routing_key bigint NOT NULL,          -- the subscriber's
  tenant_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  subscription text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  epoch bigint NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  applied bigint NOT NULL,
  PRIMARY KEY (routing_key, tenant_id, actor_type, actor_id, subscription, source_type, source_id),
  FOREIGN KEY (routing_key, tenant_id, actor_type, actor_id) REFERENCES actor_generations
);

ALTER TABLE actor_outbox DROP CONSTRAINT actor_outbox_kind_check,
  ADD CONSTRAINT actor_outbox_kind_check CHECK (kind IN ('intent', 'effect', 'feed', 'control'));
```

`actor_subscription_tags` is kept in step with the rows by the statement that changes them, and only when a row is actually inserted, deleted, or widened (`RETURNING` tells it which).

- Inserting a row adds 1 to `rows` for each of its tags.
- Widening a row adds 1 for each newly added tag.
- Deleting a row subtracts 1 for each of its tags and removes a tag's entry when it reaches 0. That covers `remove`, `Stale`/`Unsubscribed`, the one-day cleanup of removed declarations, and future actor deletion.
- The #94 conformance suite checks, after each case, that every summary count equals the number of active rows carrying that tag; tombstones are never counted. A missed increment loses wakes, and a missed decrement costs feed writes forever.

The claim index leads with `subscriber_type` after `bucket`. That way a runner that doesn't register a subscriber type never scans past that type's rows, which is the property `actor_outbox_due_kind` gives effects.

**At commit (the publisher's turn).** The event-append statement gains one CTE, so the turn keeps its round trips and statement count ([ADR 0020](0020-two-round-trip-turn-pipeline.md), T2 baseline). The CTE:

1. For routed subscriptions registered on this runner that name one of the emitted tags, it inserts the missing source-side rows with `delivered` set to this turn's first sequence minus 1 (`ON CONFLICT DO NOTHING`), and adds them to the tag summary. The routed list is a bound parameter, and empty for most actor types.
2. It upserts one outbox row of kind `feed` on the source, keyed `$feed` and due now. It does so if `actor_subscription_tags` has a row for any emitted tag, or if step 1 inserted one. `ON CONFLICT` sets `due_at_ms = least(due_at_ms, now)` and `attempts = 0`, so a commit that lands while a runner holds the feed row's lease both leaves it due and breaks that runner's fence. The probe is a primary-key lookup per emitted tag, so it costs the same with no subscriptions or with 10^5.

A rolled-back or declared-failure turn emits no events, so it writes neither.

**At relay time.**

- **Expansion.** A runner claims a due `feed` row like an intent ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 1). It then expands the feed with one statement on the source's shard. For every row of that source with an event tag at or below the head `H` that it read:
  - it sets `marked = greatest(marked, H)`, even on a row that is currently claimed;
  - it sets `due_at_ms = now` only where `due_at_ms IS NULL` and a matching event exists after `delivered`. A claimed row, or a row waiting out a retry backoff, keeps its `due_at_ms`, so commits can't cut a poison row's backoff short;
  - it gives a lease instead of "now" to the rows the runner has free subscription-delivery slots for, so it claims them in the same statement.

  A source with many subscriptions is paged 1,000 rows at a time. Finally the runner deletes the `feed` row, fenced on the `attempts` value its claim wrote (always at least 1). A commit after the expansion read `H` has reset `attempts` to 0, so the delete matches nothing and the row stays due and is expanded again; that expansion may overlap the first one, which is safe because `marked` only grows and `due_at_ms` is only set where it is `NULL`.

- **Delivery.** A runner claims due subscription rows with `FOR UPDATE SKIP LOCKED` and a lease, exactly as ADR 0021 claims intents. The claim scans only `actor_subscriptions_due`, and only for subscriber types registered on the runner, so caught-up subscriptions cost nothing ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md) due-work rule). It also claims only rows whose `events` its declaration knows: `$known @> events`, where `$known` is the declaration's `events` plus its `retired` tags. A runner never scans past an event class it can't decode, so in a rolling deploy an old runner leaves a widened row due for a new one instead of settling past the new class. For each claimed row the runner:
  1. reads, in one statement (the M1.5 replay shape), up to `relay.subscriptionBatch` (default 16) matching events after `delivered`, the oldest retained sequence, and the head `H`;
  2. delivers a `RetentionGap` first if history after `delivered` was pruned ([section 7](#7-retention-and-keepevents));
  3. delivers the events one command at a time, in cursor order, to the row's subscriber, or to `route(event, source)` for a routed row. Each delivery waits for the previous one's outcome;
  4. renews the row's lease after each delivery, as ADR 0021's executors renew theirs, so a batch of slow turns never outlives its claim;
  5. settles with one statement fenced on the lease and the epoch. `delivered` becomes the position scanned through: the last delivered cursor, or `H` when the batch ended because no more events matched. `attempts` becomes 0. `due_at_ms` becomes now if a matching event exists after the new `delivered` **or** `marked > delivered`, and null otherwise.
- **No wake-up is lost.** Settle and expansion both update the same row, so row locks serialize them. Under READ COMMITTED, an `UPDATE` re-evaluates its `SET` on the newest row version it waited for. Suppose a commit lands after settle's snapshot. That commit wrote the feed row, so an expansion follows. If the expansion's update applied first, settle reads its `marked` and keeps the row due. If settle applied first, the expansion finds the row unclaimed and makes it due. `marked` is a source sequence, and `delivered` only ever records positions that were actually scanned, so `marked > delivered` never sticks as a false wake.
- **Delivery concurrency.** Subscription deliveries use their own per-runner slots (`relay.subscriptionConcurrency`, default 16). A backlog of subscriptions can't delay intents, timers, or cron.
- **Cost.** A burst of commits on one source coalesces into one expansion. With N subscribers and E events, the relay makes N × E delivery turns. That is the unavoidable work. It is spread across runners, because each subscription row is claimed independently.
- **Event lists follow the declaration, and a row's list only grows.** A deploy can add an event class to a subscription. So the claiming runner reads the classes to deliver from its own declaration, not from the row. The row's `events` and the tag summary only decide which commits wake the row. They are widened, never narrowed, in two places:
  - Step 1 of the emit CTE upserts routed rows with `ON CONFLICT DO UPDATE SET events = <union of events and the declaration's tags> WHERE NOT events @> $tags`.
  - Every settle does the same union for the claiming runner's declaration.
  - When a runner starts with a dynamic declaration, it widens that subscription's existing rows once: `UPDATE … SET events = <union> WHERE subscription = $tag AND active AND NOT events @> $tags`, 1,000 rows per statement, adding each widened row's new tags to the tag summary in the same statement. It keeps `delivered`, `epoch`, and the cursor, and it is idempotent, so every runner of a rolling deploy may run it. A widened row with a matching event after `delivered` is made due.

  An old runner in a rolling deploy therefore can't shrink a row back. A class added to a routed subscription starts at each source's first matching commit on a runner that has the new declaration. A class added to a dynamic subscription starts once the first runner with the new declaration has widened its rows, so a caught-up row whose next event is only of the new class still wakes. Events of that class after the row's `delivered` are delivered in either case, because delivery reads by position. A class removed from a declaration stays on the row, so the declaration lists its tag under `retired` (`Actor.subscription(tag, { source, events, retired?, handler, route? })`); rows carrying it stay claimable, and delivery skips that class and moves past. A class dropped without `retired` leaves its rows unclaimed and due, counted in `durable-actors.subscription.incompatible`, until a declaration that knows it is deployed.

- **One pair is sequential.** A single `(subscription, source, subscriber)` has at most one delivery in flight, so its throughput is one relay → turn → settle cycle per event, and turn batches don't help it. Turn batches help fan-in, where many rows deliver to one subscriber at once.

### 4. Cursors, receipts, and at-least-once transport with exactly-once effect

- **Transport is at least once.** The relay may deliver a delivery twice: after a lease expires, after a crash before the settle, or from a stale runner.
- **The effect on the subscriber is exactly once per `(subscription, epoch, source, cursor)`.** Two mechanisms enforce it.
  - **The derived command id and its receipt.** The id is `v1.<s>.<s + retryWindow>.<digest>`. It has ADR 0022's derived-id layout, but a different version nibble. `s` is deterministic, so a redelivery repeats the id. For an event, `s` is the event's `emitted_at_ms`. For a `RetentionGap`, `s` is the time the relay first detected the gap. The relay records that time on the row together with the gap's `resumeAfter`, fenced by the claim, and reuses both until the gap settles, so a redelivery can't report a second, overlapping gap. For a `Rejected` delivery, `s` is the control row's `scheduled_at_ms`. `digest` is SHA-256 over the canonical encoding `["subscription/v1", tenant, subscriber type, subscription tag, subscriber id, source type, source id, epoch, kind, cursor]`, where `kind` is `event`, `gap`, or `rejected`. The digest is formatted as a UUID with version nibble `8`. External admission accepts only version-4 ids, so no external caller can present a derived id and plant a receipt under it. `commandTimes` and the receipt path therefore need an internal id schema that also accepts version 8, with a conformance case (`accepts a version-8 derived id on System delivery and rejects it at external admission`). ADR 0022's activity ids are v4-shaped and so can be squatted; that belongs to ADR 0022, and isn't changed here. The receipt's payload hash binds that same identity, not the event's re-encoded bytes, so a redelivery after a schema-compatible deploy replays instead of failing with `CommandConflict`. Two subscriptions, two subscribers of one source, or two epochs of one subscription never share an id.
  - **The subscriber-side cursor.** A delivery's position is an event's `cursor` or a gap's `resumeAfter` (the `cursor` in a gap's digest is its `resumeAfter`); the table below compares and stores that position. Admission reads `actor_subscription_cursors` in the same round trip as the generation fence and the receipt, and handles the delivery by the row it finds:

    | Cursor row                                   | Outcome                                                                                                       |
    | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
    | row epoch above the delivery's               | `Stale`: acknowledged without running the handler                                                             |
    | `active = false` at the delivery's epoch     | `Unsubscribed`: acknowledged without running the handler                                                      |
    | a `Rejected` delivery at the row's epoch     | the handler runs whatever `applied` is (the receipt still deduplicates), and the commit sets `active = false` |
    | `applied ≥ position` at the delivery's epoch | `AlreadyApplied`: acknowledged without running the handler                                                    |
    | otherwise                                    | the handler runs, and the commit statement sets `applied = position` in the same round trip                   |

    A routed subscriber creates its row, at epoch 0, on its first delivery. The row never expires, so deduplication survives receipt pruning, and a stale runner can't run an older event after a newer one or deliver into a newer epoch.

  - **Late deliveries rely on the cursor.** A delivery that arrives after its id's `expiresAt` may find its receipt pruned. The cursor still refuses a repeat.
- **Declared failures advance the cursor.** The event was handled with a typed outcome, as for an intent. The failure receipt commits with `applied = cursor`.
- **Defects and retryable failures don't.** A deterministic defect, `ActorUnavailable`, `RunnerAtCapacity`, or a timeout leaves the row claimed. It is redelivered with backoff, `max(claimLease, min(1 s × 2^(attempts − 1), relay.maxBackoff))`, which is ADR 0021's intent rule.
- **Settle outcomes.** A delivery answers the relay with one of these, and each except a retryable failure advances `delivered`:
  - `Applied`.
  - `AlreadyApplied`.
  - `Stale` or `Unsubscribed`. The relay deletes the source row where its epoch equals the delivery's.
  - `NotCreated`. This means a routed subscriber whose `createdBy` policy refuses creation. Today that rejection commits no receipt, so without a rule the delivery would retry forever. The rejection therefore upserts the subscriber-side cursor row at epoch 0 with `applied = greatest(applied, cursor)`, in the round trip that read it, so a stale delivery of the same event that arrives after another command created the subscriber is `AlreadyApplied`. The row is keyed by the subscriber and lives in its shard, so no cross-shard read is needed; it is deleted with the subscriber. The relay advances past the event and counts it in `durable-actors.subscription.skipped`. Routed events for a subscriber that doesn't exist are dropped. A subscriber that must see them lists the handler in `createdBy`, so the delivery creates it. A dynamic subscriber always exists, because it subscribed in a committed turn.
- **The retry horizon doesn't apply.** A delivery is trusted recovery of committed work ([contract 04](../contracts/04-receipts.md)), so the external retry horizon doesn't bound it.

### 5. Ordering per publisher

- **Within one subscription row, delivery follows the source's cursor order,** across every event class the subscription names, with at most one delivery in flight. A subscription row is claimed by one runner at a time, and the subscriber cursor refuses anything at or below `applied`. So `OrderPlaced` is always applied before a later `OrderCancelled` from the same order.
- **Nothing else is ordered.** Deliveries from different sources, including fan-in to one subscriber, interleave arbitrarily. So do different subscriptions from one source, and a subscription delivery and an ordinary command. A subscriber that needs a cross-source order must carry it in the events, for example as a timestamp or a sequence from a coordinator.
- **A delivery that keeps failing blocks its own row.**
  - For a dynamic subscription, that row is one `(subscription, source, subscriber)`. Other sources, other subscriptions, and the publisher are unaffected.
  - A routed row serves every subscriber the source's events route to, in the source's order. So one poisoned or `MailboxFull` subscriber holds back that source's later events for the other routed subscribers too. For a projection (one source routes to one customer), that is one subscriber. For a source whose events route to many subscribers, the order would otherwise break, so that is the price of keeping it ([open question 5](#q5-ordering)).

### 6. Backpressure and poison deliveries

- **The publisher is never slowed by its subscribers.** Its commit is O(1) (section 3). Nothing a subscriber does blocks, fails, or delays a publisher turn.
- **A slow subscriber throttles itself.** Its deliveries are ordinary commands, so they wait in its mailbox and turn loop. `RunnerAtCapacity`, `MailboxFull`, and timeouts back the row off with the capped backoff.
- **Lag is measured, not bounded.** `durable-actors.subscription.lag` reports events and milliseconds behind the source's head for each row that has one or more undelivered matching events. The retention hold bounds how far a subscriber can lag before a `RetentionGap` ([section 7](#7-retention-and-keepevents)). M4.3 adds an alert on rows with `attempts ≥ 8`, as for intents.
- **A poison event is retried, not skipped.** One that makes the handler defect every time blocks its row with backoff capped at `relay.maxBackoff` (256 s), and `last_error` records the cause. Skipping would break the ordering guarantee without telling anyone. Operator skip (`durable subscriptions skip <row> --through <cursor>`) is an M4 operator capability ([open question 6](#q6-poison-deliveries)).
- **No drop policy exists.** No setting sheds deliveries under load. Live, lossy fan-out is what connections and streams are for ([ADR 0023](0023-connections-parking-and-streams.md)).

### 7. Retention and `keepEvents`

- **Subscriptions hold back pruning, but only for a bounded time.** The M1.9 retention loop doesn't delete a source's event whose sequence is above the smallest `delivered` among that source's subscription rows. The hold ends once the event is older than `keepEvents` plus the source's `policy.holdEventsForSubscribers` (default `"7 days"`). After that the event is pruned like any other.
- **This combines with workflow holds.** Pruning stops at the smaller of this bound and [ADR 0022](0022-workflow-engine-storage-and-version-markers.md)'s open-execution bound. It reads only rows on the source's shard.
- **A gap is delivered, never skipped, when there is a recipient.** If history after a row's `delivered` has been pruned, the relay delivers `{ _tag: "RetentionGap", after: delivered, resumeAfter }` under a `gap` id and moves `delivered` to `resumeAfter`.
  - `resumeAfter` is the oldest retained sequence minus 1, or the source's `event_sequence` when nothing is retained.
  - Pruning is by position, not by tag, so a gap can be reported even when none of the pruned events matched the subscription.
  - The handler decides how to resynchronize. It might mark itself stale and start a workflow that reads the source's state through a query, or stage an intent asking the source to re-publish a snapshot event.
- **Which rows can receive a gap.** Dynamic rows and routed rows with `route: Actor.singleton` always can. A routed row with an id `route` can't: `route` needs the pruned event to name a subscriber. That row increments its `gaps` column, logs `Subscription gap without a recipient`, and counts it in `durable-actors.subscription.undeliverable_gaps`. Then it resumes. The hold makes this rare: a routed row gaps only after its delivery has been blocked for longer than the hold. Id-routed projections that can't tolerate a gap need a periodic reconciliation, such as a cron that re-reads the source.
- **The gap ends in the gap's own commit.** A declared failure in the gap handler still commits and moves past the gap, like any delivery.
- **A new `"start"` subscription** to a source whose history is already pruned begins with a `RetentionGap` from cursor 0.
- **Metric.** `durable-actors.subscription.pinned_events` reports how many events subscriptions hold back.

### 8. Authorization and tenancy

- **Same tenant only.** Every row carries the source's `tenant_id`. `route` returns only an id, and `turn.subscribe` takes only an id and uses the turn's tenant. No API accepts a tenant, so a cross-tenant subscription can't be expressed. The runtime still checks, as ADR 0023 requires. At startup it checks that every registered subscription names a source type registered in the same deployment. At each delivery, it checks that the subscriber's tenant equals the source row's `tenant_id` before admission, and a mismatch is a deterministic defect. Cross-tenant fan-in, such as an operator dashboard over every tenant, belongs to `Fleet.view` ([ADR 0006](0006-scale-rules-placement-and-query-tiers.md)).
- **Sources may restrict their subscribers.** Within a tenant, any actor type in the deployment may subscribe to any event a source lists in `events`. The framework is trusted application infrastructure ([contract 10](../contracts/10-security.md)), and the `authorize` hook governs external callers, not System deliveries. A source may narrow this with `policy.subscribers: ["CustomerSummary", "Dashboard"]`, subscriber type names given as strings so the source never imports its subscribers. The check runs when the runtime layer is built: a registered subscription whose subscriber type the source excludes fails startup. The check is static, because every subscription, dynamic ones included, is declared on its subscriber.
- **Handlers are internal and accept only subscription deliveries** (section 1). They are absent from handles, HTTP, OpenAPI, the Promise client, and `X.intents`.
- **Revocation doesn't stop a subscription.** It is accepted durable work between two actors ([ADR 0004](0004-receipt-access-revocation-and-expiry.md)). An application stops one with `turn.unsubscribe`, or by removing the declaration.
- **Contract 07's revocation bound doesn't apply to actor-to-actor subscriptions.** That bound governs sessions held for an external principal: connections, streams, and client event feeds. A subscription has no external principal. It is created by a committed turn or by a declaration, and each delivery is trusted internal work. A client that reads a subscriber's projection does so through that subscriber's own queries, connections, or feeds, and those are reauthorized under contract 07 as usual.

### 9. Composition with workflow waits

A workflow wait (`Ship.wait(name, Event)`, ADR 0022 decision 5) stays owner-only ([contract 05](../contracts/05-messaging.md), [ADR 0022](0022-workflow-engine-storage-and-version-markers.md)). A workflow that waits for a foreign event gets it through its owner. The owner subscribes, and its handler emits an owner event that the workflow waits for:

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
  if (delivery._tag !== "Event") return yield* turn.emit(new PaymentUnknown({}))
  yield* turn.emit(new PaymentSeen({ paymentId: delivery.source.id }))
  yield* turn.unsubscribe(PaymentUpdates, delivery.source.id)
})

// A typed wait step on the Ship workflow, used in its body:
export const AwaitPayment = Ship.wait("payment-seen", PaymentSeen)
const paid =
  yield * AwaitPayment({ where: (e) => e.paymentId === order.paymentId, timeout: "1 day" })
```

The delivery is a turn on the owner, so its `emit` takes ADR 0022's emit-path wait lookup. A wait sees owner events from the execution's cursor, so a delivery that lands before the body reaches the wait still resolves it. No new race exists, and the engine needs nothing new.

### 10. Composition with connections and waking parked subscribers

This section states the interface agreed with ADR 0023's owner (DURA-27). ADR 0023 lists these requirements under "Interface with cross-actor subscriptions".

- **Delivery wakes a sleeping or parked subscriber.** A delivery is an ordinary System command turn through the subscriber's command entity, like any relay-delivered intent. It activates a hibernated subscriber, or a parked one, on its current owner. This is the durable wake path. It needs no runner-to-runner message: the committing runner's relay wakes locally, and any runner's poll is the correctness path ([ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) section 6).
- **The handler has the full `X.Turn`, including `turn.broadcast(Member, frame, { except?, to? })`.** Frames flush after commit to the subscriber's parked connections through their holders, and a declared failure or rollback discards them.
- **Frames carry the subscriber's cursor.** ADR 0023 stamps each frame with the subscriber's own event cursor at commit. A client that must not miss a projected change follows the subscriber's events and resynchronizes from that stamp. `delivery.cursor`, the source's cursor, is available to put in a frame's payload.
- **A receipt replay never re-broadcasts.** A redelivery acknowledged as `AlreadyApplied`, `Stale`, or `Unsubscribed` runs no handler. A delivery broadcast lost at an owner death is therefore recovered only through ADR 0023's `Resync` and the subscriber's events.
- **Broadcasts are filtered by the subscriber.** A delivery broadcast exposes source event data to the subscriber's connections under the subscriber's authorization only. A handler whose connections may not all see the event filters them with `to:`.
- **Delivery turns share the relay's bounded concurrency**, and they run in the subscriber's tenant (section 8).
- **A `RetentionGap` or `Rejected` delivery is a turn too**, so it can broadcast a resync hint.
- **Broadcast stays best-effort.** Whether a broadcast wakes a parked actor is ADR 0023's decision. Subscriptions are the durable way to wake an actor on another actor's change, and they don't depend on that decision.

## Decided questions

**Resolution (2026-09-26).** Dallen accepted every recommended default below, so the ADR stands as written and each default is a decision. The rejected alternatives stay listed for the record. Every question lists its conformance cases and failure-matrix rows for the build, and the `subscriptions` benchmark case that measures it.

### Q1. Declaration API

**Decision:** a `subscriptions: [...]` section of `Actor.subscription` members on the subscriber, with the handler an `internal` command taking `Actor.Delivery({ source, events })` that only subscription deliveries can reach. `route` makes a subscription routed; without it, the subscription is dynamic. `policy.subscribers` names subscriber types as strings, so a source never imports its subscribers.

**Alternatives:**

- `policy.subscribe: { … }` puts behaviour in `policy`, which holds settings.
- A standalone `Actor.subscribe(Source, Event, { to, key })` call outside the definition breaks the one-object rule of [ADR 0010](0010-one-way-effect-native-api.md).
- An inline `onEvent` handler would be a second kind of handler; the handler is a command, as cron and effect routes are.

**Example:** section 1.

**Conformance:** `rejects an event class the source doesn't declare`, `rejects a handler whose input doesn't accept the delivery` (type tests), `rejects duplicate subscription tags at Actor.make`, `routes each event to the id route returns`, `dies when a non-subscription System caller reaches a handler, and hides handlers from X.intents`, `routes to the tenant's singleton with route: Actor.singleton`.

**Failure rows:** **Route throws or returns an id the key schema rejects**. The row backs off with `last_error`, and later events wait. It is a deterministic defect.

**Benchmark:** `subscriptions/commit-to-delivery` (one routed subscriber).

### Q2. Dynamic subscribe and unsubscribe

**Decision:** `turn.subscribe(S, id, { from })` and `turn.unsubscribe(S, id)` on `X.Turn`. Each is staged as an outbox `control` row with a strictly increasing epoch from the subscriber's cursor row, which is kept as a tombstone after unsubscribing. The epoch fences registration, every delivery, the derived id, and the source row's delete. `from` defaults to `"now"`. Unsubscribing takes effect when the subscriber's turn commits.

**Alternative:** a request/reply `subscribe` call to the source. It is forbidden inside a turn, and it would wake the source.

**Example:** section 2.

**Conformance:**

- `delivers events committed after the registration and none before, with from: "now"`
- `replays retained history with from: "start" and reports a gap when it was pruned`
- `resumes after an explicit cursor`
- `stages nothing when the subscribing turn fails with a declared error`
- `runs no handler for a delivery in flight when unsubscribe commits`
- `keeps the newest epoch when subscribe and unsubscribe control rows are delivered out of order`
- `removes an orphan source row on a Stale or Unsubscribed acknowledgement, and never a newer epoch's row`
- `runs no stale-epoch delivery after unsubscribe and resubscribe from "start", and applies the new epoch from cursor 1`
- `makes no change when a control row reruns at the same epoch after a crash`
- `delivers retained history to a from: "start" subscription on a source that never emits again`
- `delivers Rejected and deactivates the subscription for a cursor above the source's head`, including when the requested cursor equals the row's `applied`
- `delivers a class added to a routed or dynamic subscription by a deploy, and never narrows a row during a rolling deploy`
- `keeps the tag summary equal to the rows after every insert, widen, and delete`
- `repeats a gap's id and range on redelivery after pruning advances`
- `subscribes to a source that has never been created, and delivers its first event`

**Failure rows:** **Subscribe and unsubscribe controls delivered out of order**; **Relay dies after the control claim, before the registration statement**; **Control row reruns after its statement committed**; **Stale epoch delivery after resubscribe**.

**Benchmark:** `subscriptions/subscribe-churn` (subscribe and unsubscribe turns per second, and control rows per operation).

### Q3. Where fan-out happens

**Decision:** at relay time. The publisher's commit adds at most one keyed `feed` row, through a CTE in the append statement. Expansion and delivery run on any runner, per subscription row.

**Alternative:** commit-time fan-out, with one outbox row per subscriber in the publisher's turn. It is simpler and has one hop less latency. But its cost grows with subscribers: the baseline above shows 83 ms p50 at 1,024 subscribers on Postgres, against 2.5 ms at one. It holds the publisher's row lock for that long, and it multiplies the publisher's WAL.

**Example:** none; this is internal.

**Conformance:**

- `writes one feed row per publishing turn whatever the subscriber count`
- `writes no feed row for an actor with no subscriptions, and probes the tag summary by key with 10^5 non-matching rows`
- `loses no wake when a commit races a settle or an expansion` (Postgres: pause settle after its snapshot, commit, expand, then resume settle)
- `renews a subscription lease across a batch of slow deliveries`
- `keeps a backing-off row's due time when new commits expand the feed`
- `claims a source's subscriptions on several runners` (harness)
- `leaves the publisher's statement count unchanged` (T2 gate)

**Failure rows:** **Commit races subscription settle**; **Relay dies after claiming a feed row, before expansion** (the feed is expanded after the lease ends); **Publisher commits while a runner is expanding its feed row** (the reset `attempts` defeats the fenced delete, so the feed is expanded again).

**Benchmark:** `subscriptions/publish-with-<n>-subscribers` for n = 1, 16, 256, and 1,024, against this branch's `intent-fanout-<n>` baseline. The publisher's p50 must stay flat across n, within 10% of `events/append-1`.

### Q4. Cursors and delivery guarantees

**Decision:** at-least-once transport with exactly-once effect per `(subscription, epoch, source, cursor)`. The derived command id and its receipt deduplicate first. The subscriber-side `applied` cursor, which never expires, deduplicates after receipt pruning and against stale runners. Declared failures advance the cursor.

**Alternative:** receipts alone. That needs cleanup to keep delivery receipts for as long as the source-side row might redeliver, which can't be checked, because the two rows are on different shards.

**Example:** section 4.

**Conformance:**

- `applies each committed source event once across a relay crash before and after the subscriber's commit` (SIGKILL on Postgres)
- `acknowledges a redelivery whose receipt was pruned without running the handler`
- `refuses a stale runner's delivery below the applied cursor after a lease takeover`
- `advances past a declared failure and replays its receipt`
- `derives distinct command ids for two subscriptions, two subscribers, and two epochs of one source`
- `rejects a derived id presented by an external caller before admission`
- `replays after a schema-compatible deploy instead of CommandConflict`
- `delivers nothing for a rolled-back source turn` (E1)

**Failure rows:** **Subscriber crashes after delivery commit**, **Relay dies after claiming a subscription row**, **Stale runner delivers after a lease takeover**, **Receipt pruned before a late redelivery**, **Source turn rolls back**.

**Benchmark:** `subscriptions/commit-to-delivery` (p50, p99, and statements per delivered event against `outbox/delivery-sequential`) and `subscriptions/drain-<n>` (a backlog of n due deliveries across 64 subscribers).

### Q5. Ordering

**Decision:** source-cursor order within one subscription row, across the subscription's event classes, with one delivery in flight. A routed row serves every subscriber its source routes to, so a blocked routed subscriber holds back that source's later events for the others. Nothing else is ordered. The alternative for routed rows is to split a row per route result after its first delivery. That trades the source's order across subscribers for isolation, and it costs a source-side row per `(source, subscriber)` pair.

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
- `holds a routed source's later events for every routed subscriber while one is blocked`
- `interleaves two sources without blocking each other`

**Failure rows:** **Poison delivery blocks one subscription** (other rows and the publisher keep moving).

**Benchmark:** `subscriptions/fan-in-<n>` (10^4 sources emitting to one subscriber: throughput, and the subscriber's turn batch size), and `subscriptions/pair-throughput` (one source emitting to one subscriber as fast as it can: the sequential ceiling of one pair).

### Q6. Poison deliveries

**Decision:** retry with capped backoff and never skip automatically. Operator skip is an M4 capability. Alternatives are a per-subscription `onDefect: "skip"`, or a dead-letter route like effects'. Both silently break ordering for the events after the skipped one. A skip is a decision a person makes.

**Example:**

```sh
durable subscriptions list --lagging          # rows with attempts >= 8, their last_error and lag
durable subscriptions skip <row> --through <cursor> --reason "bad payload from v1.4"
```

**Conformance:** `retries a defecting delivery with capped backoff and records last_error`; `lets other subscriptions of the same source proceed`. M4 adds `requires operator authority to skip, records the skip, and delivers a RetentionGap-style marker`.

**Failure rows:** **Poison delivery blocks one subscription**.

**Benchmark:** `subscriptions/lag-with-one-poison-row`. The other rows' lag stays within one poll of the healthy case.

### Q7. Retention and `keepEvents`

**Decision:** subscriptions hold back pruning for up to `policy.holdEventsForSubscribers` (`"7 days"`) past `keepEvents`, and then the subscriber gets a `RetentionGap`. An id-routed row has no recipient for a gap, so it records and counts it instead (section 7). The alternatives are an unbounded hold, where one dead subscriber grows a source's history forever, and no hold, where a routine outage turns into gaps.

**Example:**

```ts
Actor.make("Order", { …, policy: { keepEvents: "30 days", holdEventsForSubscribers: "7 days" } })
```

**Conformance:**

- `keeps events above the lowest subscriber cursor inside the hold`
- `prunes past the hold and delivers one RetentionGap, then resumes`
- `holds for the smaller of the subscription and workflow bounds`
- `reports RetentionGap first for a from: "start" subscription after pruning`
- `counts an id-routed gap on the row and delivers a singleton-routed gap`

**Failure rows:** **Source events pruned before delivery**, **Retention races a delivery claim** (pruning and a claim interleave; the delivery sees either the event or the gap, never a skip).

**Benchmark:** `subscriptions/prune-beside-<n>-subscriptions` (retention pass time with 10^4 subscription rows on one source).

### Q8. Authorization and tenancy

**Decision:**

- Same-tenant only: impossible to express otherwise, and checked again at startup and at each delivery.
- Open within a tenant for declared events, with `policy.subscribers` as a static allow-list on the source.
- System caller `source: "subscription"`, with no `onBehalfOf`.

**Alternatives:**

- Rivet's runtime `canSubscribe` hook needs a live check per registration and can't cover routed subscriptions.
- Propagating the emitter's principal would store principals on every event.

**Example:**

```ts
Actor.make("Payment", { …, policy: { subscribers: ["Shipment", "Ledger"] } }) // anything else fails when the runtime layer is built
```

**Conformance:**

- `keeps equal source ids in two tenants apart` (S2)
- `rejects a subscriber excluded by policy.subscribers at Actor.make`
- `dies deterministically when a non-System caller reaches a subscription handler`
- `continues a subscription after the subscribing caller's access is revoked` (H2)
- `records System subscription attribution on the delivery`

**Failure rows:** **Cross-tenant or unauthorized subscription attempt** (can't be expressed, or fails at startup; no rows are written).

**Benchmark:** none. This is a declaration check.

### Q9. Composition with workflow waits

**Decision:** workflow waits stay owner-only. Foreign events arrive through the owner's subscription handler re-emitting an owner event (section 9). The alternative is to let `Ship.wait` name a foreign source. That would put a cross-shard read on the resume path, and it would duplicate subscriptions inside the engine.

**Example:** section 9.

**Conformance:** `resolves an owner wait from a subscription delivery that re-emits`, `resolves when the delivery lands before the body reaches the wait`, `subscribes in the workflow's start turn and delivers after the start commits`.

**Failure rows:** the existing **Event races workflow wait registration**, run with the event arriving through a delivery.

**Benchmark:** `workflow` (ADR 0022). A wait resolved through a subscription adds one `commit-to-delivery` to the resume latency.

### Q10. Composition with connections, and waking parked subscribers

**Decision:** a delivery is an ordinary command turn that wakes the subscriber, and its handler broadcasts with `turn.broadcast`. ADR 0023 stamps frames with the subscriber's cursor. This is agreed with DURA-27.

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

**Decision:** `0017_subscriptions`, built in wave 4 as #94 (still M3.7, moved from wave 6 to wave 4 by DURA-22's #97). The build depends on M2.4's `0011_relay` (claims, the kind index, `scheduled_at_ms`) and M1.9's `0010_retention` (pruning bounds). It doesn't depend on workflows or connections. The migrator skips ids at or below the latest one applied, so `0016` must land after `0012`–`0015`, or the reservations are renumbered under the roadmap's rule.

## Behaviour changes against existing contracts

| Document                                                  | Today                                                                     | After this ADR                                                                                                                                                                                                                                   | Section |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| [Contract 04](../contracts/04-receipts.md)                | Every command id is minted by a handle or client                          | Framework deliveries may carry ids derived from the durable record they deliver; derived ids are internal. Subscription receipts bind the delivery's identity.                                                                                   | 4       |
| [Contract 05](../contracts/05-messaging.md)               | Events are owner-scoped; only the owner's queries and workflows read them | Declared subscriptions deliver committed events to other actors in the same tenant, in cursor order per source, as System command turns                                                                                                          | 1–5     |
| [Contract 07](../contracts/07-realtime.md)                | Durable event subscriptions use a cursor (client feeds)                   | The same rules cover actor-to-actor subscriptions: cursor order per source and explicit `RetentionGap` deliveries, except for id-routed gaps, which are counted. The revocation bound covers external sessions, not actor-to-actor subscriptions | 5, 7    |
| [Contract 10](../contracts/10-security.md)                | System sources are intents, effect routes, and cron                       | Adds `subscription`; subscriptions are same-tenant by construction; `policy.subscribers` restricts subscriber types                                                                                                                              | 8       |
| [Retention](../operations/retention.md)                   | Pruning covers replay cursors and workflow waits                          | Pruning also stops at subscriber cursors, for at most `holdEventsForSubscribers` past `keepEvents`                                                                                                                                               | 7       |
| [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md) | The relay claims `intent` and `effect` rows                               | Also `feed` and `control` outbox kinds, and subscription rows claimed by `(bucket, subscriber_type, due_at_ms)` with their own delivery slots and per-delivery lease renewal                                                                     | 3       |

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
- `actor_subscription_cursors` grows with the number of `(subscriber, source)` pairs ever delivered. Rows are small. They are kept after unsubscribing, as tombstones that hold the epoch, and a routed fan-in subscriber keeps one per source. This is accepted; revisit it with actor deletion.
- Routed subscription rows exist per source actor that has emitted a matching event, like cron rows per actor.
- A new routed declaration doesn't backfill history. It starts at each source's first matching commit on a runner that registers the declaration. During a rolling deploy, a source's matching events committed on old runners before that commit aren't delivered; this is start semantics, not a gap. Backfill is a dynamic `from: "start"` subscription or a workflow.
- Removing a declaration in a deploy leaves its rows. As with cron rule 1 of ADR 0021, a runner that registers the subscriber type but lacks the declaration releases the row with backoff. It deletes the row once the row has been due for longer than one day, so a rolling deploy never loses a new declaration's rows.

## Amendments

In this change:

- [Contract 04](../contracts/04-receipts.md): derived framework command ids and the subscription receipt binding.
- [Contract 05](../contracts/05-messaging.md): cross-actor subscriptions.
- [Contract 07](../contracts/07-realtime.md): actor-to-actor subscriptions follow the cursor and gap rules, with the id-routed gap exception, and are outside the session revocation bound.
- [Contract 10](../contracts/10-security.md): the `subscription` System source, same-tenant scope, and `policy.subscribers`.
- [Retention](../operations/retention.md): subscriber holds.
- [ADR 0021](0021-multi-runner-relay-singleton-and-cron.md): the `feed` and `control` outbox kinds, subscription claims with their own slots, and lease renewal per delivery. This extends ADR 0021 and doesn't change its intent or effect rules.
- [M3](../milestones/M3.md): M3.7's evidence list matches this design.
- [Server API](../api/01-server-api.md) and [context](../api/02-context.md): `subscriptions`, `Actor.subscription`, `Actor.Delivery`, `turn.subscribe`, `turn.unsubscribe`, and the two policies (target API).
- [Data model](../architecture/data-model.md), [transaction catalog](../architecture/transaction-catalog.md), and [glossary](../GLOSSARY.md).
- Conformance: the **Subscription delivery** gate and decision check. [Failure matrix](../verification/02-failure-matrix.md): the new rows. [Invariants](../verification/invariants.md): E2. [Performance](../verification/03-performance.md): the baseline.

## Required evidence (#94, `conformance/subscriptions.ts`, migration `0017_subscriptions`)

- The conformance cases named under Q1–Q10 run on PGlite and Postgres. Crash, contention, and race cases run on Postgres only. Multi-runner cases run on the M2.1 harness.
- Fault points `beforeSettle` (after the subscriber's commit, before the source-side settle), `afterSettleSnapshot` (settle paused after its snapshot), and `afterExpand` are added to `TurnHooks` and `crashNext`/`pauseNext`.
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
  - **Relay dies after the control claim, before the registration statement**
  - **Control row reruns after its statement committed**
  - **Stale epoch delivery after resubscribe**
  - **Relay dies after claiming a feed row, before expansion**
  - **Routed row loses history with no gap recipient**
- **Invariant:** E2: each committed source event takes effect exactly once per active subscription, in source cursor order, or is reported as a gap. The listed exceptions are routed events before the source's routed row exists, routed events for a `createdBy`-refused subscriber (counted), and id-routed gaps (counted on the row).
- **Benchmark:** `subscriptions`, extending this branch's `intent-fanout-<n>` baseline with these cases:
  - `commit-to-delivery` and `commit-to-delivery-hibernated`
  - `pair-throughput`
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
