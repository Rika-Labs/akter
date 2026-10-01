import { Effect, Exit, Option } from "effect"
import { OperatorRuntime } from "../../../runtime/operators/repair.ts"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { SubFollower, SubOrder, type SubscriptionsFixture } from "./actors.ts"
import { drain, followerLog, query, run, sourceRows } from "./harness.ts"

/** Operator skip and listing of stuck subscription rows. */
export const subscriptionOperatorConformance: ReadonlyArray<ConformanceCase<SubscriptionsFixture>> =
  [
    {
      name: "skips a stuck row's events through a cursor for an operator, records the skip, and delivers a marker for the range",
      run: ({ expect, environment, fixture }) =>
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
      name: "lists a failing row with its lag and last error for an operator, and drops it once skipped",
      run: ({ expect, environment, fixture }) =>
        run(
          environment,
          fixture,
          Effect.gen(function* () {
            const test = yield* ActorTest
            const operators = yield* OperatorRuntime
            const follower = yield* SubFollower.get("lag-follower")
            yield* follower.Follow({ source: "lag-a" })
            yield* follower.Follow({ source: "lag-b" })
            yield* drain
            fixture.behave = (entry) => (entry.includes("/lag-a#2:") ? "defect" : "apply")
            yield* (yield* SubOrder.get("lag-a")).PlaceMany({ customerId: "l", count: 3 })
            yield* (yield* SubOrder.get("lag-b")).PlaceMany({ customerId: "l", count: 3 })
            yield* drain

            const page = { tenant: test.tenant, minAttempts: 1, limit: 100 }

            /** Other cases in this file leave their own rows behind in the tenant. */
            const lagging = (input: typeof page) =>
              Effect.map(operators.lagging(input), (rows) =>
                rows.filter((row) => row.sourceId.startsWith("lag-")),
              )

            const failing = yield* lagging(page)

            expect(new Set(failing.map((entry) => entry.sourceId))).toEqual(new Set(["lag-a"]))

            const row = failing.find((entry) => entry.subscriberType === "SubFollower")!

            expect(row).toMatchObject({
              sourceType: "SubOrder",
              sourceId: "lag-a",
              subscriberId: "lag-follower",
              delivered: "1",
              head: "3",
              lag: "2",
              attempts: 1,
            })
            expect(row.lastError).toContain("lag-a#2")
            expect(yield* lagging({ ...page, minAttempts: 8 })).toEqual([])
            expect(yield* lagging({ ...page, tenant: `${test.tenant}-other` })).toEqual([])

            yield* operators.skip({
              target: { tenant: test.tenant, actorType: "SubOrder", actorId: "lag-a" },
              subscriberType: "SubFollower",
              subscription: "FollowedOrders",
              subscriberId: "lag-follower",
              through: "2",
              audit: {
                operator: "oncall",
                action: "subscriptions.skip",
                tenant: test.tenant,
                capability: Option.none(),
                reason: "bad payload",
              },
            })
            fixture.behave = () => "apply"
            yield* drain

            const remaining = (yield* lagging(page)).map((entry) => entry.subscriberType)

            expect(remaining.length).toBe(failing.length - 1)
            expect(remaining).not.toContain("SubFollower")
          }),
        ),
    },
  ]
