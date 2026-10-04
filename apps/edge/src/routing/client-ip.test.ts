import { describe, expect, it } from "vitest"
import { cidrs, clientIps, normalizeIp } from "./client-ip.ts"

const headers = (claimed?: string) =>
  new Headers(claimed === undefined ? {} : { "cf-connecting-ip": claimed })

describe("client address", () => {
  const resolve = clientIps({ nlbOnly: true, cloudflare: ["173.245.48.0/20", "2400:cb00::/32"] })

  it("takes the claimed address from a Cloudflare peer and from no other peer, a private NLB or VPC address included", () => {
    expect(resolve("173.245.55.1", headers("198.51.100.7"))).toBe("198.51.100.7")
    expect(resolve("2400:cb00::1", headers("198.51.100.7"))).toBe("198.51.100.7")
    expect(resolve("10.0.3.9", headers("198.51.100.7"))).toBe("10.0.3.9")
    expect(resolve("173.245.64.1", headers("198.51.100.7"))).toBe("173.245.64.1")
    expect(resolve("203.0.113.5", headers("198.51.100.7"))).toBe("203.0.113.5")
  })

  it("keeps the peer when a Cloudflare peer's claim is absent or not exactly one address", () => {
    for (const claim of [undefined, "", "unknown", "1.1.1.1, 2.2.2.2", "1.1.1.256", "fe80::1%eth0"])
      expect(resolve("173.245.55.1", headers(claim))).toBe("173.245.55.1")
  })

  it("compares an IPv4-mapped peer as its IPv4 address and writes IPv6 in lowercase", () => {
    expect(resolve("::ffff:173.245.55.1", headers("2001:DB8::1"))).toBe("2001:db8::1")
    expect(resolve("::ffff:203.0.113.5", headers("198.51.100.7"))).toBe("203.0.113.5")
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4")
  })

  it("trusts no header unless the NLB-only gate is set, whatever the ranges say", () => {
    const open = clientIps({ nlbOnly: false, cloudflare: ["173.245.48.0/20"] })

    expect(open("173.245.55.1", headers("198.51.100.7"))).toBe("173.245.55.1")
  })

  it("matches block edges on both sides and refuses a malformed block", () => {
    const inside = cidrs(["192.0.2.128/25", "2001:db8:1::/48"])

    expect(inside("192.0.2.128")).toBe(true)
    expect(inside("192.0.2.255")).toBe(true)
    expect(inside("192.0.2.127")).toBe(false)
    expect(inside("192.0.3.0")).toBe(false)
    expect(inside("2001:db8:1:ffff::1")).toBe(true)
    expect(inside("2001:db8:2::1")).toBe(false)
    expect(() => cidrs(["10.0.0.0/33"])).toThrow()
    expect(() => cidrs(["not-an-ip"])).toThrow()
  })
})
