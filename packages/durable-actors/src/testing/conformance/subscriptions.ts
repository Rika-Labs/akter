import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { SqlClient, type SqlError } from "effect/unstable/sql"
import { Actor, type Caller, Tenant, User } from "../../index.ts"
import { InternalActors, Outcome, Request } from "../../handles/actors.ts"
import type { SubscriptionEnvelope } from "../../handles/actors.ts"
import { System } from "../../identity/caller.ts"
import { InternalCommandId } from "../../identity/command.ts"
import { OperatorRuntime } from "../../runtime/operators/repair.ts"
import { deliveryCommandId } from "../../runtime/subscriptions/identity.ts"

import { RetryTurn, type TurnPoint } from "../../runtime/turn/hooks.ts"
import { ActorTest, executeForTest } from "../actor-test.ts"
import { ActorCluster } from "../cluster.ts"
import type {
  ConformanceCase,
  ConformanceEnvironment,
  ConformanceServices,
} from "../conformance.ts"
import { CLAIM_LEASE, ExplainOutput, planNodes } from "./outbox.ts"

/** What a subscription handler does with one delivery, decided per entry. */
export type Behaviour = "apply" | "defect" | "refuse"

/** Shared by the subscription actors and every subscription case. */
export interface SubscriptionsFixture {
  /** Every handler run, including runs whose turn later rolled back, as `subscriber/entry`. */
  readonly runs: Array<string>
  /** The caller each handler run saw, by entry. */
  readonly callers: Map<string, Caller>
  behave: (entry: string) => Behaviour
  /** Runs inside each handler before it records the delivery. */
  during: Effect.Effect<void>
  hook: (point: TurnPoint, request: Request) => Effect.Effect<void>
}

export const subscriptionsFixture = (): SubscriptionsFixture => ({
  runs: [],
  callers: new Map(),
  behave: () => "apply",
  during: Effect.void,
  hook: () => Effect.void,
})

const reset = (fixture: SubscriptionsFixture) =>
  Effect.sync(() => {
    fixture.runs.length = 0
    fixture.callers.clear()
    fixture.behave = () => "apply"
    fixture.during = Effect.void
    fixture.hook = () => Effect.void
  })

class Refused extends Schema.TaggedError<Refused>()("SubscriptionRefused", {}) {}

class OrderPlaced extends Actor.Event<OrderPlaced>()("OrderPlaced", {
  customerId: Schema.String,
  amount: Schema.Finite,
}) {}

class OrderCancelled extends Actor.Event<OrderCancelled>()("OrderCancelled", {
  customerId: Schema.String,
}) {}

class OrderNoted extends Actor.Event<OrderNoted>()("OrderNoted", { note: Schema.String }) {}

const Place = Actor.command("Place", {
  input: Schema.Struct({ customerId: Schema.String, amount: Schema.Finite }),
})

const PlaceMany = Actor.command("PlaceMany", {
  input: Schema.Struct({ customerId: Schema.String, count: Schema.Int }),
})

const CancelOrder = Actor.command("CancelOrder", { input: Schema.String })

const Note = Actor.command("Note", { input: Schema.String })

const PlaceThenRefuse = Actor.command("PlaceThenRefuse", {
  input: Schema.String,
  errors: [Refused],
})

const PlaceThenDie = Actor.command("PlaceThenDie", { input: Schema.String })

const SubOrder = Actor.make("SubOrder", {
  key: Schema.String,
  events: [OrderPlaced, OrderCancelled, OrderNoted],
  api: { Place, PlaceMany, CancelOrder, Note, PlaceThenRefuse, PlaceThenDie },
  policy: {
    subscribers: ["SubSummary", "SubFollower", "SubDashboard", "SubAuditor", "SubShipment"],
  },
})

const Record = Actor.command("Record", {
  input: Schema.Struct({ customerId: Schema.String, count: Schema.Int }),
})

/** A source whose events are pruned after an hour, and held for subscribers one hour more. */
const SubJournal = Actor.make("SubJournal", {
  key: Schema.String,
  events: [OrderPlaced],
  api: { Record },
  policy: {
    keepEvents: "1 hour",
    holdEventsForSubscribers: "1 hour",
    subscribers: ["SubSummary", "SubFollower", "SubDashboard"],
  },
})

const Log = Actor.state({
  log: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
})

const OrderDelivery = Actor.Delivery({ source: SubOrder, events: [OrderPlaced, OrderCancelled] })

type OrderDelivery = typeof OrderDelivery.Type

const RecordOrder = Actor.command("RecordOrder", { input: OrderDelivery, errors: [Refused] })

const CustomerOrders = Actor.subscription("CustomerOrders", {
  source: SubOrder,
  events: [OrderPlaced, OrderCancelled],
  handler: RecordOrder,
  route: (event) => event.customerId,
})

const CustomerJournals = Actor.subscription("CustomerJournals", {
  source: SubJournal,
  events: [OrderPlaced],
  handler: RecordOrder,
  route: (event) => event.customerId,
})

const Touch = Actor.command("Touch")

/** Each delivery's entry, broadcast after its turn commits. */
const Live = Actor.connection("SummaryLive", { server: Schema.String, client: Schema.String })

/** A routed projection: every order event reaches the customer it names. */
const SubSummary = Actor.make("SubSummary", {
  key: Schema.String,
  state: Log,
  api: { Touch, SummaryLive: Live },
  internal: { RecordOrder },
  subscriptions: [CustomerOrders, CustomerJournals],
})

const AuditOrder = Actor.command("AuditOrder", { input: OrderDelivery })

const AuditedOrders = Actor.subscription("AuditedOrders", {
  source: SubOrder,
  events: [OrderPlaced, OrderCancelled],
  handler: AuditOrder,
  route: (event) => event.customerId,
})

/** A second routed subscription of the same source, which never fails. */
const SubAuditor = Actor.make("SubAuditor", {
  key: Schema.String,
  state: Log,
  api: { Touch },
  internal: { AuditOrder },
  subscriptions: [AuditedOrders],
})

const OnOrder = Actor.command("OnOrder", { input: OrderDelivery, errors: [Refused] })

const FollowedOrders = Actor.subscription("FollowedOrders", {
  source: SubOrder,
  events: [OrderPlaced, OrderCancelled],
  handler: OnOrder,
})

const Follow = Actor.command("Follow", {
  input: Schema.Struct({ source: Schema.String, from: Schema.optional(Schema.String) }),
})

const FollowThenRefuse = Actor.command("FollowThenRefuse", {
  input: Schema.String,
  errors: [Refused],
})

const Unfollow = Actor.command("Unfollow", { input: Schema.String })

const IntentKeys = Actor.command("IntentKeys", { output: Schema.Array(Schema.String) })

const FollowedJournals = Actor.subscription("FollowedJournals", {
  source: SubJournal,
  events: [OrderPlaced],
  handler: OnOrder,
})

const FollowJournal = Actor.command("FollowJournal", {
  input: Schema.Struct({ source: Schema.String, from: Schema.optional(Schema.String) }),
})

/** A dynamic subscriber: it follows only the orders its turns subscribe to. */
const SubFollower = Actor.make("SubFollower", {
  key: Schema.String,
  state: Log,
  api: { Follow, FollowThenRefuse, Unfollow, IntentKeys, Touch, FollowJournal },
  internal: { OnOrder },
  subscriptions: [FollowedOrders, FollowedJournals],
})

const CountOrder = Actor.command("CountOrder", {
  input: Actor.Delivery({ source: SubOrder, events: [OrderPlaced] }),
})

const AllOrders = Actor.subscription("AllOrders", {
  source: SubOrder,
  events: [OrderPlaced],
  handler: CountOrder,
  route: Actor.singleton,
})

const AllJournals = Actor.subscription("AllJournals", {
  source: SubJournal,
  events: [OrderPlaced],
  handler: CountOrder,
  route: Actor.singleton,
})

/** Fan-in: every order placed in the tenant reaches the tenant's one dashboard. */
const SubDashboard = Actor.make("SubDashboard", {
  key: Actor.singleton,
  state: Log,
  api: { Touch },
  internal: { CountOrder },
  subscriptions: [AllOrders, AllJournals],
})

class PaymentSeen extends Actor.Event<PaymentSeen>()("PaymentSeen", {
  orderId: Schema.String,
}) {}

const ShipOrder = Actor.workflow("ShipOrder", {
  input: { orderId: Schema.String },
  output: Schema.String,
  key: ({ orderId }) => orderId,
})

const AwaitPayment = ShipOrder.wait("payment-seen", PaymentSeen)

const PlaceOrder = Actor.command("PlaceOrder", { input: Schema.String, output: Schema.String })

const OnPayment = Actor.command("OnPayment", {
  input: Actor.Delivery({ source: SubOrder, events: [OrderPlaced] }),
})

const PaymentUpdates = Actor.subscription("PaymentUpdates", {
  source: SubOrder,
  events: [OrderPlaced],
  handler: OnPayment,
})

/**
 * A workflow waits only for its owner's events, so the owner follows the
 * order and re-emits what the workflow waits for.
 */
const SubShipment = Actor.make("SubShipment", {
  key: Schema.String,
  events: [PaymentSeen],
  api: { ShipOrder, PlaceOrder },
  internal: { OnPayment },
  subscriptions: [PaymentUpdates],
})

/** One delivery as a handler logs it: `source#cursor:event`, `source~gap:after-resume`, or `source!rejected:cursor`. */
const entryOf = (delivery: OrderDelivery | typeof CountOrder.input.Type) =>
  Match.value(delivery).pipe(
    Match.tagsExhaustive({
      Event: (event) => `${event.source.id}#${event.cursor}:${event.event._tag}`,
      RetentionGap: (gap) => `${gap.source.id}~gap:${gap.after}-${gap.resumeAfter}`,
      Rejected: (rejected) => `${rejected.source.id}!rejected:${rejected.cursor}`,
    }),
  )

