import { Effect } from "effect"
import type { ConformanceCase } from "../../conformance.ts"
import { Refused, SubFollower, SubOrder, type SubscriptionsFixture } from "./actors.ts"
import {
  cursorRows,
  drain,
  followerLog,
  logOf,
  outboxOf,
  run,
  sourceRows,
  tagMismatches,
} from "./harness.ts"

/** Routing, start positions, and first delivery of event subscriptions. */
export const subscriptionRoutingConformance: ReadonlyArray<ConformanceCase<SubscriptionsFixture>> =
  [
    {
      name: "routes each event to the id route returns",
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
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
      run: ({ expect, environment, fixture }) =>
        run(
          environment,
          fixture,
          Effect.gen(function* () {
            const order = yield* SubOrder.get("reject-order")
            yield* order.PlaceMany({ customerId: "reject-x", count: 2 })
            const follower = yield* SubFollower.get("reject-follower")
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

            yield* order.Place({ customerId: "reject-x", amount: 3 })
            yield* drain
            expect(yield* followerLog("reject-follower")).toEqual(["reject-order!rejected:9"])
            expect(yield* tagMismatches).toEqual([])
          }),
        ),
    },
    {
      name: "subscribes to a source that has never been created, and delivers its first event",
      run: ({ expect, environment, fixture }) =>
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
  ]
