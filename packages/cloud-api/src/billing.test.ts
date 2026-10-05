import { Schema } from "effect"
import { describe, expect, it } from "vitest"

import { CardPaymentMethod, LinkPaymentMethod, PaymentMethod } from "./billing.ts"

const valid = Schema.is(PaymentMethod)

const visa = CardPaymentMethod.make({
  brand: "visa",
  lastFour: "4242",
  expiryMonth: 7,
  expiryYear: 2031,
})

describe("payment method", () => {
  it("is a card, named by brand, last four digits and expiry, or a Link account, named by its email", () => {
    expect(valid(visa)).toBe(true)
    expect(valid(LinkPaymentMethod.make({ email: "ada@example.com" }))).toBe(true)
  })

  it("accepts a Link account with no email, since Stripe reports none for some", () => {
    expect(valid(LinkPaymentMethod.make({ email: null }))).toBe(true)
  })

  it("rejects a method without its tag, a Link account with no email field, and a card whose expiry month is not a month", () => {
    expect(valid({ brand: "visa", lastFour: "4242", expiryMonth: 7, expiryYear: 2031 })).toBe(false)
    expect(valid({ ...LinkPaymentMethod.make({ email: null }), email: undefined })).toBe(false)
    expect(valid({ ...visa, expiryMonth: 13 })).toBe(false)
  })
})
