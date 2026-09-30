import { Effect, Fiber } from "effect"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { CLAIM_LEASE } from "../outbox.ts"
import { SubFollower, SubOrder } from "./actors.ts"
import {
  cursorRows,
  drain,
  followerLog,
  handlerRuns,
  outboxOf,
  pauseOnce,
  run,
  sourceRows,
  subscriber,
  tagMismatches,
} from "./harness.ts"

/** Unsubscribe, resubscribe, and control-row epochs of event subscriptions. */
export const subscriptionEpochConformance: ReadonlyArray<ConformanceCase> = [
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
]
