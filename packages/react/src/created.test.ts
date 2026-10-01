import { ActorError, NotCreated, Unauthorized } from "@durable-actors/core/client"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { followCreated } from "./created.ts"

const notCreated = () => ActorError.make({ reason: NotCreated.make({}) })

/** A test given the abort controller that stands for its component's mount. */
const test = <E>(name: string, body: (controller: AbortController) => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body(new AbortController())))

describe("followCreated", () => {
  test("asks again after NotCreated, so an actor created during the wait is followed", (controller) =>
    Effect.gen(function* () {
      const started: Array<number> = []

      const outcome = yield* Effect.promise(() =>
        followCreated(controller.signal, () => {
          started.push(performance.now())

          return started.length === 1 ? Promise.reject(notCreated()) : Promise.resolve()
        }),
      )

      expect(outcome).toBeUndefined()
      expect(started).toHaveLength(2)
      expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(450)
    }))

  test("stops waiting at once when the component unmounts, and never follows again", (controller) =>
    Effect.gen(function* () {
      let started = 0

      const outcome = followCreated(controller.signal, () => {
        started += 1

        return Promise.reject(notCreated())
      })

      yield* Effect.sleep("50 millis")
      const aborting = performance.now()
      controller.abort()

      expect(yield* Effect.promise(() => outcome)).toBeUndefined()
      expect(performance.now() - aborting).toBeLessThan(100)
      yield* Effect.sleep("600 millis")
      expect(started).toBe(1)
    }))

  test("resolves with any other failure without asking again", (controller) =>
    Effect.gen(function* () {
      const denied = ActorError.make({ reason: Unauthorized.make({ code: "access_denied" }) })
      let started = 0

      const outcome = yield* Effect.promise(() =>
        followCreated(controller.signal, () => {
          started += 1

          return Promise.reject(denied)
        }),
      )

      expect(outcome).toBe(denied)
      expect(started).toBe(1)
    }))

  test("ignores how an iteration ends after the component unmounted", (controller) =>
    Effect.gen(function* () {
      const iteration = Promise.withResolvers<void>()
      const outcome = followCreated(controller.signal, () => iteration.promise)

      controller.abort()
      iteration.reject(ActorError.make({ reason: Unauthorized.make({ code: "expired" }) }))

      expect(yield* Effect.promise(() => outcome)).toBeUndefined()
    }))
})
