import { describe, expect, it } from "vitest"

import { estimatedSpans, railPath, thumbRange } from "./toc-rail.ts"

describe("estimatedSpans", () => {
  it("puts the text of each one-line entry a line and two gaps below the one before", () => {
    expect(estimatedSpans(3)).toEqual([
      { top: 0, bottom: 20 },
      { top: 32, bottom: 52 },
      { top: 64, bottom: 84 },
    ])
    expect(estimatedSpans(0)).toEqual([])
  })
})

describe("railPath", () => {
  const spans = estimatedSpans(4)

  it("runs one stroke beside the text of every entry, joined to the next", () => {
    expect(railPath(spans, [2, 2, 2, 2])).toBe(
      "M0.5 0 L0.5 20 L0.5 32 L0.5 52 L0.5 64 L0.5 84 L0.5 96 L0.5 116",
    )
  })

  it("moves the stroke 12 px right for a third-level entry and joins the two levels with a slant", () => {
    expect(railPath(spans, [2, 3, 3, 4])).toBe(
      "M0.5 0 L0.5 20 L12.5 32 L12.5 52 L12.5 64 L12.5 84 L12.5 96 L12.5 116",
    )
    expect(railPath(spans, [2, 3, 2, 2])).toContain("L12.5 52 L0.5 64")
  })

  it("draws nothing for a list with no entries", () => {
    expect(railPath([], [])).toBe("")
  })
})

describe("thumbRange", () => {
  const spans = estimatedSpans(5)

  it("covers the text of the first entry alone, 20 px, and not the space below it", () => {
    expect(thumbRange(spans, [true, false, false, false, false])).toEqual([0, 20])
  })

  it("covers every entry in view, from the top of the first to the bottom of the last", () => {
    expect(thumbRange(spans, [false, true, true, true, false])).toEqual([32, 116])
  })

  it("spans an entry between two in view even when the observer does not mark it", () => {
    expect(thumbRange(spans, [false, true, false, true, false])).toEqual([32, 116])
  })

  it("covers nothing when no entry is in view", () => {
    expect(thumbRange(spans, [false, false, false, false, false])).toEqual([0, 0])
    expect(thumbRange([], [])).toEqual([0, 0])
  })
})
