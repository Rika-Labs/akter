import { describe, expect, it } from "vitest"
import { lifecycleLayout } from "./lifecycle.ts"

describe("lifecycleLayout", () => {
  for (const orientation of ["horizontal", "vertical"] as const)
    it(`draws the transaction around fence to commit only (${orientation})`, () => {
      const layout = lifecycleLayout(orientation)
      const region = layout.regions[0]
      expect(region).toBeDefined()
      if (region === undefined) return
      const inside = (id: string) => {
        const node = layout.nodes.find((candidate) => candidate.id === id)
        if (node === undefined) return false
        return (
          node.x >= region.x &&
          node.y >= region.y &&
          node.x + node.width <= region.x + region.width &&
          node.y + node.height <= region.y + region.height
        )
      }
      expect(["fence", "receipt", "handler", "commit"].every(inside)).toBe(true)
      expect(inside("command")).toBe(false)
      expect(inside("reply")).toBe(false)
      expect(inside("outbox")).toBe(false)
    })

  it("keeps every stage inside the drawing and the outbox released after the commit", () => {
    const layout = lifecycleLayout("horizontal")
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
      expect(node.y + node.height).toBeLessThanOrEqual(layout.height)
    }
    const commit = layout.nodes.find((node) => node.id === "commit")
    const outbox = layout.nodes.find((node) => node.id === "outbox")
    expect(outbox?.y).toBeGreaterThan((commit?.y ?? 0) + (commit?.height ?? 0))
    expect(layout.edges.find((edge) => edge.id === "commit-outbox")?.dashed).toBe(true)
    expect(layout.edges.find((edge) => edge.id === "handler-commit")?.dashed).toBe(false)
  })
})
