import { describe, expect, it } from "vitest"

import { fontFace } from "./font-stylesheet.ts"

const bytes = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 250, 251, 252])

describe("fontFace", () => {
  it("embeds exactly the font bytes, so one font file gives one stylesheet", () => {
    const css = fontFace({ family: "Inter", bytes, weight: "100 900" })
    const encoded = /base64,([^)]+)\)/.exec(css)?.[1] ?? ""

    expect(Uint8Array.from(Buffer.from(encoded, "base64"))).toEqual(bytes)
    expect(fontFace({ family: "Inter", bytes, weight: "100 900" })).toBe(css)
  })

  it("names the family and weights the layout asks for and requests no file", () => {
    const css = fontFace({ family: "Geist Mono", bytes, weight: "100 900" })

    expect(css).toContain('font-family:"Geist Mono"')
    expect(css).toContain("font-weight:100 900")
    expect(css).toContain("font-display:block")
    expect(css).not.toMatch(/url\((?!data:)/)
  })
})
