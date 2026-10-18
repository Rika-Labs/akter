import { describe, expect, it } from "vitest"

import { isWoff2, polySansStylesheet } from "./polysans-stylesheet.ts"

const font = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 250, 251, 252])

describe("isWoff2", () => {
  it("accepts the WOFF2 signature and rejects an error page or a truncated body", () => {
    expect(isWoff2(font)).toBe(true)
    expect(isWoff2(new TextEncoder().encode("<!doctype html>"))).toBe(false)
    expect(isWoff2(Uint8Array.from([0x77, 0x4f]))).toBe(false)
  })
})

describe("polySansStylesheet", () => {
  it("embeds exactly the font bytes, so a given font file gives one stylesheet", () => {
    const css = polySansStylesheet(font)
    const encoded = /base64,([^)]+)\)/.exec(css)?.[1] ?? ""

    expect(Uint8Array.from(Buffer.from(encoded, "base64"))).toEqual(font)
    expect(polySansStylesheet(font)).toBe(css)
  })

  it("keeps the family, weights and optional display the layout depends on", () => {
    const css = polySansStylesheet(font)

    expect(css).toContain('font-family:"PolySans Var"')
    expect(css).toContain("font-weight:300 800")
    expect(css).toContain("font-display:optional")
  })
})
