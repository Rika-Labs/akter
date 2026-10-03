import { describe, expect, it } from "vitest"
import { selectAccount } from "./config.ts"

describe("stage account selection", () => {
  const accounts = { dev: "111111111111", staging: "222222222222", prod: "333333333333" }
  it("selects the explicit account instead of falling back to production", () => {
    expect(selectAccount({ stage: "dev", accounts })).toBe("111111111111")
    expect(selectAccount({ stage: "staging", accounts })).toBe("222222222222")
    expect(selectAccount({ stage: "prod", accounts })).toBe("333333333333")
  })
  it("rejects shared accounts and malformed IDs before provider calls", () => {
    expect(() =>
      selectAccount({ stage: "dev", accounts: { ...accounts, dev: accounts.prod } }),
    ).toThrow("separate")
    expect(() =>
      selectAccount({ stage: "prod", accounts: { ...accounts, staging: "invalid" } }),
    ).toThrow("12 digits")
  })
})
