import { Duration, Option } from "effect"
import { describe, expect, it } from "vitest"
import { ActorError, ActorUnavailable, RunnerAtCapacity } from "../errors/actor.ts"
import { retryDelay } from "./retry.ts"

const waits = (error: ActorError) =>
  [0, 1, 2, 3].map((attempt) => Duration.toMillis(retryDelay(error, attempt)))

describe("retryDelay", () => {
  it("waits at least retryAfter before retrying RunnerAtCapacity in process", () => {
    const error = ActorError.make({ reason: RunnerAtCapacity.make({}) })
    const retryAfter = Option.getOrThrow(error.retryAfter)

    expect(retryAfter).toBeGreaterThanOrEqual(500)
    expect(waits(error)).toEqual([retryAfter, retryAfter, retryAfter, retryAfter])
  })

  it("starts ActorUnavailable from its retryAfter and doubles up to 500 ms", () => {
    const error = ActorError.make({ reason: ActorUnavailable.make({ cause: new Error("lost") }) })
    const retryAfter = Option.getOrThrow(error.retryAfter)

    expect(retryAfter).toBeGreaterThanOrEqual(125)
    expect(retryAfter).toBeLessThanOrEqual(375)
    expect(waits(error)).toEqual([retryAfter, Math.min(retryAfter * 2, 500), 500, 500])
  })
})