const record = <A extends { readonly id: string; readonly caller: Caller }>(
  fixture: SubscriptionsFixture,
  subscriber: string,
  turn: A & {
    readonly state: { readonly log: ReadonlyArray<string> } & {
      readonly set: (patch: { readonly log: ReadonlyArray<string> }) => Effect.Effect<void>
    }
  },
  delivery: OrderDelivery | typeof CountOrder.input.Type,
) =>
  Effect.gen(function* () {
    const entry = entryOf(delivery)
    fixture.runs.push(`${subscriber}/${turn.id}/${entry}`)
    fixture.callers.set(entry, turn.caller)
    yield* fixture.during

    const behaviour = fixture.behave(`${subscriber}/${turn.id}/${entry}`)

    if (behaviour === "defect") return yield* Effect.die(new Error(`Handler defect on ${entry}`))

    yield* turn.state.set({ log: [...turn.state.log, entry] })

    if (behaviour === "refuse") return yield* Refused.make({})
  })

/** The source alone, as a runner that serves orders but none of their subscribers would. */
const subOrderLayer = SubOrder.toLayer(
  Effect.succeed({
    Place: Effect.fnUntraced(function* ({ customerId, amount }) {
      yield* (yield* SubOrder.Turn).emit(OrderPlaced.make({ customerId, amount }))
    }),
    PlaceMany: Effect.fnUntraced(function* ({ customerId, count }) {
      const turn = yield* SubOrder.Turn

      for (let index = 0; index < count; index++)
        yield* turn.emit(OrderPlaced.make({ customerId, amount: index }))
    }),
    CancelOrder: Effect.fnUntraced(function* (customerId: string) {
      yield* (yield* SubOrder.Turn).emit(OrderCancelled.make({ customerId }))
    }),
    Note: Effect.fnUntraced(function* (note: string) {
      yield* (yield* SubOrder.Turn).emit(OrderNoted.make({ note }))
    }),
    PlaceThenRefuse: Effect.fnUntraced(function* (customerId: string) {
      yield* (yield* SubOrder.Turn).emit(OrderPlaced.make({ customerId, amount: 1 }))

      return yield* Refused.make({})
    }),
    PlaceThenDie: Effect.fnUntraced(function* (customerId: string) {
      yield* (yield* SubOrder.Turn).emit(OrderPlaced.make({ customerId, amount: 1 }))

      return yield* Effect.die(new Error("Publisher defect after emitting"))
    }),
  }),
)

export const subscriptionsLayer = (fixture: SubscriptionsFixture) =>
  Layer.mergeAll(
    subOrderLayer,
    SubJournal.toLayer(
      Effect.succeed({
        Record: Effect.fnUntraced(function* ({ customerId, count }) {
          const turn = yield* SubJournal.Turn

          for (let index = 0; index < count; index++)
            yield* turn.emit(OrderPlaced.make({ customerId, amount: index }))
        }),
      }),
    ),
    SubSummary.toLayer(
      Effect.succeed({
        Touch: () => Effect.void,
        RecordOrder: Effect.fnUntraced(function* (delivery) {
          const turn = yield* SubSummary.Turn
          // Sent only if the turn commits; a declared failure discards it.
          yield* turn.broadcast(Live, entryOf(delivery))
          yield* record(fixture, "SubSummary", turn, delivery)
        }),
        SummaryLive: { open: () => Effect.void, frame: () => Effect.void },
      }),
    ),
    SubShipment.toLayer(
      Effect.succeed({
        PlaceOrder: Effect.fnUntraced(function* (orderId: string) {
          const turn = yield* SubShipment.Turn
          // The turn that starts the workflow also subscribes, so both commit together.
          yield* turn.subscribe(PaymentUpdates, orderId, { from: "start" })

          return yield* (yield* SubShipment.intents(turn.id)).ShipOrder({ orderId })
        }),
        OnPayment: Effect.fnUntraced(function* (delivery) {
          const turn = yield* SubShipment.Turn

          if (!Predicate.isTagged(delivery, "Event")) return

          yield* turn.emit(PaymentSeen.make({ orderId: delivery.source.id }))
          yield* turn.unsubscribe(PaymentUpdates, delivery.source.id)
        }),
        ShipOrder: Effect.fnUntraced(function* ({ orderId }: { readonly orderId: string }) {
          const paid = yield* AwaitPayment({
            where: (event) => event.orderId === orderId,
            timeout: "1 minute",
          })

          return Option.match(paid, { onNone: () => "unpaid", onSome: () => "paid" })
        }),
      }),
    ),
    SubAuditor.toLayer(
      Effect.succeed({
        Touch: () => Effect.void,
        AuditOrder: Effect.fnUntraced(function* (delivery) {
          const turn = yield* SubAuditor.Turn
          fixture.runs.push(`SubAuditor/${turn.id}/${entryOf(delivery)}`)
          yield* turn.state.set({ log: [...turn.state.log, entryOf(delivery)] })
        }),
      }),
    ),
    SubFollower.toLayer(
      Effect.succeed({
        Follow: Effect.fnUntraced(function* ({ source, from }) {
          yield* (yield* SubFollower.Turn).subscribe(
            FollowedOrders,
            source,
            from === undefined ? undefined : { from },
          )
        }),
        FollowJournal: Effect.fnUntraced(function* ({ source, from }) {
          yield* (yield* SubFollower.Turn).subscribe(
            FollowedJournals,
            source,
            from === undefined ? undefined : { from },
          )
        }),
        FollowThenRefuse: Effect.fnUntraced(function* (source: string) {
          yield* (yield* SubFollower.Turn).subscribe(FollowedOrders, source)

          return yield* Refused.make({})
        }),
        Unfollow: Effect.fnUntraced(function* (source: string) {
          yield* (yield* SubFollower.Turn).unsubscribe(FollowedOrders, source)
        }),
        IntentKeys: Effect.fnUntraced(function* () {
          const intents = yield* SubFollower.intents((yield* SubFollower.Turn).id)

          return Object.keys(intents)
            .filter((key) => key !== "ref")
            .sort()
        }),
        Touch: () => Effect.void,
        OnOrder: Effect.fnUntraced(function* (delivery) {
          yield* record(fixture, "SubFollower", yield* SubFollower.Turn, delivery)
        }),
      }),
    ),
    SubDashboard.toLayer(
      Effect.succeed({
        Touch: () => Effect.void,
        CountOrder: Effect.fnUntraced(function* (delivery) {
          yield* record(fixture, "SubDashboard", yield* SubDashboard.Turn, delivery).pipe(
            Effect.orDie,
          )
        }),
      }),
    ),
  )

const LogState = Schema.Struct({ log: Schema.optional(Schema.Array(Schema.String)) })

const logOf = Effect.fnUntraced(function* (actor: string, id: string) {
  const test = yield* ActorTest

  const { state } = yield* test.inspect({ tenant: test.tenant, actor, id })

  return (yield* Schema.decodeUnknownEffect(LogState)(state).pipe(Effect.orDie)).log ?? []
})

const query = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>) =>
  Effect.gen(function* () {
    return yield* statement(yield* SqlClient.SqlClient)
  }).pipe(Effect.orDie)

/** The source-side rows of one order in the test tenant, of one subscriber type. */
const sourceRows = (sourceId: string, subscriberType = "SubFollower") =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return yield* query(
      (sql) => sql<{
        subscriber_type: string
        subscription: string
        subscriber_id: string
        epoch: string
        active: boolean
        delivered: string
        due: boolean
        attempts: number
        last_error: string | null
      }>`SELECT subscriber_type, subscription, subscriber_id, epoch::text AS epoch, active,
          delivered::text AS delivered, due_at_ms IS NOT NULL AS due, attempts, last_error
        FROM actor_subscriptions WHERE tenant_id = ${test.tenant} AND source_type = 'SubOrder'
          AND source_id = ${sourceId} AND subscriber_type = ${subscriberType}
        ORDER BY subscription, subscriber_id`,
    )
  })

/** The subscriber-side cursor rows of one follower in the test tenant. */
const cursorRows = (actor: string, id: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return yield* query(
      (sql) => sql<{
        subscription: string
        source_id: string
        epoch: string
        active: boolean
        applied: string
      }>`SELECT subscription, source_id, epoch::text AS epoch, active, applied::text AS applied
        FROM actor_subscription_cursors WHERE tenant_id = ${test.tenant} AND actor_type = ${actor}
          AND actor_id = ${id}
        ORDER BY subscription, source_id`,
    )
  })

/** Outbox rows of one kind an actor of the test tenant holds. */
const outboxOf = (actor: string, id: string, kind: "feed" | "control") =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return (yield* query(
      (sql) => sql<{ count: number }>`SELECT count(*)::int AS count FROM actor_outbox
        WHERE tenant_id = ${test.tenant} AND actor_type = ${actor} AND actor_id = ${id}
          AND kind = ${kind}`,
    ))[0]!.count
  })

/**
 * Tag summary rows that disagree with the active rows carrying each tag. A
 * missed increment loses wakes, and a missed decrement costs feed writes forever.
 */
const tagMismatches = query(
  (sql) => sql<{ event: string; counted: number | null; summary: number | null }>`
    SELECT event, a.rows AS counted, t.rows AS summary FROM (
      SELECT routing_key, tenant_id, source_type, source_id, x.tag AS event, count(*)::int AS rows
      FROM actor_subscriptions, unnest(events) AS x(tag)
      WHERE active GROUP BY routing_key, tenant_id, source_type, source_id, x.tag
    ) a FULL JOIN actor_subscription_tags t USING (routing_key, tenant_id, source_type, source_id, event)
    WHERE a.rows IS DISTINCT FROM t.rows`,
)

const drain = ActorTest.use((test) => test.advance(0))

/** Makes the first `point` that `match` accepts die, as a crash there would; later ones pass. */
const crashOnce = (
  fixture: SubscriptionsFixture,
  point: TurnPoint,
  match: (request: Request) => boolean,
) => {
  const state = { crashed: false }
  fixture.hook = (reached, request) => {
    if (state.crashed || reached !== point || !match(request)) return Effect.void
    state.crashed = true

    return Effect.die(RetryTurn.make({ message: `Injected ${point} crash` }))
  }

  return state
}

/** Holds the first `point` that `match` accepts until `release`. */
const pauseOnce = Effect.fnUntraced(function* (
  fixture: SubscriptionsFixture,
  point: TurnPoint,
  match: (request: Request) => boolean,
) {
  const reached = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let paused = false
  fixture.hook = (at, request) => {
    if (paused || at !== point || !match(request)) return Effect.void
    paused = true

    return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
  }

  return {
    reached: Deferred.await(reached),
    release: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
  }
})

