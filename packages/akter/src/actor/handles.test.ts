import { it } from "@effect/vitest"
import { Clock, Effect, Exit, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { expect, expectTypeOf } from "vitest"
import { RecordedExit } from "../contexts/workflow.ts"
import type { ActorError } from "../errors/actor.ts"
import { workflowRun } from "../handles/run.ts"
import { Actor } from "../index.ts"
import type { WorkflowStatus } from "../runtime/members.ts"

it.effect("waits between unknown and suspended workflow polls until the recorded exit", () =>
  Effect.gen(function* () {
    const Ship = Actor.workflow("Ship", { success: Schema.String })
    const recorded = RecordedExit.cases.Success.make({ value: "shipped" })
    const statuses: ReadonlyArray<WorkflowStatus | undefined> = [
      undefined,
      { finished: false, result: undefined },
      { finished: true, result: recorded },
    ]
    const times: Array<number> = []
    const start = yield* Clock.currentTimeMillis

    const run = workflowRun<typeof Ship>({
      executionId: "ship-1",
      poll: Effect.gen(function* () {
        const next = statuses[times.length]
        times.push((yield* Clock.currentTimeMillis) - start)

        return next
      }),
      decode: (exit) => {
        expect(exit).toEqual(recorded)

        return Effect.succeed(Exit.succeed("shipped"))
      },
      interrupt: Effect.void,
    })

    expectTypeOf<Effect.Error<typeof run.result>>().toEqualTypeOf<ActorError>()
    const result = yield* Effect.forkChild(run.result)
    yield* TestClock.adjust(0)
    expect(times).toEqual([0])
    yield* TestClock.adjust(99)
    expect(times).toEqual([0])
    yield* TestClock.adjust(1)
    expect(times).toEqual([0, 100])
    yield* TestClock.adjust(99)
    expect(times).toEqual([0, 100])
    yield* TestClock.adjust(1)
    expect(yield* Fiber.join(result)).toBe("shipped")
    expect(times).toEqual([0, 100, 200])
  }),
)
