import { describe, expect, it } from "vitest"
import { layer } from "./layer.ts"

describe("Actors.layer executor settings", () => {
  it("rejects a cancelCheck under 1 second and accepts one of at least 1 second", () => {
    expect(() => layer({ executors: { cancelCheck: "500 millis" } })).toThrow(
      "executors.cancelCheck must be at least 1 second",
    )
    expect(() => layer({ executors: { cancelCheck: "1 second" } })).not.toThrow()
    expect(() => layer({ executors: { lease: "3 seconds" } })).not.toThrow()
  })

  it("caps cancelCheck at a third of the lease, so a short lease cannot fall under 1 second", () => {
    expect(() => layer({ executors: { lease: "3 seconds", cancelCheck: "1 hour" } })).not.toThrow()
    expect(() => layer({ executors: { lease: "2 seconds" } })).toThrow(
      "executors.lease must be at least 3 seconds",
    )
  })
})
