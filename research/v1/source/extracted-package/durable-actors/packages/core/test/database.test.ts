import { describe, expect, it } from "vitest"
import { Database } from "../src/database.js"

describe("Database service declaration", () => {
  it("exports a capability tag without a database implementation", () => {
    expect(typeof Database).toBe("function")
  })
})
