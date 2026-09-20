import { describe, expect, it } from "vitest"
import type { ChangePosition } from "../../src/projection/change.js"

const position = {
  actorIncarnation: "incarnation-1",
  sequence: "42",
  transactionId: "transaction-1",
  ordinal: 0,
} satisfies ChangePosition

describe("projection position shape", () => {
  it("records actor incarnation and within-transaction ordinal", () => {
    expect(position.actorIncarnation).toBe("incarnation-1")
    expect(position.ordinal).toBe(0)
  })
})
