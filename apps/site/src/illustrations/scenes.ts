import type { Drawing } from "@akter/ui/brand"
import { crane, quay, stack, water } from "@akter/ui/brand"

/** The landing page's port: two stacks, a gantry crane and the quay, over moving water. */
export const portScene: ReadonlyArray<Drawing> = [
  ...water({ width: 1080, y: 260, rows: 6 }),
  ...stack({ x: 30, ground: 230, columns: 4, tiers: 3, seed: 5 }),
  ...stack({ x: 760, ground: 230, columns: 4, tiers: 4, seed: 9 }),
  ...crane({ x: 390, ground: 230, height: 190, reach: 250, trolley: 120, id: "AKTU 000001 7" }),
  ...quay({ width: 1080, y: 230 }),
]
