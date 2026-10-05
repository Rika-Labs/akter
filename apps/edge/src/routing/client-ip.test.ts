import { describe, expect, it } from "vitest"
import { clientIps, normalizeIp } from "./client-ip.ts"

const headers = (claimed?: string) =>
  new Headers(claimed === undefined ? {} : { "fly-client-ip": claimed })

describe("client address", () => {
  const resolve = clientIps({ flyProxy: true })

  it("takes the claimed address from Fly-Client-IP behind the Fly proxy gate, whatever the peer", () => {
    expect(resolve("fdaa:0:1::3", headers("198.51.100.7"))).toBe("198.51.100.7")
    expect(resolve("172.19.0.2", headers("2001:DB8::1"))).toBe("2001:db8::1")
    expect(resolve("203.0.113.5", headers("198.51.100.7"))).toBe("198.51.100.7")
  })

  it("keeps the peer when the claim is absent or not exactly one address", () => {
    for (const claim of [undefined, "", "unknown", "1.1.1.1, 2.2.2.2", "1.1.1.256", "fe80::1%eth0"])
      expect(resolve("fdaa:0:1::3", headers(claim))).toBe("fdaa:0:1::3")
  })

  it("collapses an IPv4-mapped address to IPv4 and writes IPv6 in lowercase", () => {
    expect(resolve("::ffff:10.0.3.9", headers("2001:DB8::1"))).toBe("2001:db8::1")
    expect(resolve("::ffff:203.0.113.5", headers())).toBe("203.0.113.5")
    expect(resolve("fdaa:0:1::3", headers("::ffff:198.51.100.7"))).toBe("198.51.100.7")
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4")
  })

  it("trusts no header unless the Fly proxy gate is set", () => {
    const open = clientIps({ flyProxy: false })

    expect(open("203.0.113.5", headers("198.51.100.7"))).toBe("203.0.113.5")
    expect(open("fdaa:0:1::3", headers("198.51.100.7"))).toBe("fdaa:0:1::3")
  })

  it("believes no forwarding header other than Fly-Client-IP, even behind the gate", () => {
    const spoofed = new Headers({
      "cf-connecting-ip": "198.51.100.7",
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.10",
      "true-client-ip": "203.0.113.11",
      forwarded: "for=203.0.113.12",
    })

    expect(resolve("fdaa:0:1::3", spoofed)).toBe("fdaa:0:1::3")
  })

  it("has no address for a peer that is not one", () => {
    expect(resolve(undefined, headers("198.51.100.7"))).toBeUndefined()
    expect(resolve("not-an-ip", headers("198.51.100.7"))).toBeUndefined()
  })
})