/** A fault point of one subscription row's work: its tag and its subscriber, or the delivery command. */
const subscriber = (id: string) => (request: Request) =>
  request.commandId === id || request.ref.id === id

/** A follower's committed log, as entries of one source. */
const followerLog = (id: string) => logOf("SubFollower", id)

const handlerRuns = (fixture: SubscriptionsFixture, prefix: string) =>
  fixture.runs.filter((run) => run.startsWith(prefix)).length

const DeliveredOrder = OrderDelivery.members[0]

const encodeDelivery = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(Schema.Struct({ value: OrderDelivery }))),
)

const encodeWithExtra = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.toCodecJson(Schema.Struct({ value: OrderDelivery, extra: Schema.Boolean })),
  ),
)

/** Builds a relay delivery request, as a runner would, for cases that play a stale runner. */
const deliveryRequest = Effect.fnUntraced(function* (options: {
  readonly subscriber: string
  readonly source: string
  readonly epoch: string
  readonly cursor: string
  /** Re-encodes the delivery with a field a newer schema added. */
  readonly extra?: boolean
}) {
  const test = yield* ActorTest
  const internal = yield* InternalActors
  const subscriber = { tenant: test.tenant, actor: "SubFollower", id: options.subscriber }
  const source = { tenant: test.tenant, actor: "SubOrder", id: options.source }

  const envelope: SubscriptionEnvelope = {
    subscription: "FollowedOrders",
    sourceType: "SubOrder",
    sourceId: options.source,
    epoch: options.epoch,
    kind: "event",
    position: options.cursor,
  }

  const [event] = yield* query(
    (sql) => sql<{ emitted_at_ms: string; command_id: string }>`
      SELECT emitted_at_ms::text AS emitted_at_ms, command_id FROM actor_events
      WHERE tenant_id = ${test.tenant} AND actor_type = 'SubOrder' AND actor_id = ${options.source}
        AND sequence = ${options.cursor}`,
  )

  const value = DeliveredOrder.make({
    subscription: "FollowedOrders",
    source,
    cursor: options.cursor,
    event: OrderPlaced.make({ customerId: "c", amount: 1 }),
    commandId: event!.command_id,
    timestamp: DateTime.makeUnsafe(Number(event!.emitted_at_ms)),
  })

  return Request.make({
    ref: subscriber,
    caller: System.make({ source: "subscription", ref: source }),
    command: "OnOrder",
    commandId: yield* deliveryCommandId({
      subscriber,
      envelope,
      issuedAt: Number(event!.emitted_at_ms),
      retryWindowMs: internal.retryWindowMs,
    }),
    payload:
      options.extra === true
        ? yield* encodeWithExtra({ value, extra: true })
        : yield* encodeDelivery({ value }),
    delivery: envelope,
  })
})

const run = <A, E>(
  environment: ConformanceEnvironment,
  fixture: SubscriptionsFixture,
  body: Effect.Effect<A, E, ConformanceServices>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const result = yield* body
      yield* reset(fixture)

      return result
    }),
  )

