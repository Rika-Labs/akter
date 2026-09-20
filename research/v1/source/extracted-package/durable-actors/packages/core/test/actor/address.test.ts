import { describe, expect, it } from "vitest"
import type { ActorAddress } from "../../src/actor/address.js"

const address = {
  application: "example",
  environment: "test",
  actorType: "Todo",
  actorId: "todo-1",
  incarnation: "incarnation-1",
} satisfies ActorAddress

describe("address contract shape", () => {
  it("retains namespace and incarnation as separate fields", () => {
    expect(address.environment).toBe("test")
    expect(address.incarnation).toBe("incarnation-1")
  })
})
