import { Effect } from "effect"
import { ActorTest } from "../../actor-test.ts"
import type { ConformanceCase } from "../../conformance.ts"
import { Ledger, Ship, Shipper, type WorkflowsFixture } from "./actors.ts"
import { reset } from "./harness.ts"

/** Turn-staged starts, activity actor calls, and wait registration races of workflows. */
export const workflowStartConformance: ReadonlyArray<ConformanceCase<WorkflowsFixture>> = [
  {
    name: "workflows: a turn stages a start whose wait sees that turn's own event",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const shipper = yield* Shipper.get("staged")
          const id = yield* shipper.Begin({ orderId: "s1", sku: "wait-s" })
          expect(yield* (yield* Shipper.run(Ship, id)).result).toBe("r-wait-s:paid-3")
          const again = yield* shipper.Ship({ orderId: "s1", sku: "wait-s" })
          expect(again.executionId).toBe(id)
          expect(yield* again.result).toBe("r-wait-s:paid-3")
        }),
      ),
  },
  {
    name: "workflows: a start staged by a turn that emits nothing sees an owner event committed before the start is delivered",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const shipper = yield* Shipper.get("deferred")
          const id = yield* shipper.Defer({ orderId: "d1", sku: "wait-d" })
          yield* shipper.Pay({ orderId: "d1", amount: 5 })
          expect(yield* (yield* Shipper.run(Ship, id)).result).toBe("r-wait-d:paid-5")
        }),
      ),
  },
  {
    name: "workflows: activity actor calls get distinct ids per call and reach the receiver once each",
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)
          const test = yield* ActorTest
          const shipper = yield* Shipper.get("charging")
          const run = yield* shipper.Ship({ orderId: "c1", sku: "charge" })
          expect(yield* run.result).toBe("r-charge-1-2:v2")
          const ledger = yield* Ledger.get("c1")
          expect(yield* test.receiptsFor(ledger.ref, "Charge")).toBe(2)
        }),
      ),
  },
  {
    name: "workflows: an event appended while a wait is registering is never lost",
    requiresIndependentConnections: true,
    timeoutMs: 60_000,
    run: ({ expect, environment, fixture }) =>
      environment.run(
        Effect.gen(function* () {
          yield* reset(fixture)

          const results = yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const shipper = yield* Shipper.get(`race-${index}`)
                const orderId = `race-${index}`
                const run = yield* shipper.Ship({ orderId, sku: "wait-race" })
                yield* shipper.Pay({ orderId, amount: index })

                return yield* run.result
              }),
            { concurrency: 5 },
          )

          expect(results).toEqual(
            Array.from({ length: 20 }, (_, index) => `r-wait-race:paid-${index}`),
          )
        }),
      ),
  },
]
