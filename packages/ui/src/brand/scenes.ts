import type { Drawing, Figure } from "./figure.ts"
import { container, crane, quay, stack, water } from "./port.ts"

/** A drawing and the coordinate space it was drawn in. */
export interface Scene {
  readonly viewBox: string
  readonly drawing: ReadonlyArray<Drawing>
}

/** A low row of containers moored above slow water: the quiet strip under sign-in forms. */
export const mooredRow = (count: number): Scene => {
  const drawing: Array<Drawing> = [...water({ width: 520, y: 100, rows: 4 })]
  for (let index = 0; index < count; index++)
    drawing.push({
      className: "bob",
      children: container({
        x: index * 74,
        y: 58 + (index % 2) * 4,
        length: 56,
        height: 26,
        depth: 14,
      }),
    })
  return { viewBox: "0 0 520 128", drawing }
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

/** A yard of stacked containers beside a working crane, for sign-up and onboarding. */
export const workingYard: Scene = {
  viewBox: "0 0 520 260",
  drawing: [
    ...water({ width: 520, y: 228, rows: 5 }),
    ...stack({
      x: 10,
      ground: 206,
      columns: 2,
      tiers: 3,
      seed: 71,
      length: 60,
      height: 26,
      depth: 15,
    }),
    ...crane({ x: 210, ground: 206, height: 170, reach: 170, trolley: 90 }),
    ...quay({ width: 520, y: 206, height: 20 }),
  ],
}

const envelope: ReadonlyArray<Figure> = [
  {
    tag: "rect",
    attributes: { x: 62, y: 20, width: 46, height: 32 },
    fill: "face",
    stroke: "ink",
    strokeWidth: 1,
  },
  {
    tag: "polyline",
    attributes: { points: "62,20 85,37 108,20" },
    fill: "none",
    stroke: "ink",
    strokeWidth: 1,
  },
]

/** A container with a letter resting on it, for checking your inbox. */
export const letterOnContainer: Scene = {
  viewBox: "0 0 200 120",
  drawing: [
    ...container({ x: 30, y: 54, length: 110, height: 52, depth: 30 }),
    { className: "bob", children: envelope },
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
