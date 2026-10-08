import type {
  NodeInspectSymbol,
  Unify,
} from "../../../../../packages/akter/src/actor/definition.ts"
import { Effect, Layer, Match, Option, Predicate, Schema } from "effect"
import { Actor, type Caller } from "../../../../../packages/akter/src/index.ts"
import { Request } from "../../../../../packages/akter/src/runtime/request.ts"
import type { TurnPoint } from "../../../../../packages/akter/src/runtime/turn/hooks.ts"
import type { ConformanceSuite } from "../../conformance.ts"

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

export const OrderPlaced = Actor.event("OrderPlaced", {
  customerId: Schema.String,
  amount: Schema.Finite,
})

const OrderCancelled = Actor.event("OrderCancelled", {
  customerId: Schema.String,
})

const OrderNoted = Actor.event("OrderNoted", { note: Schema.String })

const Place = Actor.command("Place", {
  payload: Schema.Struct({ customerId: Schema.String, amount: Schema.Finite }),
})

const PlaceMany = Actor.command("PlaceMany", {
  payload: Schema.Struct({ customerId: Schema.String, count: Schema.Int }),
})

const CancelOrder = Actor.command("CancelOrder", { payload: Schema.String })

const Note = Actor.command("Note", { payload: Schema.String })

const PlaceThenRefuse = Actor.command("PlaceThenRefuse", {
  payload: Schema.String,
  error: Refused,
})

const PlaceThenDie = Actor.command("PlaceThenDie", { payload: Schema.String })

export const SubOrder = Actor.make("SubOrder", {
  key: Schema.String,
  events: [OrderPlaced, OrderCancelled, OrderNoted],
  api: { Place, PlaceMany, CancelOrder, Note, PlaceThenRefuse, PlaceThenDie },
  policy: {
    allowedSubscriberTypes: [
      "SubSummary",
      "SubFollower",
      "SubDashboard",
      "SubAuditor",
      "SubShipment",
    ],
  },
})

const Record = Actor.command("Record", {
  payload: Schema.Struct({ customerId: Schema.String, count: Schema.Int }),
})

