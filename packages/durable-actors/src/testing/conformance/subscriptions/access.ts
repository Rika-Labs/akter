import { Cause, Effect, Exit } from "effect"
import { Tenant } from "../../../index.ts"
import { System } from "../../../identity/caller.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { OrderDelivery, SubFollower, SubOrder } from "./actors.ts"
import { drain, followerLog, handlerRuns, run } from "./harness.ts"

/** Tenant isolation, System attribution, and handler access of event subscriptions. */
export const subscriptionAccessConformance: ReadonlyArray<ConformanceCase> = [
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
]
