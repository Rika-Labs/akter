import type { NodeInspectSymbol, Unify } from "../../../actor/definition.ts"
import { Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { Actor, type Caller } from "../../../index.ts"
import { Request } from "../../../runtime/request.ts"
import type { TurnPoint } from "../../../runtime/turn/hooks.ts"

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

export const reset = (fixture: SubscriptionsFixture) =>
  Effect.sync(() => {
    fixture.runs.length = 0
    fixture.callers.clear()
    fixture.behave = () => "apply"
    fixture.during = Effect.void
    fixture.hook = () => Effect.void
  })

export class Refused extends Schema.TaggedError<Refused>()("SubscriptionRefused", {}) {}

export class OrderPlaced extends Actor.Event<OrderPlaced>()("OrderPlaced", {
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

export const SubOrder = Actor.make("SubOrder", {
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
export const SubJournal = Actor.make("SubJournal", {
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

export const OrderDelivery = Actor.Delivery({
  source: SubOrder,
  events: [OrderPlaced, OrderCancelled],
})

export type OrderDelivery = typeof OrderDelivery.Type

const RecordOrder = Actor.command("RecordOrder", { input: OrderDelivery, errors: [Refused] })

/** A customer id whose `CustomerOrders` route throws instead of returning an id. */
export const THROWING_ROUTE = "route-throws"

const CustomerOrders = Actor.subscription("CustomerOrders", {
  source: SubOrder,
  events: [OrderPlaced, OrderCancelled],
  handler: RecordOrder,
  route: (event) => {
    if (event.customerId === THROWING_ROUTE) throw new Error("route threw")

    return event.customerId
  },
})

const CustomerJournals = Actor.subscription("CustomerJournals", {
  source: SubJournal,
  events: [OrderPlaced],
  handler: RecordOrder,
  route: (event) => event.customerId,
})

const Touch = Actor.command("Touch")

/** Each delivery's entry, broadcast after its turn commits. */
export const Live = Actor.connection("SummaryLive", {
  server: Schema.String,
  client: Schema.String,
})

/** A routed projection: every order event reaches the customer it names. */
export const SubSummary = Actor.make("SubSummary", {
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
export const SubFollower = Actor.make("SubFollower", {
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

export const ShipOrder = Actor.workflow("ShipOrder", {
  input: { orderId: Schema.String },
  output: Schema.String,
  key: ({ orderId }) => orderId,
})

const AwaitPayment = ShipOrder.wait("payment-seen", PaymentSeen)

const PlaceOrder = Actor.command("PlaceOrder", {
  input: Schema.String,
  output: Schema.String,
})

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
export const SubShipment = Actor.make("SubShipment", {
  key: Schema.String,
  events: [PaymentSeen],
  api: { ShipOrder, PlaceOrder },
  internal: { OnPayment },
  subscriptions: [PaymentUpdates],
})

/** A source whose only subscriber is `SubGated`, so its routed skips touch no other case. */
export const SubGateOrder = Actor.make("SubGateOrder", {
  key: Schema.String,
  events: [OrderPlaced],
  api: { Place },
  policy: { subscribers: ["SubGated"] },
})

const OnGated = Actor.command("OnGated", {
  input: Actor.Delivery({ source: SubGateOrder, events: [OrderPlaced] }),
})

const GatedOrders = Actor.subscription("GatedOrders", {
  source: SubGateOrder,
  events: [OrderPlaced],
  handler: OnGated,
  route: (event) => event.customerId,
})

const OpenGated = Actor.command("OpenGated")

/** A routed subscriber that exists only once `OpenGated` creates it, so earlier deliveries skip as `NotCreated`. */
export const SubGated = Actor.make("SubGated", {
  key: Schema.String,
  state: Log,
  api: { OpenGated },
  internal: { OnGated },
  subscriptions: [GatedOrders],
  policy: { createdBy: OpenGated },
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
export const subOrderLayer = SubOrder.toLayer(
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
    SubGateOrder.toLayer(
      Effect.succeed({
        Place: Effect.fnUntraced(function* ({ customerId, amount }) {
          yield* (yield* SubGateOrder.Turn).emit(OrderPlaced.make({ customerId, amount }))
        }),
      }),
    ),
    SubGated.toLayer(
      Effect.succeed({
        OpenGated: () => Effect.void,
        OnGated: Effect.fnUntraced(function* (delivery) {
          yield* record(fixture, "SubGated", yield* SubGated.Turn, delivery).pipe(Effect.orDie)
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

export type { NodeInspectSymbol, Unify }
