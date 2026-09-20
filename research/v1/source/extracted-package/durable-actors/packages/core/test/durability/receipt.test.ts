import { describe, expect, it } from "vitest"
import type { CommitReceipt } from "../../src/durability/receipt.js"

const receipt = {
  commandId: "command-1",
  actorRevision: "9007199254740993",
  outcome: "succeeded",
} satisfies CommitReceipt

describe("receipt wire shape", () => {
  it("keeps large revisions as strings instead of imprecise numbers", () => {
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt)
  })
})
