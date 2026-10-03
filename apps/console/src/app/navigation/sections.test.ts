import { describe, expect, it } from "vitest"
import { searchSettings, settingsGroups } from "./sections.ts"

const labels = (query: string) =>
  searchSettings(query).map((group) => [
    group.title ?? "Account",
    group.items.map((item) => item.label),
  ])

describe("searchSettings", () => {
  it("keeps every group in order for an empty query", () => {
    expect(searchSettings("  ")).toBe(settingsGroups)
  })

  it("matches pages by keyword, not only by label, and drops empty groups", () => {
    expect(labels("stripe")).toEqual([["Organization", ["Billing"]]])
    expect(labels("THEME")).toEqual([["Account", ["Appearance"]]])
  })

  it("matches a group title so 'project' finds every project page", () => {
    expect(labels("project")).toEqual([
      ["Project", ["Environment", "Regions", "Domains", "API keys", "Integrations"]],
    ])
  })
})
