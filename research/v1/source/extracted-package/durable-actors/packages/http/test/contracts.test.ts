import { describe, expect, it } from "vitest"
import * as contracts from "../src/contracts.js"

describe("contract-only module", () => {
  it("has no executable runtime exports", () => {
    expect(Object.keys(contracts)).toEqual([])
  })
})
