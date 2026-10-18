import { describe, expect, it } from "vitest"

import { renderHeaders, renderRedirects } from "./cloudflare.ts"

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
  const text = renderHeaders(["/", "/quickstart"])
  const rules = text.trim().split("\n\n")

  it("caches hashed assets for a year and nothing else", () => {
    expect(rules.filter((rule) => rule.includes("immutable"))).toEqual([
      "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable",
    ])
  })

  it("revalidates pages and sets no cache header on the catch-all rule", () => {
    const catchAll = rules.find((rule) => rule.startsWith("/*\n"))

    expect(catchAll).toContain("X-Content-Type-Options: nosniff")
    expect(catchAll).not.toContain("Cache-Control")
    expect(rules).toContain("/quickstart\n  Cache-Control: public, max-age=0, must-revalidate")
    expect(rules).toContain("/\n  Cache-Control: public, max-age=0, must-revalidate")
  })

  it("declares the Markdown twins' content type", () => {
    expect(text).toContain("/*.md\n  Content-Type: text/markdown; charset=utf-8")
  })
})