/** A source whose events are pruned after an hour, and held for subscribers one hour more. */
export const SubJournal = Actor.make("SubJournal", {
  key: Schema.String,
  events: [OrderPlaced],
  api: { Record },
  policy: {
    keepEvents: "1 hour",
    holdEventsForSubscribers: "1 hour",
    allowedSubscriberTypes: ["SubSummary", "SubFollower", "SubDashboard"],
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

/** Placements only, from the order source. */
export const PlacedDelivery = Actor.Delivery({ source: SubOrder, events: [OrderPlaced] })

/** Placements from the journal source. */
export const JournalDelivery = Actor.Delivery({ source: SubJournal, events: [OrderPlaced] })

const RecordOrder = Actor.command("RecordOrder", { payload: OrderDelivery, error: Refused })

/** A customer id whose `CustomerOrders` route throws instead of returning an id. */
export const THROWING_ROUTE = "route-throws"

const CustomerOrders = Actor.subscription("CustomerOrders", {
  delivery: OrderDelivery,

  handler: RecordOrder,
  route: (event) => {
    if (event.customerId === THROWING_ROUTE) throw new Error("route threw")

    return event.customerId
  },
})

const CustomerJournals = Actor.subscription("CustomerJournals", {
  delivery: JournalDelivery,

  handler: RecordOrder,
  route: (event) => event.customerId,
})

const Touch = Actor.command("Touch")

/** Each delivery's entry, broadcast after its turn commits. */
export const Live = Actor.connection("SummaryLive", {
  server: Schema.String,
  client: Schema.String,
})

/** A routed projection: every order event reaches the customer it names.
 *
 * @internal
 */
export const SubSummary = Actor.make("SubSummary", {
  key: Schema.String,
  state: Log,
  api: { Touch, SummaryLive: Live },
  internal: { RecordOrder },
  subscriptions: [CustomerOrders, CustomerJournals],
})

const AuditOrder = Actor.command("AuditOrder", { payload: OrderDelivery })

const AuditedOrders = Actor.subscription("AuditedOrders", {
  delivery: OrderDelivery,

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

const OnOrder = Actor.command("OnOrder", { payload: OrderDelivery, error: Refused })

const FollowedOrders = Actor.subscription("FollowedOrders", {
  delivery: OrderDelivery,

  handler: OnOrder,
})

const Follow = Actor.command("Follow", {
  payload: Schema.Struct({ source: Schema.String, from: Schema.optional(Schema.String) }),
})

const FollowThenRefuse = Actor.command("FollowThenRefuse", {
  payload: Schema.String,
  error: Refused,
})

const Unfollow = Actor.command("Unfollow", { payload: Schema.String })

const IntentKeys = Actor.command("IntentKeys", { success: Schema.Array(Schema.String) })

const FollowedJournals = Actor.subscription("FollowedJournals", {
  delivery: JournalDelivery,

  handler: OnOrder,
})

const FollowJournal = Actor.command("FollowJournal", {
  payload: Schema.Struct({ source: Schema.String, from: Schema.optional(Schema.String) }),
})

/** A dynamic subscriber: it follows only the orders its turns subscribe to.
 *
 * @internal
 */
export const SubFollower = Actor.make("SubFollower", {
  key: Schema.String,
  state: Log,
  api: { Follow, FollowThenRefuse, Unfollow, IntentKeys, Touch, FollowJournal },
  internal: { OnOrder },
  subscriptions: [FollowedOrders, FollowedJournals],
})

const CountOrder = Actor.command("CountOrder", {
  payload: PlacedDelivery,
})

const AllOrders = Actor.subscription("AllOrders", {
  delivery: PlacedDelivery,

  handler: CountOrder,
  route: Actor.singleton,
})

const AllJournals = Actor.subscription("AllJournals", {
  delivery: JournalDelivery,

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

const PaymentSeen = Actor.event("PaymentSeen", {
  orderId: Schema.String,
})

export const ShipOrder = Actor.workflow("ShipOrder", {
  payload: { orderId: Schema.String },
  success: Schema.String,
  key: ({ orderId }) => orderId,
})

const AwaitPayment = ShipOrder.wait("payment-seen", PaymentSeen)

const PlaceOrder = Actor.command("PlaceOrder", {
  payload: Schema.String,
  success: Schema.String,
})

const OnPayment = Actor.command("OnPayment", {
  payload: PlacedDelivery,
})

const PaymentUpdates = Actor.subscription("PaymentUpdates", {
  delivery: PlacedDelivery,

  handler: OnPayment,
})

/**
 * A workflow waits only for its owner's events, so the owner follows the
 * order and re-emits what the workflow waits for.
 *
 * @internal
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
  policy: { allowedSubscriberTypes: ["SubGated"] },
})

/** Placements from the gated source. */
export const GatedDelivery = Actor.Delivery({ source: SubGateOrder, events: [OrderPlaced] })

const OnGated = Actor.command("OnGated", { payload: GatedDelivery })

const GatedOrders = Actor.subscription("GatedOrders", {
  delivery: GatedDelivery,

  handler: OnGated,
  route: (event) => event.customerId,
})

const OpenGated = Actor.command("OpenGated")

/**
 * A routed subscriber that exists only once `OpenGated` creates it, so
 * earlier deliveries skip as `NotCreated`.
 *
 * @internal
 */
export const SubGated = Actor.make("SubGated", {
  key: Schema.String,
  state: Log,
  api: { OpenGated },
  internal: { OnGated },
  subscriptions: [GatedOrders],

  createdBy: OpenGated,
})

/** One delivery as a handler logs it: `source#cursor:event`, `source~gap:after-resume`, or `source!rejected:cursor`. */
const entryOf = (delivery: OrderDelivery | typeof CountOrder.payload.Type) =>
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
  delivery: OrderDelivery | typeof CountOrder.payload.Type,
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

/** Subscription actors; cases replace the fixture hook to fault one turn. */
export const subscriptionsSuite: ConformanceSuite<SubscriptionsFixture> = {
  fixture: subscriptionsFixture,
  layer: subscriptionsLayer,
  turn: (fixture) => (point, request) => Effect.suspend(() => fixture.hook(point, request)),
}
