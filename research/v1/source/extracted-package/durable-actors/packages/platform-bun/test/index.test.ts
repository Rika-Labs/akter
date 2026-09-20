import { describe, expect, it } from "vitest"
import * as publicApi from "../src/index.js"

describe("setup-only package surface", () => {
  it("loads as an ESM namespace without starting a runtime", () => {
    expect(typeof publicApi).toBe("object")
  })
})