export const subscriptionsConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "routes each event to the id route returns",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const first = yield* SubOrder.get("route-1")
          const second = yield* SubOrder.get("route-2")
          yield* first.Place({ customerId: "route-alice", amount: 1 })
          yield* second.Place({ customerId: "route-bob", amount: 2 })
          yield* first.Note("not subscribed")
          yield* first.CancelOrder("route-alice")
          yield* drain

          expect(yield* logOf("SubSummary", "route-alice")).toEqual([
            "route-1#1:OrderPlaced",
            "route-1#3:OrderCancelled",
          ])
          expect(yield* logOf("SubSummary", "route-bob")).toEqual(["route-2#1:OrderPlaced"])
          // One routed row per source and subscription, caught up through the head.
          expect(yield* sourceRows("route-1", "SubSummary")).toEqual([
            {
              subscriber_type: "SubSummary",
              subscription: "CustomerOrders",
              subscriber_id: "",
              epoch: "0",
              active: true,
              delivered: "3",
              due: false,
              attempts: 0,
              last_error: null,
            },
          ])
          expect(yield* cursorRows("SubSummary", "route-alice")).toEqual([
            {
              subscription: "CustomerOrders",
              source_id: "route-1",
              epoch: "0",
              active: true,
              applied: "3",
            },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "routes to the tenant's singleton with route: Actor.singleton",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const before = (yield* logOf("SubDashboard", "singleton")).length
          yield* (yield* SubOrder.get("fan-1")).Place({ customerId: "fan-a", amount: 1 })
          yield* (yield* SubOrder.get("fan-2")).Place({ customerId: "fan-b", amount: 1 })
          yield* (yield* SubOrder.get("fan-2")).CancelOrder("fan-b")
          yield* drain

          const log = (yield* logOf("SubDashboard", "singleton")).slice(before)
          expect([...log].sort()).toEqual(["fan-1#1:OrderPlaced", "fan-2#1:OrderPlaced"])
        }),
      ),
  },
  {
    name: 'delivers events committed after the registration and none before, with from: "now"',
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const order = yield* SubOrder.get("now-order")
          const follower = yield* SubFollower.get("now-follower")
          yield* order.Place({ customerId: "now-x", amount: 1 })
          yield* follower.Follow({ source: "now-order" })
          yield* drain
          yield* order.Place({ customerId: "now-x", amount: 2 })
          yield* order.Note("ignored")
          yield* order.CancelOrder("now-x")
          yield* drain

          expect(yield* followerLog("now-follower")).toEqual([
            "now-order#2:OrderPlaced",
            "now-order#4:OrderCancelled",
          ])
          expect(yield* cursorRows("SubFollower", "now-follower")).toEqual([
            {
              subscription: "FollowedOrders",
              source_id: "now-order",
              epoch: "1",
              active: true,
              applied: "4",
            },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: 'delivers retained history to a from: "start" subscription on a source that never emits again',
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const order = yield* SubOrder.get("start-order")
          yield* order.PlaceMany({ customerId: "start-x", count: 3 })
          yield* order.Note("between")
          yield* order.CancelOrder("start-x")
          yield* drain
          yield* (yield* SubFollower.get("start-follower")).Follow({
            source: "start-order",
            from: "start",
          })
          yield* drain

          expect(yield* followerLog("start-follower")).toEqual([
            "start-order#1:OrderPlaced",
            "start-order#2:OrderPlaced",
            "start-order#3:OrderPlaced",
            "start-order#5:OrderCancelled",
          ])
        }),
      ),
  },
  {
    name: "resumes after an explicit cursor",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const order = yield* SubOrder.get("cursor-order")
          yield* order.PlaceMany({ customerId: "cursor-x", count: 3 })
          yield* (yield* SubFollower.get("cursor-follower")).Follow({
            source: "cursor-order",
            from: "2",
          })
          yield* drain
          yield* order.CancelOrder("cursor-x")
          yield* drain

          expect(yield* followerLog("cursor-follower")).toEqual([
            "cursor-order#3:OrderPlaced",
            "cursor-order#4:OrderCancelled",
          ])
        }),
      ),
  },
  {
    name: "stages nothing when the subscribing turn fails with a declared error",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const follower = yield* SubFollower.get("refused-follower")
          const refused = yield* follower.FollowThenRefuse("refused-order").pipe(Effect.flip)
          expect(refused).toBeInstanceOf(Refused)
          yield* (yield* SubOrder.get("refused-order")).Place({ customerId: "r", amount: 1 })
          yield* drain

          expect(yield* cursorRows("SubFollower", "refused-follower")).toEqual([])
          expect(yield* outboxOf("SubFollower", "refused-follower", "control")).toBe(0)
          expect(
            (yield* sourceRows("refused-order")).filter(
              (row) => row.subscriber_type === "SubFollower",
            ),
          ).toEqual([])
          expect(yield* followerLog("refused-follower")).toEqual([])
        }),
      ),
  },
  {
    name: "delivers Rejected and deactivates the subscription for a cursor above the source's head",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const order = yield* SubOrder.get("reject-order")
          yield* order.PlaceMany({ customerId: "reject-x", count: 2 })
          const follower = yield* SubFollower.get("reject-follower")
          // The requested cursor becomes the subscriber's `applied`; Rejected still runs.
          yield* follower.Follow({ source: "reject-order", from: "9" })
          yield* drain

          expect(yield* followerLog("reject-follower")).toEqual(["reject-order!rejected:9"])
          expect(yield* cursorRows("SubFollower", "reject-follower")).toEqual([
            {
              subscription: "FollowedOrders",
              source_id: "reject-order",
              epoch: "1",
              active: false,
              applied: "9",
            },
          ])
          expect(
            (yield* sourceRows("reject-order")).filter(
              (row) => row.subscriber_type === "SubFollower",
            ),
          ).toMatchObject([
            { subscriber_id: "reject-follower", epoch: "1", active: false, due: false },
          ])

          // No later event of the source reaches the rejected subscription.
          yield* order.Place({ customerId: "reject-x", amount: 3 })
          yield* drain
          expect(yield* followerLog("reject-follower")).toEqual(["reject-order!rejected:9"])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "subscribes to a source that has never been created, and delivers its first event",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("early-follower")).Follow({ source: "early-order" })
          yield* drain
          expect(yield* sourceRows("early-order")).toMatchObject([
            { subscriber_id: "early-follower", active: true, delivered: "0" },
          ])
          yield* (yield* SubOrder.get("early-order")).Place({ customerId: "early-x", amount: 1 })
          yield* drain

          expect(yield* followerLog("early-follower")).toEqual(["early-order#1:OrderPlaced"])
        }),
      ),
  },
  {
    name: "runs no handler for a delivery in flight when unsubscribe commits",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const follower = yield* SubFollower.get("inflight-follower")
          yield* follower.Follow({ source: "inflight-order" })
          yield* drain

          const pause = yield* pauseOnce(fixture, "beforeDelivery", subscriber("inflight-follower"))
          yield* (yield* SubOrder.get("inflight-order")).Place({ customerId: "i", amount: 1 })
          const draining = yield* drain.pipe(Effect.forkChild)
          yield* pause.reached
          yield* follower.Unfollow("inflight-order")
          yield* pause.release
          yield* Fiber.join(draining)
          yield* drain

          // The delivery carried epoch 1; the subscriber's row was at epoch 2.
          expect(handlerRuns(fixture, "SubFollower/inflight-follower")).toBe(0)
          expect(yield* followerLog("inflight-follower")).toEqual([])
          expect(yield* sourceRows("inflight-order")).toMatchObject([
            { subscriber_id: "inflight-follower", epoch: "2", active: false, due: false },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "keeps the newest epoch when subscribe and unsubscribe control rows are delivered out of order",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const follower = yield* SubFollower.get("order-follower")
          const pause = yield* test.pauseNext("afterClaim")
          yield* follower.Follow({ source: "order-order" })
          // The subscribe control is claimed and held; the unsubscribe replaces
          // its row, and another pass registers it first.
          const draining = yield* drain.pipe(Effect.forkChild)
          yield* pause.reached
          yield* follower.Unfollow("order-order")

          for (;;) {
            const rows = yield* sourceRows("order-order")

            if (rows.some((row) => row.epoch === "2")) break
            yield* Effect.sleep("20 millis")
          }

          yield* pause.release
          yield* Fiber.join(draining)
          yield* (yield* SubOrder.get("order-order")).Place({ customerId: "o", amount: 1 })
          yield* drain

          expect(yield* sourceRows("order-order")).toMatchObject([
            { subscriber_id: "order-follower", epoch: "2", active: false, due: false },
          ])
          expect(yield* followerLog("order-follower")).toEqual([])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: 'runs no stale-epoch delivery after unsubscribe and resubscribe with from: "start", and applies the new epoch from cursor 1',
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const follower = yield* SubFollower.get("resub-follower")
          yield* follower.Follow({ source: "resub-order" })
          yield* drain

          const pause = yield* pauseOnce(fixture, "beforeDelivery", subscriber("resub-follower"))
          yield* (yield* SubOrder.get("resub-order")).Place({ customerId: "r", amount: 1 })
          const draining = yield* drain.pipe(Effect.forkChild)
          yield* pause.reached
          yield* follower.Unfollow("resub-order")
          yield* follower.Follow({ source: "resub-order", from: "start" })

          for (;;) {
            const rows = yield* sourceRows("resub-order")

            if (rows.some((row) => row.epoch === "3")) break
            yield* Effect.sleep("20 millis")
          }

          yield* pause.release
          yield* Fiber.join(draining)
          yield* drain

          // The epoch-1 delivery was stale; epoch 3 replays cursor 1 once.
          expect(yield* followerLog("resub-follower")).toEqual(["resub-order#1:OrderPlaced"])
          expect(handlerRuns(fixture, "SubFollower/resub-follower")).toBe(1)
          expect(yield* cursorRows("SubFollower", "resub-follower")).toMatchObject([
            { epoch: "3", active: true, applied: "1" },
          ])
          expect(yield* sourceRows("resub-order")).toMatchObject([
            { subscriber_id: "resub-follower", epoch: "3", active: true, delivered: "1" },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "makes no change when a control row reruns at the same epoch after a crash",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("rerun-order")
          yield* order.Place({ customerId: "x", amount: 1 })
          yield* test.crashNext("beforeOutboxDelete")
          yield* (yield* SubFollower.get("rerun-follower")).Follow({ source: "rerun-order" })
          yield* drain
          // Registered, but the control row survived the crash.
          expect(yield* outboxOf("SubFollower", "rerun-follower", "control")).toBe(1)
          const registered = yield* sourceRows("rerun-order")
          yield* order.Place({ customerId: "x", amount: 2 })
          yield* drain
          yield* test.advance(CLAIM_LEASE)

          expect(yield* outboxOf("SubFollower", "rerun-follower", "control")).toBe(0)
          expect(yield* followerLog("rerun-follower")).toEqual(["rerun-order#2:OrderPlaced"])
          expect(registered).toMatchObject([{ epoch: "1", delivered: "1" }])
          expect(yield* sourceRows("rerun-order")).toMatchObject([
            { epoch: "1", active: true, delivered: "2" },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "registers a subscription once when the relay dies after the control claim, before the registration statement",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* test.crashNext("afterClaim")
          yield* (yield* SubFollower.get("claimdie-follower")).Follow({ source: "claimdie-order" })
          yield* drain
          expect(yield* sourceRows("claimdie-order")).toEqual([])
          yield* test.advance(CLAIM_LEASE)
          yield* (yield* SubOrder.get("claimdie-order")).Place({ customerId: "c", amount: 1 })
          yield* drain

          expect(yield* followerLog("claimdie-follower")).toEqual(["claimdie-order#1:OrderPlaced"])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
  {
    name: "writes one feed row per publishing turn whatever the subscriber count",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest

          for (const [source, followers] of [
            ["feed-one", 1],
            ["feed-many", 12],
          ] as const) {
            for (let index = 0; index < followers; index++)
              yield* (yield* SubFollower.get(`${source}-f${index}`)).Follow({ source })
            yield* drain

            // Held after the feed row's claim, so it can be counted before expansion deletes it.
            const pause = yield* test.pauseNext("afterClaim")
            yield* (yield* SubOrder.get(source)).PlaceMany({ customerId: "f", count: 3 })
            const draining = yield* drain.pipe(Effect.forkChild)
            yield* pause.reached
            expect(yield* outboxOf("SubOrder", source, "feed")).toBe(1)
            expect(
              (yield* test.inspect({ tenant: test.tenant, actor: "SubOrder", id: source })).outbox,
            ).toBe(0)
            yield* pause.release
            yield* Fiber.join(draining)
            expect(yield* outboxOf("SubOrder", source, "feed")).toBe(0)

            for (let index = 0; index < followers; index++)
              expect((yield* followerLog(`${source}-f${index}`)).length).toBe(3)
          }
        }),
      ),
  },
  {
    name: "writes no feed row for an actor with no subscriptions",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          // OrderNoted has no subscription anywhere; OrderPlaced has only routed ones.
          yield* (yield* SubOrder.get("quiet-order")).Note("nobody listens")
          expect(yield* outboxOf("SubOrder", "quiet-order", "feed")).toBe(0)
          expect(yield* sourceRows("quiet-order")).toEqual([])
        }),
      ),
  },
  {
    name: "probes the tag summary by key with 10^5 non-matching rows",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const sql = yield* SqlClient.SqlClient
          const routingKey = "1"

          yield* sql`INSERT INTO actor_generations (routing_key, tenant_id, actor_type, actor_id)
            SELECT ${routingKey}::bigint, ${test.tenant}, 'SubProbe', 'p' || n
            FROM generate_series(1, 100000) AS n`.pipe(Effect.orDie)
          yield* sql`INSERT INTO actor_subscription_tags (routing_key, tenant_id, source_type, source_id, event, rows)
            SELECT ${routingKey}::bigint, ${test.tenant}, 'SubProbe', 'p' || n, 'OrderPlaced', 1
            FROM generate_series(1, 100000) AS n`.pipe(Effect.orDie)
          yield* sql`ANALYZE actor_subscription_tags`.pipe(Effect.orDie)

          const [row] = yield* sql<{
            "QUERY PLAN": unknown
          }>`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT 1 FROM actor_subscription_tags t
            WHERE t.routing_key = ${routingKey}::bigint AND t.tenant_id = ${test.tenant}
              AND t.source_type = 'SubProbe' AND t.source_id = 'missing' AND t.event IN ('OrderPlaced', 'OrderCancelled')`.pipe(
            Effect.orDie,
          )

          const [explained] = yield* Schema.decodeUnknownEffect(ExplainOutput)(
            row!["QUERY PLAN"],
          ).pipe(Effect.orDie)

          const nodes = planNodes(explained.Plan)
          expect(nodes.some((node) => node["Index Name"] === "actor_subscription_tags_pkey")).toBe(
            true,
          )
          expect(nodes.some((node) => node["Node Type"] === "Seq Scan")).toBe(false)
          expect(explained.Plan["Actual Rows"]).toBe(0)
          // A key lookup reads a handful of index pages, not the 10^5 rows beside it.
          expect(
            nodes.reduce(
              (sum, node) => sum + node["Shared Hit Blocks"] + node["Shared Read Blocks"],
              0,
            ) < 16,
          ).toBe(true)

          yield* sql`DELETE FROM actor_subscription_tags WHERE source_type = 'SubProbe'`.pipe(
            Effect.orDie,
          )
          yield* sql`DELETE FROM actor_generations WHERE actor_type = 'SubProbe'`.pipe(Effect.orDie)
        }),
      ),
  },
  {
    name: "leases the rows an expansion makes due and starts their delivery without a claim pass",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("lease-follower")).Follow({ source: "lease-order" })
          yield* drain

          // Expansion waits, briefly, for the follower's delivery to start: a
          // leased row starts before its feed's expansion ends, a row left due
          // only after a later claim pass.
          const order: Array<string> = []
          const claimed = yield* Deferred.make<void>()
          fixture.hook = (point, request) => {
            if (point === "afterClaim" && request.commandId === "lease-follower") {
              order.push("delivery")

              return Deferred.succeed(claimed, undefined).pipe(Effect.asVoid)
            }

            if (point === "afterExpand" && request.ref.id === "lease-order")
              return Deferred.await(claimed).pipe(
                Effect.timeout("2 seconds"),
                Effect.ignore,
                Effect.andThen(Effect.sync(() => order.push("expanded"))),
              )

            return Effect.void
          }

          yield* (yield* SubOrder.get("lease-order")).Place({ customerId: "l", amount: 1 })
          yield* drain

          expect(order).toEqual(["delivery", "expanded"])
          expect(yield* followerLog("lease-follower")).toEqual(["lease-order#1:OrderPlaced"])
          expect(yield* sourceRows("lease-order")).toMatchObject([
            { delivered: "1", due: false, attempts: 0 },
          ])
        }),
      ),
  },
  {
    name: "loses no wake when a commit races a settle or an expansion",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("race-order")
          yield* (yield* SubFollower.get("race-follower")).Follow({ source: "race-order" })
          yield* drain

          // The settle reads "no matching event after delivered" and pauses;
          // a commit and its expansion land before it writes.
          const pause = yield* test.pauseNext("afterSettleSnapshot")
          yield* order.Place({ customerId: "r", amount: 1 })
          const draining = yield* drain.pipe(Effect.forkChild)
          yield* pause.reached
          yield* order.Place({ customerId: "r", amount: 2 })

          // The relay's own pass expands the second commit's feed meanwhile.
          for (;;) {
            if ((yield* outboxOf("SubOrder", "race-order", "feed")) === 0) break
            yield* Effect.sleep("20 millis")
          }

          yield* pause.release
          yield* Fiber.join(draining)
          yield* drain

          expect(yield* followerLog("race-follower")).toEqual([
            "race-order#1:OrderPlaced",
            "race-order#2:OrderPlaced",
          ])
          expect(yield* sourceRows("race-order")).toMatchObject([{ delivered: "2", due: false }])
        }),
      ),
  },
  {
    name: "keeps a backing-off row's due time when new commits expand the feed",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("backoff-order")
          yield* (yield* SubFollower.get("backoff-follower")).Follow({ source: "backoff-order" })
          yield* drain
          fixture.behave = (entry) =>
            entry.startsWith("SubFollower/backoff-follower/") ? "defect" : "apply"
          yield* order.Place({ customerId: "b", amount: 1 })
          yield* drain

          const due = () =>
            query(
              (sql) => sql<{ due_at_ms: string }>`SELECT due_at_ms::text AS due_at_ms
                FROM actor_subscriptions WHERE tenant_id = ${test.tenant}
                  AND source_id = 'backoff-order' AND subscriber_id = 'backoff-follower'`,
            ).pipe(Effect.map((rows) => rows[0]!.due_at_ms))

          const backingOff = yield* due()
          yield* order.Place({ customerId: "b", amount: 2 })
          yield* drain
          expect(yield* due()).toBe(backingOff)
          const [backedOff] = yield* sourceRows("backoff-order")
          expect(backedOff).toMatchObject({ delivered: "0", attempts: 1 })
          expect(backedOff!.last_error?.includes("Handler defect")).toBe(true)

          fixture.behave = () => "apply"
          yield* test.advance(CLAIM_LEASE)
          expect(yield* followerLog("backoff-follower")).toEqual([
            "backoff-order#1:OrderPlaced",
            "backoff-order#2:OrderPlaced",
          ])
        }),
      ),
  },
  {
    name: "acknowledges a redelivery whose receipt was pruned without running the handler",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("pruned-follower")).Follow({ source: "pruned-order" })
          yield* drain
          // The subscriber commits; the relay dies before its settle.
          crashOnce(fixture, "beforeSettle", subscriber("pruned-follower"))
          yield* (yield* SubOrder.get("pruned-order")).Place({ customerId: "p", amount: 1 })
          yield* drain
          expect(handlerRuns(fixture, "SubFollower/pruned-follower")).toBe(1)
          expect(yield* sourceRows("pruned-order")).toMatchObject([{ delivered: "0" }])

          yield* query(
            (sql) => sql`DELETE FROM actor_receipts WHERE tenant_id = ${test.tenant}
              AND actor_type = 'SubFollower' AND actor_id = 'pruned-follower' AND command = 'OnOrder'`,
          )
          yield* test.advance(CLAIM_LEASE)

          expect(handlerRuns(fixture, "SubFollower/pruned-follower")).toBe(1)
          expect(yield* followerLog("pruned-follower")).toEqual(["pruned-order#1:OrderPlaced"])
          expect(yield* sourceRows("pruned-order")).toMatchObject([{ delivered: "1", due: false }])
        }),
      ),
  },
  {
    name: "applies each committed source event once when the relay dies before and after the subscriber's commit",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("crash-order")
          yield* (yield* SubFollower.get("crash-follower")).Follow({ source: "crash-order" })
          yield* drain

          // The subscriber's delivery turn dies before its commit, once.
          const commit = crashOnce(fixture, "beforeCommit", subscriber("crash-follower"))
          yield* order.Place({ customerId: "c", amount: 1 })
          yield* drain
          expect(commit.crashed).toBe(true)
          const settle = crashOnce(fixture, "beforeSettle", subscriber("crash-follower"))
          yield* order.Place({ customerId: "c", amount: 2 })
          yield* drain
          expect(settle.crashed).toBe(true)
          yield* test.advance(CLAIM_LEASE)
          yield* test.advance(CLAIM_LEASE)

          expect(yield* followerLog("crash-follower")).toEqual([
            "crash-order#1:OrderPlaced",
            "crash-order#2:OrderPlaced",
          ])
          expect(
            yield* test.receiptsFor(
              { tenant: test.tenant, actor: "SubFollower", id: "crash-follower" },
              "OnOrder",
            ),
          ).toBe(2)
        }),
      ),
  },
  {
    name: "refuses a stale runner's delivery below the applied cursor after a lease takeover",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("stale-follower")).Follow({ source: "stale-order" })
          yield* drain
          yield* (yield* SubOrder.get("stale-order")).PlaceMany({ customerId: "s", count: 2 })
          yield* drain
          yield* query(
            (sql) => sql`DELETE FROM actor_receipts WHERE tenant_id = ${test.tenant}
              AND actor_type = 'SubFollower' AND actor_id = 'stale-follower'`,
          )

          const stale = yield* deliveryRequest({
            subscriber: "stale-follower",
            source: "stale-order",
            epoch: "1",
            cursor: "1",
          })

          expect(yield* internal.deliver(stale)).toEqual(
            Outcome.cases.Acknowledged.make({ reason: "AlreadyApplied" }),
          )

          const older = yield* deliveryRequest({
            subscriber: "stale-follower",
            source: "stale-order",
            epoch: "0",
            cursor: "2",
          })

          expect(yield* internal.deliver(older)).toEqual(
            Outcome.cases.Acknowledged.make({ reason: "Stale" }),
          )
          expect(handlerRuns(fixture, "SubFollower/stale-follower")).toBe(2)
        }),
      ),
  },
  {
    name: "advances past a declared failure and replays its receipt",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("declared-follower")).Follow({ source: "declared-order" })
          yield* drain
          fixture.behave = (entry) => (entry.endsWith("#1:OrderPlaced") ? "refuse" : "apply")
          yield* (yield* SubOrder.get("declared-order")).PlaceMany({ customerId: "d", count: 2 })
          yield* drain

          // The refused delivery committed only its receipt, and the next one followed.
          expect(yield* followerLog("declared-follower")).toEqual(["declared-order#2:OrderPlaced"])
          expect(yield* cursorRows("SubFollower", "declared-follower")).toMatchObject([
            { applied: "2" },
          ])

          const replay = yield* internal.deliver(
            yield* deliveryRequest({
              subscriber: "declared-follower",
              source: "declared-order",
              epoch: "1",
              cursor: "1",
            }),
          )

          expect(Outcome.guards.Failure(replay)).toBe(true)
          expect(handlerRuns(fixture, "SubFollower/declared-follower")).toBe(2)
        }),
      ),
  },
  {
    name: "replays after a schema-compatible deploy instead of CommandConflict",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const internal = yield* InternalActors
          yield* (yield* SubFollower.get("deploy-follower")).Follow({ source: "deploy-order" })
          yield* drain
          yield* (yield* SubOrder.get("deploy-order")).Place({ customerId: "d", amount: 1 })
          yield* drain

          // The same delivery re-encoded with a field a newer schema added.
          const redelivered = yield* deliveryRequest({
            subscriber: "deploy-follower",
            source: "deploy-order",
            epoch: "1",
            cursor: "1",
            extra: true,
          })

          expect(Outcome.guards.Success(yield* internal.deliver(redelivered))).toBe(true)
          expect(handlerRuns(fixture, "SubFollower/deploy-follower")).toBe(1)
        }),
      ),
  },
  {
    name: "derives distinct command ids for two subscriptions, two subscribers, and two epochs of one source",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const subscriber = { tenant: "t", actor: "SubFollower", id: "a" }

          const envelope: SubscriptionEnvelope = {
            subscription: "FollowedOrders",
            sourceType: "SubOrder",
            sourceId: "o",
            epoch: "1",
            kind: "event",
            position: "1",
          }

          const ids = yield* Effect.forEach(
            [
              [subscriber, envelope],
              [subscriber, { ...envelope, subscription: "Other" }],
              [{ ...subscriber, id: "b" }, envelope],
              [subscriber, { ...envelope, epoch: "2" }],
              [subscriber, { ...envelope, kind: "gap" as const }],
            ] as const,
            ([ref, env]) =>
              deliveryCommandId({
                subscriber: ref,
                envelope: env,
                issuedAt: 1_000,
                retryWindowMs: 60_000,
              }),
          )

          expect(new Set(ids).size).toBe(ids.length)
          // A redelivery repeats its id.
          expect(
            yield* deliveryCommandId({
              subscriber,
              envelope,
              issuedAt: 1_000,
              retryWindowMs: 60_000,
            }),
          ).toBe(ids[0])

          for (const id of ids) {
            expect(Schema.is(InternalCommandId)(id)).toBe(true)
            expect(id.startsWith("v1.1000.61000.")).toBe(true)
            expect(id.split(".")[3]![14]).toBe("8")
          }
        }),
      ),
  },
  {
    name: "accepts a version-8 derived id on System delivery and rejects it at external admission",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("external-follower")).Follow({ source: "external-order" })
          yield* drain
          yield* (yield* SubOrder.get("external-order")).Place({ customerId: "e", amount: 1 })
          yield* drain
          expect(handlerRuns(fixture, "SubFollower/external-follower")).toBe(1)

          const delivery = yield* deliveryRequest({
            subscriber: "external-follower",
            source: "external-order",
            epoch: "1",
            cursor: "1",
          })

          // An external caller can't present the envelope, the subscription
          // caller, or the derived id.
          const withEnvelope = yield* executeForTest(delivery).pipe(Effect.flip)
          expect(withEnvelope.reason._tag).toBe("Unauthorized")

          const { delivery: _, ...bare } = delivery
          const withCaller = yield* executeForTest(Request.make(bare)).pipe(Effect.flip)
          expect(withCaller.reason._tag).toBe("Unauthorized")

          const asUser = yield* executeForTest(
            Request.make({
              ...bare,
              ref: { ...bare.ref, actor: "SubFollower" },
              caller: User.make({ subject: "alice" }),
              command: "Touch",
              payload: "{}",
            }),
          ).pipe(Effect.flip)

          expect(asUser.reason._tag).toBe("InvalidCommandId")
          expect(handlerRuns(fixture, "SubFollower/external-follower")).toBe(1)
        }),
      ),
  },
  {
    name: "delivers nothing for a rolled-back source turn",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          yield* (yield* SubFollower.get("rollback-follower")).Follow({ source: "rollback-order" })
          yield* drain
          const order = yield* SubOrder.get("rollback-order")
          expect(yield* order.PlaceThenRefuse("rb").pipe(Effect.flip)).toBeInstanceOf(Refused)
          yield* order.PlaceThenDie("rb").pipe(Effect.exit)
          yield* drain

          expect(yield* outboxOf("SubOrder", "rollback-order", "feed")).toBe(0)
          expect(yield* followerLog("rollback-follower")).toEqual([])
          expect(yield* logOf("SubSummary", "rb")).toEqual([])
          expect(handlerRuns(fixture, "SubFollower/rollback-follower")).toBe(0)
        }),
      ),
  },
  {
    name: "skips a stuck row's events through a cursor for an operator, records the skip, and delivers a marker for the range",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const operators = yield* OperatorRuntime
          const follower = yield* SubFollower.get("skip-follower")
          yield* follower.Follow({ source: "skip-a" })
          yield* drain
          fixture.behave = (entry) => (entry.includes("/skip-a#2:") ? "defect" : "apply")
          yield* (yield* SubOrder.get("skip-a")).PlaceMany({ customerId: "s", count: 3 })
          yield* drain

          const [stuck] = yield* sourceRows("skip-a")
          expect(stuck).toMatchObject({ delivered: "1", attempts: 1 })

          const skipped = yield* operators
            .skip({
              target: { tenant: test.tenant, actorType: "SubOrder", actorId: "skip-a" },
              subscriberType: "SubFollower",
              subscription: "FollowedOrders",
              subscriberId: "skip-follower",
              through: "2",
              audit: {
                operator: "oncall",
                action: "subscriptions.skip",
                tenant: test.tenant,
                actorType: "SubOrder",
                actorId: "skip-a",
                target: "SubFollower.FollowedOrders/skip-follower",
                capability: Option.none(),
                reason: "bad payload",
              },
            })
            .pipe(Effect.exit)

          expect(Exit.isSuccess(skipped)).toBe(true)

          fixture.behave = () => "apply"
          yield* drain

          expect(yield* followerLog("skip-follower")).toEqual([
            "skip-a#1:OrderPlaced",
            "skip-a~gap:1-2",
            "skip-a#3:OrderPlaced",
          ])
          expect(yield* sourceRows("skip-a")).toMatchObject([
            { delivered: "3", attempts: 0, last_error: null },
          ])

          const audit = yield* query(
            (sql) => sql<{ action: string; reason: string | null; outcome: string }>`
              SELECT action, reason, outcome FROM durable.operator_audit
              WHERE tenant_id = ${test.tenant} AND actor_id = 'skip-a'`,
          )

          expect(audit.length).toBe(1)
          expect(audit[0]).toMatchObject({ action: "subscriptions.skip", reason: "bad payload" })
          expect(audit[0]!.outcome).toContain('"after":"1"')
          expect(audit[0]!.outcome).toContain('"through":"2"')

          const again = yield* operators
            .skip({
              target: { tenant: test.tenant, actorType: "SubOrder", actorId: "skip-a" },
              subscriberType: "SubFollower",
              subscription: "FollowedOrders",
              subscriberId: "skip-follower",
              through: "3",
              audit: {
                operator: "oncall",
                action: "subscriptions.skip",
                tenant: test.tenant,
                capability: Option.none(),
              },
            })
            .pipe(Effect.exit)

          expect(Exit.isFailure(again)).toBe(true)
        }),
      ),
  },
  {
    name: "holds later events behind a failing one on the same row only, and interleaves two sources",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const follower = yield* SubFollower.get("hold-follower")
          yield* follower.Follow({ source: "hold-a" })
          yield* follower.Follow({ source: "hold-b" })
          yield* drain
          fixture.behave = (entry) => (entry.includes("/hold-a#1:") ? "defect" : "apply")
          yield* (yield* SubOrder.get("hold-a")).PlaceMany({ customerId: "h", count: 2 })
          yield* (yield* SubOrder.get("hold-b")).PlaceMany({ customerId: "h", count: 2 })
          yield* drain

          expect(yield* followerLog("hold-follower")).toEqual([
            "hold-b#1:OrderPlaced",
            "hold-b#2:OrderPlaced",
          ])
          const [held] = yield* sourceRows("hold-a")
          expect(held).toMatchObject({ delivered: "0", attempts: 1 })
          expect(held!.last_error?.includes("Handler defect")).toBe(true)

          fixture.behave = () => "apply"
          yield* test.advance(CLAIM_LEASE)
          expect(yield* followerLog("hold-follower")).toEqual([
            "hold-b#1:OrderPlaced",
            "hold-b#2:OrderPlaced",
            "hold-a#1:OrderPlaced",
            "hold-a#2:OrderPlaced",
          ])
        }),
      ),
  },
  {
    name: "holds a routed source's later events for every routed subscriber while one is blocked, and lets other subscriptions of the same source proceed",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const order = yield* SubOrder.get("blocked-order")
          fixture.behave = (entry) =>
            entry.startsWith("SubSummary/blocked-first/") ? "defect" : "apply"
          yield* order.Place({ customerId: "blocked-first", amount: 1 })
          yield* order.Place({ customerId: "blocked-second", amount: 1 })
          yield* drain

          expect(yield* logOf("SubSummary", "blocked-first")).toEqual([])
          expect(yield* logOf("SubSummary", "blocked-second")).toEqual([])
          // The auditor's own row of the same source is not held back.
          expect(yield* logOf("SubAuditor", "blocked-first")).toEqual([
            "blocked-order#1:OrderPlaced",
          ])
          expect(yield* logOf("SubAuditor", "blocked-second")).toEqual([
            "blocked-order#2:OrderPlaced",
          ])

          const [summary] = yield* sourceRows("blocked-order", "SubSummary")
          expect(summary!.attempts).toBe(1)
          expect(summary!.last_error?.includes("Handler defect")).toBe(true)

          fixture.behave = () => "apply"
          yield* test.advance(CLAIM_LEASE)
          expect(yield* logOf("SubSummary", "blocked-first")).toEqual([
            "blocked-order#1:OrderPlaced",
          ])
          expect(yield* logOf("SubSummary", "blocked-second")).toEqual([
            "blocked-order#2:OrderPlaced",
          ])
        }),
      ),
  },
  {
    name: "retries a defecting delivery with capped backoff and records last_error",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("poison-follower")).Follow({ source: "poison-order" })
          yield* drain
          fixture.behave = (entry) =>
            entry.startsWith("SubFollower/poison-follower/") ? "defect" : "apply"
          yield* (yield* SubOrder.get("poison-order")).Place({ customerId: "p", amount: 1 })
          yield* drain

          for (let attempt = 1; attempt <= 3; attempt++) {
            const [row] = yield* sourceRows("poison-order")
            expect(row).toMatchObject({ attempts: attempt, delivered: "0", due: true })
            expect(row!.last_error?.includes("Handler defect on poison-order#1")).toBe(true)
            yield* test.advance(CLAIM_LEASE)
          }

          expect(handlerRuns(fixture, "SubFollower/poison-follower")).toBe(4)
          expect(yield* followerLog("poison-follower")).toEqual([])
          fixture.behave = () => "apply"
          yield* test.advance("300 seconds")
          expect(yield* followerLog("poison-follower")).toEqual(["poison-order#1:OrderPlaced"])
          expect(yield* sourceRows("poison-order")).toMatchObject([
            { attempts: 0, last_error: null, delivered: "1" },
          ])
        }),
      ),
  },
  {
    name: "backs a routed row off with last_error when route returns an id the key schema rejects",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          // SubSummary is keyed by a string; an empty id fails its key schema.
          const order = yield* SubOrder.get("badroute-order")
          yield* order.Place({ customerId: "", amount: 1 })
          yield* order.Place({ customerId: "badroute-ok", amount: 1 })
          yield* drain

          const [summary] = yield* sourceRows("badroute-order", "SubSummary")
          expect(summary!.delivered).toBe("0")
          expect(summary!.last_error?.startsWith("Route failed")).toBe(true)
          // Later events wait behind the undeliverable one.
          expect(yield* logOf("SubSummary", "badroute-ok")).toEqual([])
          yield* test.advance(CLAIM_LEASE)
          expect(yield* logOf("SubSummary", "badroute-ok")).toEqual([])
        }),
      ),
  },
  {
    name: "keeps equal source ids in two tenants apart",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("tenant-follower")).Follow({ source: "tenant-order" })
          yield* drain
          const other = `${test.tenant}-other`
          yield* Effect.gen(function* () {
            yield* (yield* SubOrder.get("tenant-order")).Place({
              customerId: "tenant-c",
              amount: 1,
            })
          }).pipe(Effect.provideService(Tenant, other))
          yield* drain

          expect(yield* followerLog("tenant-follower")).toEqual([])
          // The other tenant's routed subscriber got its own event.

          const { state } = yield* test.inspect({
            tenant: other,
            actor: "SubSummary",
            id: "tenant-c",
          })

          expect(state).toEqual({ log: ["tenant-order#1:OrderPlaced"] })

          yield* (yield* SubOrder.get("tenant-order")).Place({ customerId: "tenant-c", amount: 2 })
          yield* drain
          expect(yield* followerLog("tenant-follower")).toEqual(["tenant-order#1:OrderPlaced"])
        }),
      ),
  },
  {
    name: "dies when a non-subscription System caller reaches a handler, and hides handlers from X.intents",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const { system } = yield* test.actor(SubFollower, "forged-follower")

          const forged = yield* system
            .OnOrder(
              OrderDelivery.members[2].make({
                subscription: "FollowedOrders",
                source: { tenant: test.tenant, actor: "SubOrder", id: "forged" },
                reason: "UnknownCursor",
                cursor: "1",
              }),
            )
            .pipe(Effect.exit)

          expect(
            Exit.isFailure(forged) &&
              Cause.pretty(forged.cause).includes(
                "Subscription handlers accept only subscription deliveries",
              ),
          ).toBe(true)
          expect(handlerRuns(fixture, "SubFollower/forged-follower")).toBe(0)
          expect(yield* (yield* SubFollower.get("forged-follower")).IntentKeys()).toEqual([
            "Follow",
            "FollowJournal",
            "FollowThenRefuse",
            "IntentKeys",
            "Touch",
            "Unfollow",
          ])
        }),
      ),
  },
  {
    name: "records System subscription attribution on the delivery, and continues after the subscribing caller's access is revoked",
    run: ({ expect, environment, fixture }) =>
      run(
        environment,
        fixture.subscriptions,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("revoked-follower")).Follow({ source: "revoked-order" })
          yield* drain
          yield* (yield* SubOrder.get("revoked-order")).Place({ customerId: "v", amount: 1 })
          fixture.allowed = false
          yield* drain.pipe(Effect.ensuring(Effect.sync(() => (fixture.allowed = true))))

          expect(yield* followerLog("revoked-follower")).toEqual(["revoked-order#1:OrderPlaced"])
          expect(fixture.subscriptions.callers.get("revoked-order#1:OrderPlaced")).toEqual(
            System.make({
              source: "subscription",
              ref: { tenant: test.tenant, actor: "SubOrder", id: "revoked-order" },
            }),
          )
        }),
      ),
  },
  {
    name: "delivers a class added to a dynamic subscription by a deploy, and never narrows a row",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      Effect.gen(function* () {
        const tenant = yield* Effect.promise(() =>
          run(
            environment,
            fixture,
            Effect.gen(function* () {
              const test = yield* ActorTest
              yield* (yield* SubFollower.get("widen-follower")).Follow({ source: "widen-order" })
              yield* drain
              // The row as a deployment that declared only OrderPlaced left it.
              yield* query(
                (sql) => sql`UPDATE actor_subscriptions SET events = ARRAY['OrderPlaced']
                  WHERE tenant_id = ${test.tenant} AND source_id = 'widen-order'
                    AND subscriber_id = 'widen-follower'`,
              )
              yield* query(
                (sql) => sql`DELETE FROM actor_subscription_tags WHERE tenant_id = ${test.tenant}
                  AND source_id = 'widen-order' AND event = 'OrderCancelled'`,
              )
              expect(yield* tagMismatches).toEqual([])

              return test.tenant
            }),
          ),
        )

        // A runner starting with the wider declaration widens the row once.
        yield* environment.restart

        yield* Effect.promise(() =>
          run(
            environment,
            fixture,
            Effect.gen(function* () {
              const events = query(
                (sql) => sql<{ events: string }>`SELECT to_jsonb(events)::text AS events
                  FROM actor_subscriptions WHERE tenant_id = ${tenant}
                    AND source_id = 'widen-order' AND subscriber_id = 'widen-follower'`,
              )

              expect((yield* events)[0]!.events).toBe('["OrderCancelled", "OrderPlaced"]')
              expect(yield* tagMismatches).toEqual([])
              yield* Effect.gen(function* () {
                yield* (yield* SubOrder.get("widen-order")).CancelOrder("w")
              }).pipe(Effect.provideService(Tenant, tenant))
              yield* drain

              const { state } = yield* (yield* ActorTest).inspect({
                tenant,
                actor: "SubFollower",
                id: "widen-follower",
              })

              expect(state).toEqual({ log: ["widen-order#1:OrderCancelled"] })
            }),
          ),
        )
      }).pipe(Effect.runPromise),
  },
  {
    name: "fails registration of a source served without a subscriber type that routes from it",
    // Two runtimes share one fresh database, which PGlite can't give two layer builds.
    requiresIndependentConnections: true,
    run: ({ expect, environment }) =>
      environment.run(
        Effect.gen(function* () {
          const database = yield* environment.freshDatabase

          const runtime = <A>(record: Effect.Effect<A, never, SqlClient.SqlClient>) =>
            Layer.build(
              // Fresh, so this runtime registers the source itself rather than
              // reusing the build the shared runtime already made.
              Layer.fresh(subOrderLayer).pipe(
                Layer.provideMerge(
                  ActorTest.layer({ database, authorize: () => Effect.succeed(true) }),
                ),
              ),
            ).pipe(
              Effect.flatMap((context) => record.pipe(Effect.provideContext(context))),
              Effect.scoped,
              Effect.exit,
            )

          // With no routed declaration recorded, the source registers alone.
          const alone = yield* runtime(
            // A subscriber type on another runner records its routed declaration.
            query(
              (
                sql,
              ) => sql`INSERT INTO actor_routed_subscriptions (source_type, subscriber_type, subscription)
                VALUES ('SubOrder', 'SubSummary', 'CustomerOrders')`,
            ),
          )

          expect(Exit.isSuccess(alone)).toBe(true)

          const partial = yield* runtime(Effect.void)

          expect(
            Exit.isFailure(partial) &&
              Cause.pretty(partial.cause).includes(
                "Actor SubOrder is registered without the subscriber types that route from it",
              ),
          ).toBe(true)
        }),
      ),
    timeoutMs: 60_000,
  },
  {
    name: "keeps the tag summary equal to the rows after every insert, widen, and delete",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const followers = ["tags-a", "tags-b", "tags-c"]

          for (const id of followers)
            yield* (yield* SubFollower.get(id)).Follow({ source: "tags-order" })
          yield* drain
          expect(yield* tagMismatches).toEqual([])

          const counts = () =>
            query(
              (sql) => sql<{
                event: string
                rows: number
              }>`SELECT event, rows FROM actor_subscription_tags
                WHERE tenant_id = ${test.tenant} AND source_id = 'tags-order' ORDER BY event`,
            )

          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 3 },
            { event: "OrderPlaced", rows: 3 },
          ])
          yield* (yield* SubFollower.get("tags-b")).Unfollow("tags-order")
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 2 },
            { event: "OrderPlaced", rows: 2 },
          ])
          // The first routed commit inserts the routed rows and adds their tags.
          yield* (yield* SubOrder.get("tags-order")).Place({ customerId: "tags-x", amount: 1 })
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 4 },
            { event: "OrderPlaced", rows: 5 },
          ])
          yield* (yield* SubFollower.get("tags-a")).Unfollow("tags-order")
          yield* (yield* SubFollower.get("tags-c")).Unfollow("tags-order")
          yield* drain
          expect(yield* counts()).toEqual([
            { event: "OrderCancelled", rows: 2 },
            { event: "OrderPlaced", rows: 3 },
          ])
          expect(yield* tagMismatches).toEqual([])
        }),
      ),
  },
]

