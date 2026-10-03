import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import { fairGate } from "./gate.ts"

describe("first-come, first-served gate", () => {
  it("hands a freed slot to the oldest waiter, not to the fiber that freed it and asks again", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = fairGate(1)
        const order: Array<string> = []
        const held = yield* Deferred.make<void>()
        const free = yield* Deferred.make<void>()

        const holder = yield* Effect.forkChild(
          Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.andThen(
                gate.take,
                Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(free)),
              ),
            )
            yield* Effect.scoped(
              Effect.andThen(
                gate.take,
                Effect.sync(() => order.push("first again")),
              ),
            )
          }),
        )

        yield* Deferred.await(held)

        const waiters = yield* Effect.forEach(["second", "third"], (name) =>
          Effect.forkChild(
            Effect.scoped(
              Effect.andThen(
                gate.take,
                Effect.sync(() => order.push(name)),
              ),
            ),
          ),
        )

        yield* Effect.yieldNow
        expect(gate.waiting()).toBe(2)
        yield* Deferred.succeed(free, undefined)
        yield* Fiber.join(holder)
        yield* Fiber.joinAll(waiters)

        expect(order).toEqual(["second", "third", "first again"])
      }),
    ))

  it("leaves no slot taken by a waiter interrupted while it queued", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const gate = fairGate(1)
        const free = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(
          Effect.scoped(Effect.andThen(gate.take, Deferred.await(free))),
        )
        yield* Effect.yieldNow

        const abandoned = yield* Effect.forkChild(Effect.scoped(gate.take))
        yield* Effect.yieldNow
        expect(gate.waiting()).toBe(1)
        yield* Fiber.interrupt(abandoned)
        expect(gate.waiting()).toBe(0)

        yield* Deferred.succeed(free, undefined)
        yield* Fiber.join(holder)

        const taken = yield* Effect.scoped(Effect.as(gate.take, "taken")).pipe(
          Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed("stuck") }),
        )
        expect(taken).toBe("taken")
      }),
    ))
})
