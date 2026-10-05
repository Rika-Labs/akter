import type { Drawing } from "./figure.ts"
import { container, crane, quay, water } from "./port.ts"

/** A drawing and the coordinate space it was drawn in. */
export interface Scene {
  readonly viewBox: string
  readonly drawing: ReadonlyArray<Drawing>
}

/** An empty quay with a crane holding the first container: a project waiting for its first deploy. */
export const waitingQuay: Scene = {
  viewBox: "0 0 360 300",
  drawing: [
    ...water({ width: 360, y: 262, rows: 4 }),
    ...crane({ x: 120, ground: 240, height: 190, reach: 150, trolley: 60, id: "AKTU 000001 7" }),
    ...quay({ width: 360, y: 240, height: 20 }),
  ],
}

/** One container adrift on open water: the page that is not here. */
export const adrift: Scene = {
  viewBox: "0 0 360 190",
  drawing: [
    ...water({ width: 360, y: 150, rows: 5 }),
    {
      className: "bob",
      children: container({
        x: 120,
        y: 102,
        length: 96,
        height: 40,
        depth: 22,
        id: "AKTU 000404 4",
      }),
    },
  ],
}

/**
 * The footer strip: single containers moored side by side on slow water, spaced unevenly so the
 * row does not read as a pattern. Its viewBox crops to the drawing's own height.
 */
export const containerStrip: Scene = (() => {
  const width = 1080
  const drawing: Array<Drawing> = [...water({ width, y: 112, rows: 4 })]
  let x = 10
  let index = 0
  while (x < width - 70) {
    drawing.push(...container({ x, y: 70 + (index % 2) * 4, length: 70, height: 30, depth: 16 }))
    x += 90 + (index % 3) * 18
    index += 1
  }
  return { viewBox: "0 0 1080 140", drawing }
})()