const journalRow = (source: string, subscriberType: string) =>
  Effect.gen(function* () {
    const test = yield* ActorTest

    return (yield* query(
      (sql) => sql<{ delivered: string; gaps: string; gap_through: string | null }>`
        SELECT delivered::text AS delivered, gaps::text AS gaps, gap_through::text AS gap_through
        FROM actor_subscriptions WHERE tenant_id = ${test.tenant} AND source_type = 'SubJournal'
          AND source_id = ${source} AND subscriber_type = ${subscriberType}`,
    ))[0]
  })

const journalEvents = (source: string) =>
  ActorTest.use((test) =>
    test
      .inspect({ tenant: test.tenant, actor: "SubJournal", id: source })
      .pipe(Effect.map((inspection) => inspection.events)),
  )

/** Wake, retention holds, gaps, broadcasts, and workflow waits. */
export const subscriptionsRetentionConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "keeps events above the lowest subscriber cursor inside the hold, then prunes past it and delivers one RetentionGap, then resumes",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("hold-j")
          yield* (yield* SubFollower.get("hold-f")).FollowJournal({ source: "hold-j" })
          yield* drain
          fixture.behave = (entry) => (entry.startsWith("SubFollower/hold-f/") ? "defect" : "apply")
          yield* journal.Record({ customerId: "hold-c", count: 3 })
          yield* drain

          // Past keepEvents but inside the hold: the blocked follower keeps them.
          yield* test.advance("90 minutes")
          yield* test.cleanup
          expect(yield* journalEvents("hold-j")).toBe(3)

          // Past keepEvents plus the hold: pruned although the follower is behind.
          yield* test.advance("40 minutes")
          yield* test.cleanup
          expect(yield* journalEvents("hold-j")).toBe(0)

          fixture.behave = () => "apply"
          yield* journal.Record({ customerId: "hold-c", count: 1 })
          yield* test.advance("300 seconds")

          expect(yield* followerLog("hold-f")).toEqual(["hold-j~gap:0-3", "hold-j#4:OrderPlaced"])
          expect(yield* journalRow("hold-j", "SubFollower")).toMatchObject({
            delivered: "4",
            gap_through: null,
          })
        }),
      ),
  },
  {
    name: 'reports RetentionGap first for a from: "start" subscription after pruning',
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("pruned-j")
          yield* journal.Record({ customerId: "pruned-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup
          yield* journal.Record({ customerId: "pruned-c", count: 1 })
          yield* (yield* SubFollower.get("pruned-jf")).FollowJournal({
            source: "pruned-j",
            from: "start",
          })
          yield* drain

          expect(yield* followerLog("pruned-jf")).toEqual([
            "pruned-j~gap:0-2",
            "pruned-j#3:OrderPlaced",
          ])
        }),
      ),
  },
  {
    name: "counts an id-routed gap on the row and delivers a singleton-routed gap",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("routegap-j")
          fixture.behave = (entry) => (entry.includes("/routegap-j#") ? "defect" : "apply")
          yield* journal.Record({ customerId: "routegap-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup
          expect(yield* journalEvents("routegap-j")).toBe(0)

          fixture.behave = () => "apply"
          yield* journal.Record({ customerId: "routegap-c", count: 1 })
          yield* test.advance("300 seconds")

          // The id route had no event to name a subscriber by, so it counted the gap.
          expect(yield* logOf("SubSummary", "routegap-c")).toEqual(["routegap-j#3:OrderPlaced"])
          expect(yield* journalRow("routegap-j", "SubSummary")).toMatchObject({
            gaps: "1",
            delivered: "3",
          })
          expect(
            (yield* logOf("SubDashboard", "singleton")).filter((entry) =>
              entry.startsWith("routegap-j"),
            ),
          ).toEqual(["routegap-j~gap:0-2", "routegap-j#3:OrderPlaced"])
          expect(yield* journalRow("routegap-j", "SubDashboard")).toMatchObject({ gaps: "0" })
        }),
      ),
  },
  {
    name: "repeats a gap's id and range on redelivery after pruning advances",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const journal = yield* SubJournal.get("repeat-j")
          yield* (yield* SubFollower.get("repeat-f")).FollowJournal({ source: "repeat-j" })
          yield* drain
          fixture.behave = (entry) =>
            entry.startsWith("SubFollower/repeat-f/") ? "defect" : "apply"
          yield* journal.Record({ customerId: "repeat-c", count: 2 })
          yield* drain
          yield* test.advance("3 hours")
          yield* test.cleanup

          // The gap and the next event commit; the relay dies before settling them.
          fixture.behave = () => "apply"
          const settle = crashOnce(fixture, "beforeSettle", subscriber("repeat-f"))
          yield* journal.Record({ customerId: "repeat-c", count: 1 })
          yield* test.advance("300 seconds")
          expect(settle.crashed).toBe(true)
          expect(yield* journalRow("repeat-j", "SubFollower")).toMatchObject({
            delivered: "0",
            gap_through: "2",
          })

          // Pruning moves past event 3 before the redelivery.
          yield* test.advance("3 hours")
          yield* test.cleanup
          expect(yield* journalEvents("repeat-j")).toBe(0)
          yield* test.advance(CLAIM_LEASE)
          yield* test.advance("300 seconds")

          expect(yield* followerLog("repeat-f")).toEqual([
            "repeat-j~gap:0-2",
            "repeat-j#3:OrderPlaced",
          ])
          // The redelivery replayed both receipts: each handler ran once.

          for (const entry of ["repeat-j~gap:0-2", "repeat-j#3:OrderPlaced"])
            expect(
              fixture.runs.filter((run) => run === `SubFollower/repeat-f/${entry}`).length,
            ).toBe(1)
          expect(yield* journalRow("repeat-j", "SubFollower")).toMatchObject({
            delivered: "3",
            gap_through: null,
          })
        }),
      ),
  },
  {
    name: "wakes a hibernated subscriber and commits the delivery",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          yield* (yield* SubFollower.get("sleepy-f")).Follow({ source: "sleepy-o" })
          yield* drain
          yield* test.hibernate({ tenant: test.tenant, actor: "SubFollower", id: "sleepy-f" })
          yield* (yield* SubOrder.get("sleepy-o")).Place({ customerId: "s", amount: 1 })
          yield* drain

          expect(yield* followerLog("sleepy-f")).toEqual(["sleepy-o#1:OrderPlaced"])
        }),
      ),
  },
  {
    name: "flushes a delivery's broadcast to the parked subscriber's connection after commit, and discards it on declared failure",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const test = yield* ActorTest
          const ref = { tenant: test.tenant, actor: "SubSummary", id: "live-c" }
          const connection = yield* test.connect(ref, Live, undefined)
          // The subscriber parks with the connection open at its holder.
          yield* test.hibernate(ref)
          fixture.behave = (entry) => (entry.includes("live-o#1:") ? "refuse" : "apply")
          const order = yield* SubOrder.get("live-o")
          yield* order.Place({ customerId: "live-c", amount: 1 })
          yield* order.Place({ customerId: "live-c", amount: 2 })
          yield* drain

          const frames = yield* connection.frames.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
          )

          expect(Array.from(frames)).toEqual(["live-o#2:OrderPlaced"])
          expect(yield* logOf("SubSummary", "live-c")).toEqual(["live-o#2:OrderPlaced"])
          yield* connection.close
        }),
      ),
  },
  {
    name: "resolves an owner wait from a subscription delivery that re-emits",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          const shipment = yield* SubShipment.get("wf-ship")
          const execution = yield* shipment.PlaceOrder("wf-order")
          const workflow = yield* SubShipment.run(ShipOrder, execution)
          yield* drain
          yield* (yield* SubOrder.get("wf-order")).Place({ customerId: "wf", amount: 1 })
          yield* drain

          expect(yield* workflow.result.pipe(Effect.timeout("20 seconds"))).toBe("paid")
        }),
      ),
  },
  {
    name: "subscribes in the workflow's start turn and delivers after the start commits",
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      run(
        environment,
        fixture,
        Effect.gen(function* () {
          // The event is committed before the subscription exists; from: "start" replays it.
          yield* (yield* SubOrder.get("wf-early")).Place({ customerId: "wf", amount: 1 })
          const shipment = yield* SubShipment.get("wf-early-ship")
          const execution = yield* shipment.PlaceOrder("wf-early")
          const workflow = yield* SubShipment.run(ShipOrder, execution)
          yield* drain

          expect(yield* workflow.result.pipe(Effect.timeout("20 seconds"))).toBe("paid")
        }),
      ),
  },
]

