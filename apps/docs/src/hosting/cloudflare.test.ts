import { describe, expect, it } from "vitest"

import { contentSecurityPolicy, renderHeaders, renderRedirects } from "./cloudflare.ts"

describe("renderRedirects", () => {
  it("writes one source, destination and status per line", () => {
    expect(
      renderRedirects([
        { source: "/a", destination: "/b", status: 301 },
        { source: "/x/*", destination: "https://e.dev/:splat.md", status: 302 },
      ]),
    ).toBe("/a /b 301\n/x/* https://e.dev/:splat.md 302\n")
  })
})

describe("renderHeaders", () => {
  const text = renderHeaders({ pagePaths: ["/", "/quickstart"] })
  const rules = text.trim().split("\n\n")
  const catchAll = rules.find((rule) => rule.startsWith("/*\n")) ?? ""

  it("caches hashed assets for a year and nothing else", () => {
    expect(rules.filter((rule) => rule.includes("immutable"))).toEqual([
      "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable",
    ])
  })

  it("revalidates pages and sets no cache header on the catch-all rule", () => {
    expect(catchAll).not.toContain("Cache-Control")
    expect(rules).toContain("/quickstart\n  Cache-Control: public, max-age=0, must-revalidate")
    expect(rules).toContain("/\n  Cache-Control: public, max-age=0, must-revalidate")
  })

  it("declares the Markdown twins' content type", () => {
    expect(text).toContain("/*.md\n  Content-Type: text/markdown; charset=utf-8")
  })

  it("puts every security header Akter's other websites send on every response", () => {
    expect(catchAll).toContain("Strict-Transport-Security: max-age=63072000; includeSubDomains")
    expect(catchAll).toContain("X-Content-Type-Options: nosniff")
    expect(catchAll).toContain("X-Frame-Options: DENY")
    expect(catchAll).toContain("Referrer-Policy: no-referrer")
    expect(catchAll).toContain(
      "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    )
    expect(catchAll).toContain("Content-Security-Policy: default-src 'none'; ")
  })

  it("states each security header once, so Cloudflare never joins two policies", () => {
    const names = text
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(":")[0])

    for (const name of [
      "Strict-Transport-Security",
      "Content-Security-Policy",
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Frame-Options",
    ])
      expect(
        names.filter((candidate) => candidate === name),
        name,
      ).toHaveLength(1)
  })

  it("keeps every header line under Cloudflare's 2,000 character limit", () => {
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(2000)
  })
})

describe("contentSecurityPolicy", () => {
  const directive = (policy: string, name: string) =>
    policy.split("; ").find((candidate) => candidate.startsWith(`${name} `))

  it("keeps every request on the page's own origin; the fonts are data URLs in the stylesheet", () => {
    const policy = contentSecurityPolicy()

    expect(directive(policy, "font-src")).toBe("font-src 'self' data:")
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'")
    expect(directive(policy, "default-src")).toBe("default-src 'none'")
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'")
    expect(directive(policy, "object-src")).toBe("object-src 'none'")
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'")
  })

  it("allows inline scripts, because the export's data and bootstrap are inline scripts", () => {
    expect(directive(contentSecurityPolicy(), "script-src")).toBe(
      "script-src 'self' 'unsafe-inline'",
    )
  })
})
