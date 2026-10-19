import { describe, expect, it } from "vitest"

import { searchSections } from "./search-sections.ts"

const page = {
  url: "/guides/deploy",
  toc: [
    { url: "#build", depth: 2 },
    { url: "#target", depth: 3 },
    { url: "#region", depth: 3 },
    { url: "#run", depth: 2 },
    { url: "#logs", depth: 3 },
  ],
  structuredData: {
    headings: [
      { id: "build", content: "Build" },
      { id: "target", content: "Target" },
      { id: "region", content: "Region" },
      { id: "run", content: "Run" },
      { id: "logs", content: "Logs" },
    ],
    contents: [
      { heading: undefined, content: "How to ship." },
      { heading: "target", content: "Pick one." },
      { heading: "target", content: "Then confirm." },
      { heading: "run", content: "Start it." },
      { heading: "logs", content: "Read them." },
    ],
  },
}

describe("searchSections", () => {
  const sections = searchSections([page])

  it("names the heading above each section by the outline, not by the previous heading", () => {
    expect(sections["/guides/deploy#build"]?.parent).toBeUndefined()
    expect(sections["/guides/deploy#target"]?.parent).toBe("Build")
    expect(sections["/guides/deploy#region"]?.parent).toBe("Build")
    expect(sections["/guides/deploy#run"]?.parent).toBeUndefined()
    expect(sections["/guides/deploy#logs"]?.parent).toBe("Run")
  })

  it("keeps the first paragraph under a heading and none for a heading without text", () => {
    expect(sections["/guides/deploy#target"]?.text).toBe("Pick one.")
    expect(sections["/guides/deploy#build"]?.text).toBeUndefined()
    expect(sections["/guides/deploy#run"]?.text).toBe("Start it.")
  })

  it("keys each section by the page address and the heading's anchor", () => {
    expect(Object.keys(sections)).toEqual([
      "/guides/deploy#build",
      "/guides/deploy#target",
      "/guides/deploy#region",
      "/guides/deploy#run",
      "/guides/deploy#logs",
    ])
    expect(sections["/guides/deploy#region"]?.title).toBe("Region")
  })
})
