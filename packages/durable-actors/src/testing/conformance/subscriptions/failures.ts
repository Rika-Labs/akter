import { Effect } from "effect"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { CLAIM_LEASE } from "../outbox.ts"
import { SubFollower, SubOrder } from "./actors.ts"
import { drain, followerLog, handlerRuns, logOf, run, sourceRows } from "./harness.ts"

/** Blocking, ordering, and backoff of failing subscription deliveries. */
export const subscriptionFailureConformance: ReadonlyArray<ConformanceCase> = [
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
          const order = yield* SubOrder.get("badroute-order")
          yield* order.Place({ customerId: "", amount: 1 })
          yield* order.Place({ customerId: "badroute-ok", amount: 1 })
          yield* drain

          const [summary] = yield* sourceRows("badroute-order", "SubSummary")
          expect(summary!.delivered).toBe("0")
          expect(summary!.last_error?.startsWith("Route failed")).toBe(true)
          expect(yield* logOf("SubSummary", "badroute-ok")).toEqual([])
          yield* test.advance(CLAIM_LEASE)
          expect(yield* logOf("SubSummary", "badroute-ok")).toEqual([])
        }),
      ),
  },
]
