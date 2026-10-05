import type { Drawing } from "@akter/ui/brand"
import { container, crane, quay, stack, water } from "@akter/ui/brand"

/** The landing page's port: two stacks, a gantry crane and the quay, over moving water. */
export const portScene: ReadonlyArray<Drawing> = [
  ...water({ width: 1080, y: 260, rows: 6 }),
  ...stack({ x: 30, ground: 230, columns: 4, tiers: 3, seed: 5 }),
  ...stack({ x: 760, ground: 230, columns: 4, tiers: 4, seed: 9 }),
  ...crane({ x: 390, ground: 230, height: 190, reach: 250, trolley: 120, id: "AKTU 000001 7" }),
  ...quay({ width: 1080, y: 230 }),
]

/** The footer's strip of single containers drifting on water. */
export const containerStrip: ReadonlyArray<Drawing> = (() => {
  const width = 1080
  const items: Array<Drawing> = [...water({ width, y: 112, rows: 4 })]
  let x = 10
  let index = 0
  while (x < width - 70) {
    items.push(...container({ x, y: 70 + (index % 2) * 4, length: 70, height: 30, depth: 16 }))
    x += 90 + (index % 3) * 18
    index += 1
  }
  return items
})()
