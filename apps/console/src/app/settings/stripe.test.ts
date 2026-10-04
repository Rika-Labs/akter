import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { hostedPageUrl } from "./stripe.ts"

const production = { origin: "https://app.akter.dev", standIn: false }
const development = { origin: "http://localhost:5173", standIn: true }

describe("hostedPageUrl", () => {
  it("opens https pages on Stripe's own hosts", () => {
    for (const url of [
      "https://checkout.stripe.com/c/pay/cs_live_a1",
      "https://billing.stripe.com/p/session/bps_1",
      "https://invoice.stripe.com/i/acct_1/inv_1",
      "https://pay.stripe.com/invoice/acct_1/inv_1/pdf",
    ])
      expect(hostedPageUrl(url, production)).toEqual(Option.some(url))
  })

  it("refuses scripts, plain http, lookalike hosts, ports and credentials", () => {
    for (const url of [
      "javascript:alert(document.cookie)",
      "http://checkout.stripe.com/c/pay/cs_1",
      "https://checkout.stripe.com.evil.dev/c/pay/cs_1",
      "https://evil.dev/checkout.stripe.com",
      "https://checkout.stripe.com:8443/c/pay/cs_1",
      "https://user:secret@billing.stripe.com/p/session/bps_1",
      "/billing/portal/bps_local_1",
      "not a url",
    ])
      expect(hostedPageUrl(url, development)).toEqual(Option.none())
  })

  it("opens the local stand-in only on the console's own origin where it runs", () => {
    const portal = "http://localhost:5173/billing/portal/bps_local_8eae460a34334c0db366d91f16cf949d"
    const checkout =
      "http://localhost:5173/billing/checkout/cs_local_f1f3d0a70c45469fbba67f68acc8fa4b"
    expect(hostedPageUrl(portal, development)).toEqual(Option.some(portal))
    expect(hostedPageUrl(checkout, development)).toEqual(Option.some(checkout))
    expect(hostedPageUrl(portal, { ...development, standIn: false })).toEqual(Option.none())
    expect(hostedPageUrl("http://localhost:3001/billing/portal/bps_local_1", development)).toEqual(
      Option.none(),
    )
    expect(hostedPageUrl("https://app.akter.dev/billing/portal/bps_local_1", production)).toEqual(
      Option.none(),
    )
    expect(
      hostedPageUrl("http://localhost:5173/settings/billing?next=javascript:x", development),
    ).toEqual(Option.none())
  })

  it("links the stand-in's invoice PDFs only where it runs, and only its PDF path", () => {
    const pdf = "http://localhost:5173/billing/invoices/in_local_7a3f9c2e1b/pdf"
    expect(hostedPageUrl(pdf, development)).toEqual(Option.some(pdf))
    expect(hostedPageUrl(pdf, { ...development, standIn: false })).toEqual(Option.none())
    expect(
      hostedPageUrl("https://app.akter.dev/billing/invoices/in_local_7a3f9c2e1b/pdf", production),
    ).toEqual(Option.none())
    for (const path of [
      "/billing/invoices/in_local_1",
      "/billing/invoices/in_local_1/pdf/extra",
      "/billing/invoices/../portal/bps_1/pdf",
      "/billing/invoices/in%2Flocal/pdf",
    ])
      expect(hostedPageUrl(`http://localhost:5173${path}`, development)).toEqual(Option.none())
    expect(
      hostedPageUrl("http://localhost:5173/billing/portal/bps_local_1?redirect=x", development),
    ).toEqual(Option.none())
  })
})