/** Builds a fresh database and `runners` runners on it for one case. */
const withCluster = <A, E>(
  environment: ConformanceEnvironment,
  fixture: SubscriptionsFixture,
  runners: number,
  body: Effect.Effect<A, E, ActorCluster>,
  holdersOnly?: ReadonlyArray<number>,
) =>
  environment.run(
    Effect.gen(function* () {
      yield* reset(fixture)
      const database = yield* environment.freshDatabase

      const context = yield* Layer.build(
        ActorTest.cluster({
          database,
          runners,
          holdersOnly,
          shardLockExpiration: "3 seconds",
          actors: subscriptionsLayer(fixture),
          as: User.make({ subject: "alice" }),
          relay: { claimLease: "3 seconds", poll: "200 millis" },
        }),
      )

      return yield* body.pipe(Effect.provideContext(context))
    }),
  )

const on = <A, E, R>(runner: number, effect: Effect.Effect<A, E, R>) =>
  ActorCluster.use((cluster) => cluster.on(runner)(effect))

export const subscriptionsClusterConformance: ReadonlyArray<ConformanceCase> = [
  {
    name: "wakes a subscriber parked on another runner and flushes the delivery's broadcast to its holder",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      withCluster(
        environment,
        fixture,
        3,
        Effect.gen(function* () {
          const cluster = yield* ActorCluster
          yield* cluster.ready
          // Runner 0 holds the connection and is never assigned the subscriber's shard.
          const holder = cluster.on(0)
          const tenant = yield* holder(ActorTest.use((test) => Effect.succeed(test.tenant)))
          const ref = { tenant, actor: "SubSummary", id: "cross-c" }
          yield* holder(
            SubSummary.get("cross-c").pipe(Effect.flatMap((summary) => summary.Touch())),
          )

          const connection = yield* holder(
            ActorTest.use((test) => test.connect(ref, Live, undefined)),
          )

          const generation = holder(
            ActorTest.use((test) => test.inspect(ref)).pipe(
              Effect.map(({ generation }) => BigInt(generation!)),
            ),
          )

          // The subscriber parks on its owner with the connection still open at the holder.
          const owner = yield* cluster.owner(ref)
          expect(owner === undefined || owner === 0).toBe(false)
          yield* cluster.on(owner!)(ActorTest.use((test) => test.hibernate(ref)))
          const parked = yield* generation

          yield* holder(
            SubOrder.get("cross-o").pipe(
              Effect.flatMap((order) => order.Place({ customerId: "cross-c", amount: 1 })),
            ),
          )

          const frames = yield* connection.frames.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("30 seconds"),
          )

          expect(Array.from(frames)).toEqual(["cross-o#1:OrderPlaced"])
          expect((yield* generation) > parked).toBe(true)
          expect(yield* holder(logOf("SubSummary", "cross-c"))).toEqual(["cross-o#1:OrderPlaced"])
          yield* connection.close
        }),
        [0],
      ),
  },
  {
    name: "applies one source's events in cursor order under redelivery and two runners",
    requiresIndependentConnections: true,
    timeoutMs: 120_000,
    run: ({ expect, environment, fixture: { subscriptions: fixture } }) =>
      withCluster(
        environment,
        fixture,
        2,
        Effect.gen(function* () {
          const followers = Array.from({ length: 8 }, (_, index) => `cluster-f${index}`)

          for (const [index, id] of followers.entries())
            yield* on(
              index % 2,
              Effect.flatMap(SubFollower.get(id), (f) => f.Follow({ source: "cluster-order" })),
            )

          // Every follower is registered at the source before it publishes.
          for (;;) {
            const registered = yield* on(0, sourceRows("cluster-order"))

            if (registered.filter((row) => row.active).length === followers.length) break
            yield* Effect.sleep("50 millis")
          }

          // One delivery defects once on each runner, so its row is redelivered after the lease.
          const defected = new Set<string>()
          fixture.behave = (entry) => {
            if (entry.includes("#2:") && !defected.has(entry)) {
              defected.add(entry)

              return "defect"
            }

            return "apply"
          }

          for (let round = 0; round < 3; round++)
            yield* on(
              round % 2,
              Effect.flatMap(SubOrder.get("cluster-order"), (o) =>
                o.Place({ customerId: "cluster-c", amount: round }),
              ),
            )

          const expected = ["1", "2", "3"].map((cursor) => `cluster-order#${cursor}:OrderPlaced`)

          for (;;) {
            const logs = yield* on(0, Effect.forEach(followers, followerLog))

            if (logs.every((log) => log.length >= 3)) {
              for (const log of logs) expect(log).toEqual(expected)

              break
            }

            yield* Effect.sleep("100 millis")
          }

          // Each follower committed each event once, whichever runner delivered it.
          for (const id of followers)
            expect(
              yield* on(
                0,
                ActorTest.use((test) =>
                  test.receiptsFor({ tenant: test.tenant, actor: "SubFollower", id }, "OnOrder"),
                ),
              ),
            ).toBe(3)

          expect(yield* on(0, tagMismatches)).toEqual([])
        }).pipe(Effect.timeout("100 seconds"), Effect.orDie),
      ),
  },
]
