import { describe, expect, it } from "bun:test"
import { Database } from "../../packages/core/dist/index.js"

describe("Bun emitted-package smoke", () => {
  it("loads the compiled core service tag", () => {
    expect(typeof Database).toBe("function")
  })
})
